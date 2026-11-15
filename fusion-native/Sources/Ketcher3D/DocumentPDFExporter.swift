import AppKit
import CoreGraphics
import WebKit

/// Renders one bounded SVG per WKWebView navigation. The output has vector PDF
/// pages at the requested physical dimensions, independent of display zoom.
final class DocumentPDFExporter: NSObject, WKNavigationDelegate {
    struct Page {
        let id: String
        let widthPt: Double
        let heightPt: Double
        let svg: String
    }
    private struct ExportError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    private var renderer: WKWebView?
    private var window: NSWindow?
    private var activeNavigation: WKNavigation?
    private var pages: [Page] = []
    private var captured: [Data] = []
    private var geometry: [SourcePageGeometry] = []
    private var index = 0
    private var serial = 0
    private var valid: (() -> Bool)?
    private var completion: ((Result<Data, Error>) -> Void)?
    private let maxPages = 100
    private let maxInputBytes = 96 * 1024 * 1024
    private let maxOutputBytes = 128 * 1024 * 1024

    /// Caller owns the exporter until completion. All calls and callbacks occur on main.
    func export(pages: [Page], isValid: @escaping () -> Bool,
                completion: @escaping (Result<Data, Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard self.completion == nil else {
            completion(.failure(ExportError(message: "已有 PDF 导出正在进行。"))); return
        }
        guard !pages.isEmpty, pages.count <= maxPages else {
            completion(.failure(ExportError(message: "PDF 页面数无效或超过 100 页。"))); return
        }
        var total = 0
        var ids = Set<String>()
        for page in pages {
            total += page.svg.utf8.count
            guard !page.id.isEmpty, page.id.count <= 160, ids.insert(page.id).inserted,
                  page.widthPt.isFinite, page.heightPt.isFinite,
                  (72...2000).contains(page.widthPt), (72...2000).contains(page.heightPt),
                  !page.svg.isEmpty, total <= maxInputBytes else {
                completion(.failure(ExportError(message: "PDF 页面数据无效或超过大小限制。"))); return
            }
        }
        guard isValid() else { completion(.failure(ExportError(message: "画布已变化，导出已取消。"))); return }
        self.pages = pages; self.valid = isValid; self.completion = completion
        captured = []; geometry = []; index = 0; serial += 1
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        renderer = web
        // WebKit requires an attached, ordered view to complete reliable PDF capture.
        // Keep the auxiliary window off-screen and never make it key.
        let host = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 800, height: 1100),
                            styleMask: [.borderless], backing: .buffered, defer: false)
        host.isReleasedWhenClosed = false
        host.contentView = web
        host.orderBack(nil)
        window = host
        loadCurrentPage()
    }

    private func current() -> Bool { completion != nil && (valid?() ?? false) }
    private func loadCurrentPage() {
        guard current() else { return finish(.failure(ExportError(message: "画布已变化，导出已取消。"))) }
        guard let web = renderer else { return finish(.failure(ExportError(message: "PDF 渲染器不可用。"))) }
        if index == pages.count { return merge() }
        let page = pages[index]
        // CSS pixels are mapped to physical points when the captured vector page is merged.
        let width = page.widthPt * 4 / 3, height = page.heightPt * 4 / 3
        web.frame = NSRect(x: 0, y: 0, width: width, height: height)
        window?.setContentSize(NSSize(width: width, height: height))
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'">
        <style>html,body { margin:0; padding:0; width:\(width)px; height:\(height)px; overflow:hidden; background:white; } body > svg { display:block; width:100%; height:100%; }</style>
        </head><body>\(page.svg)</body></html>
        """
        serial += 1
        let token = serial
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.completion != nil, self.serial == token else { return }
            self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页 PDF 渲染超时。")))
        }
        activeNavigation = web.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === renderer, navigation === activeNavigation, completion != nil else { return }
        guard current() else { return finish(.failure(ExportError(message: "画布已变化，导出已取消。"))) }
        let token = serial
        let script = documentPDFGeometryJS + #"""
        await Promise.race([(async () => {
          if (document.querySelectorAll('body > svg').length !== 1) throw new Error('Invalid SVG page');
          await document.fonts.ready;
          await Promise.all(Array.from(document.images, image => image.decode()));
          const images = Array.from(document.querySelectorAll('svg image'));
          await Promise.all(images.map(async node => {
            const src = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
            if (!src.startsWith('data:image/')) throw new Error('External or missing image');
            const image = new Image(); image.src = src; await image.decode();
          }));
          await Promise.race([new Promise(requestAnimationFrame), new Promise(resolve => setTimeout(resolve, 250))]);
          await Promise.race([new Promise(requestAnimationFrame), new Promise(resolve => setTimeout(resolve, 250))]);
        })(), new Promise((_, reject) => setTimeout(() => reject(new Error('Page resources timed out')), 20000))]);
        const root = document.querySelector('body > svg');
        // The collector handles SVG text and nested SVG images. Do not pretend
        // that HTML foreignObject text has been measured as SVG text.
        if (Array.from(root.querySelectorAll('foreignObject')).some(e => /[\u2e80-\u9fff\uf900-\ufaff]/u.test(e.textContent || ''))) throw new Error('Unsupported foreignObject text geometry');
        return await collectGlyphGeometry(root);
        """#
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self, weak webView] result in
            guard let self, let webView, self.renderer === webView, self.serial == token, self.completion != nil else { return }
            guard self.current() else { return self.finish(.failure(ExportError(message: "画布已变化，导出已取消。"))) }
            switch result {
            case .failure(let error): self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页资源加载失败：\(error.localizedDescription)")))
            case .success(let value):
                guard let rows = value as? [[String: Any]], rows.count <= 100000 else {
                    return self.finish(.failure(ExportError(message: "无法读取第 \(self.index + 1) 页文字位置。")))
                }
                var glyphs: [SourceGlyphGeometry] = []
                for row in rows {
                    guard let character = row["character"] as? String,
                          let x = row["x"] as? Double, let y = row["y"] as? Double,
                          let width = row["width"] as? Double, let height = row["height"] as? Double,
                          [x, y, width, height].allSatisfy({ $0.isFinite }),
                          width >= 0, height >= 0, character.unicodeScalars.count == 1 else {
                        return self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页文字位置无效。")))
                    }
                    let bx = row["baselineX"] as? Double, by = row["baselineY"] as? Double
                    guard (bx == nil && by == nil) || (bx?.isFinite == true && by?.isFinite == true) else {
                        return self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页文字基线无效。")))
                    }
                    glyphs.append(SourceGlyphGeometry(character: character, x: x, y: y, width: width, height: height,
                                                       baselineX: bx, baselineY: by, orderedPaint: row["orderedPaint"] as? Bool ?? false))
                }
                let page = self.pages[self.index]
                self.geometry.append(SourcePageGeometry(width: page.widthPt * 4 / 3, height: page.heightPt * 4 / 3, glyphs: glyphs))
                let config = WKPDFConfiguration()
                config.rect = CGRect(x: 0, y: 0, width: page.widthPt * 4 / 3, height: page.heightPt * 4 / 3)
                webView.createPDF(configuration: config) { [weak self, weak webView] result in
                    guard let self, let webView, self.renderer === webView, self.serial == token, self.completion != nil else { return }
                    guard self.current() else { return self.finish(.failure(ExportError(message: "画布已变化，导出已取消。"))) }
                    switch result {
                    case .failure(let error): self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页 PDF 生成失败：\(error.localizedDescription)")))
                    case .success(let data):
                        guard data.count <= self.maxOutputBytes,
                              self.captured.reduce(data.count, { $0 + $1.count }) <= self.maxOutputBytes,
                              let provider = CGDataProvider(data: data as CFData),
                              let pdf = CGPDFDocument(provider), pdf.numberOfPages == 1 else {
                            return self.finish(.failure(ExportError(message: "第 \(self.index + 1) 页 PDF 无效或超过大小限制。")))
                        }
                        self.captured.append(data); self.index += 1; self.loadCurrentPage()
                    }
                }
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(webView, navigation, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(webView, navigation, error) }
    private func navigationFailed(_ webView: WKWebView, _ navigation: WKNavigation?, _ error: Error) {
        guard webView === renderer, navigation === activeNavigation, completion != nil else { return }
        finish(.failure(ExportError(message: "第 \(index + 1) 页加载失败：\(error.localizedDescription)")))
    }
    private func merge() {
        guard current() else { return finish(.failure(ExportError(message: "画布已变化，导出已取消。"))) }
        let output = NSMutableData()
        guard let consumer = CGDataConsumer(data: output as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: nil, nil) else {
            return finish(.failure(ExportError(message: "无法创建 PDF 文件。")))
        }
        for (offset, data) in captured.enumerated() {
            guard let provider = CGDataProvider(data: data as CFData),
                  let pdf = CGPDFDocument(provider), let page = pdf.page(at: 1) else {
                context.closePDF(); return finish(.failure(ExportError(message: "无法合并第 \(offset + 1) 页。")))
            }
            var box = CGRect(x: 0, y: 0, width: pages[offset].widthPt, height: pages[offset].heightPt)
            let boxData = Data(bytes: &box, count: MemoryLayout<CGRect>.size)
            context.beginPDFPage([kCGPDFContextMediaBox as String: boxData] as CFDictionary)
            context.saveGState()
            context.concatenate(page.getDrawingTransform(.mediaBox, rect: box, rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
            context.restoreGState(); context.endPDFPage()
        }
        context.closePDF()
        guard output.length <= maxOutputBytes else { return finish(.failure(ExportError(message: "合并后的 PDF 超过大小限制。"))) }
        do {
            let raw = output as Data
            let source = geometry.flatMap(\.glyphs).map(\.character).joined()
            let corrected: Data
            do {
                corrected = try repairPDFTextMappings(raw, source: source).0
            } catch let error as NSError where error.domain == "PrototypePDF" && error.code == 8 {
                let assignments = try resolvePDFAmbiguities(raw, source: source, geometry: geometry)
                guard !assignments.isEmpty else { throw ExportError(message: "无法确认文字的准确编码。") }
                let normalized = try repairPDFTextMappings(raw, source: source, allowAmbiguous: true).0
                corrected = try patchPDFResources(normalized, assignments: assignments)
            }
            guard corrected.count <= maxOutputBytes else { throw ExportError(message: "修复后的 PDF 超过大小限制。") }
            finish(.success(corrected))
        } catch {
            finish(.failure(ExportError(message: "PDF 文字编码无法安全确认：\(error.localizedDescription)")))
        }
    }
    private func finish(_ result: Result<Data, Error>) {
        guard let done = completion else { return }
        serial += 1; completion = nil; valid = nil
        renderer?.stopLoading(); renderer?.navigationDelegate = nil; activeNavigation = nil
        window?.orderOut(nil); window?.close(); window = nil; renderer = nil
        pages = []; captured = []; geometry = []; index = 0
        done(result)
    }
}
