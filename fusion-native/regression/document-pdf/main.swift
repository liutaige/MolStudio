import AppKit
import PDFKit
import Foundation

// Standalone real WKWebView probe for MolStudio's canvas/native PDF exporter.
let outputDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/private/tmp/molstudio-document-pdf", isDirectory: true)
try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let exporter = DocumentPDFExporter()
let svg1 = #"""
<svg xmlns="http://www.w3.org/2000/svg" width="595.28" height="841.89" viewBox="0 0 595.28 841.89"><rect width="595.28" height="841.89" fill="white"/><text x="56" y="100" font-size="24" font-family="sans-serif">Hello 中文测试 H₂O</text><line x1="60" y1="160" x2="190" y2="160" stroke="black" stroke-width="2"/><text x="80" y="200" font-size="20">C=O</text><image x="70" y="220" width="60" height="60" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg=="/><text x="60" y="320" font-size="24">文⽂页⻚</text><text x="60" y="370" font-size="24">文</text><text x="60" y="370" font-size="24">⽂</text></svg>
"""#
let svg2 = #"""
<svg xmlns="http://www.w3.org/2000/svg" width="792" height="612" viewBox="0 0 792 612"><rect width="792" height="612" fill="white"/><text x="56" y="100" font-size="24" font-family="sans-serif">Second page 化学文档</text><path d="M50 150 L200 150 L190 145 M200 150 L190 155" fill="none" stroke="black" stroke-width="2"/></svg>
"""#
let canvasJSONPath = ProcessInfo.processInfo.environment["MOLSTUDIO_PDF_PAGES_JSON"]
let canvasInput = canvasJSONPath != nil
let pages: [DocumentPDFExporter.Page]
if let canvasJSONPath {
    let data = try Data(contentsOf: URL(fileURLWithPath: canvasJSONPath))
    guard data.count <= 100 * 1024 * 1024,
          let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["ok"] as? Bool == true,
          let entries = json["pages"] as? [[String: Any]], !entries.isEmpty, entries.count <= 100 else {
        fatalError("Canvas exportPages JSON is invalid or exceeds the test limit")
    }
    pages = try entries.map { entry in
        guard let id = entry["id"] as? String, let width = entry["widthPt"] as? Double,
              let height = entry["heightPt"] as? Double, let svg = entry["svg"] as? String else {
            throw NSError(domain: "DocumentPDFProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Incomplete canvas page"])
        }
        return DocumentPDFExporter.Page(id: id, widthPt: width, heightPt: height, svg: svg)
    }
} else {
    pages = [DocumentPDFExporter.Page(id: "p1", widthPt: 595.28, heightPt: 841.89, svg: svg1),
             DocumentPDFExporter.Page(id: "p2", widthPt: 792, heightPt: 612, svg: svg2)]
}
var report: [String: Any] = ["application": "MolStudio canvas", "page": "fusion/canvas.html",
    "build": ProcessInfo.processInfo.environment["MOLSTUDIO_TEST_BUILD"] ?? "native DocumentPDFExporter standalone WKWebView",
    "fixture": canvasInput ? "actual canvas exportPages JSON" : "synthetic SVG fixture", "checks": [String: Bool]()]
if let canvasJSONPath { report["pagesJSON"] = canvasJSONPath }
var checks: [String: Bool] = [:]
var errors: [String] = []
func saveReport() {
    report["checks"] = checks; report["errors"] = errors
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: outputDir.appendingPathComponent("report.json"), options: .atomic)
    }
}
func finish() {
    saveReport()
    print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    exit(checks.values.allSatisfy { $0 } && errors.isEmpty ? 0 : 1)
}
func pageHasInk(_ page: PDFPage) -> Bool {
    let box = page.bounds(for: .mediaBox), width = 256
    guard box.width > 0, box.height > 0 else { return false }
    let height = max(1, Int((CGFloat(width) * box.height / box.width).rounded()))
    guard height <= 2000 else { return false }
    var pixels = [UInt8](repeating: 255, count: width * height * 4)
    pixels.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        context.setFillColor(NSColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: CGFloat(width) / box.width, y: CGFloat(height) / box.height)
        context.translateBy(x: -box.minX, y: -box.minY)
        page.draw(with: .mediaBox, to: context)
    }
    return stride(from: 0, to: pixels.count, by: 4).filter { pixels[$0] < 235 || pixels[$0 + 1] < 235 || pixels[$0 + 2] < 235 }.count >= 15
}
func inspect(_ data: Data, filename: String, prefix: String) {
    do { try data.write(to: outputDir.appendingPathComponent(filename), options: .atomic) }
    catch { errors.append("write \(filename): \(error)"); return }
    guard let pdf = PDFDocument(data: data) else { checks["\(prefix)_valid_pdf"] = false; return }
    checks["\(prefix)_valid_pdf"] = pdf.pageCount == pages.count
    for (i, expected) in pages.enumerated() {
        let box = pdf.page(at: i)?.bounds(for: .mediaBox) ?? .zero
        checks["\(prefix)_page_\(i + 1)_physical_size"] = abs(box.width - expected.widthPt) < 0.05 && abs(box.height - expected.heightPt) < 0.05
        if canvasInput { checks["\(prefix)_page_\(i + 1)_nonblank"] = pdf.page(at: i).map(pageHasInk) ?? false }
    }
    let text = pdf.string ?? ""
    report["\(prefix)_extracted_text"] = text
    if canvasInput {
        let expected = ProcessInfo.processInfo.environment["MOLSTUDIO_PDF_EXPECT_TEXT"] ?? ""
        checks["\(prefix)_selectable_text"] = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (expected.isEmpty || text.contains(expected))
        return
    }
    checks["\(prefix)_english_selectable"] = text.contains("Hello") && text.contains("Second page") && text.contains("C=O")
    checks["\(prefix)_chinese_selectable"] = text.contains("中文测试") && text.contains("化学文档")
    let compact = text.filter { !$0.isWhitespace }
    checks["\(prefix)_ambiguous_and_overlap_exact"] = compact.contains("文⽂页⻚文⽂")
    if let page = pdf.page(at: 0), let pageText = page.string {
        let ns = pageText as NSString, sequences = ["文⽂页⻚", "文⽂"]
        checks["\(prefix)_individual_character_selection"] = sequences.allSatisfy { expected in
            let range = ns.range(of: expected, options: expected == "文⽂" ? .backwards : [])
            guard range.location != NSNotFound else { return false }
            return Array(expected.utf16).enumerated().allSatisfy { offset, code in
                page.selection(for: NSRange(location: range.location + offset, length: 1))?.string == String(utf16CodeUnits: [code], count: 1)
            }
        }
    } else { checks["\(prefix)_individual_character_selection"] = false }
}
func testFailures() {
    exporter.export(pages: [], isValid: { true }) { result in
        if case .failure = result { checks["empty_rejected"] = true } else { checks["empty_rejected"] = false }
        exporter.export(pages: pages, isValid: { false }) { result in
            if case .failure = result { checks["stale_navigation_rejected"] = true } else { checks["stale_navigation_rejected"] = false }
            let bad = DocumentPDFExporter.Page(id: "bad", widthPt: 595.28, heightPt: 841.89,
                svg: #"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/missing.png"/></svg>"#)
            exporter.export(pages: [bad], isValid: { true }) { result in
                if case .failure = result { checks["external_image_rejected"] = true } else { checks["external_image_rejected"] = false }
                finish()
            }
        }
    }
}
func repeatExport() {
    exporter.export(pages: pages, isValid: { true }) { result in
        switch result {
        case .success(let data): inspect(data, filename: "probe-repeat.pdf", prefix: "repeat")
        case .failure(let error): errors.append("repeat: \(error.localizedDescription)")
        }
        if canvasInput { finish() } else { testFailures() }
    }
}
DispatchQueue.main.async {
    exporter.export(pages: pages, isValid: { true }) { result in
        switch result {
        case .success(let data): inspect(data, filename: "probe.pdf", prefix: "first")
        case .failure(let error): errors.append("first: \(error.localizedDescription)")
        }
        repeatExport()
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { errors.append("probe timeout"); finish() }
app.run()
