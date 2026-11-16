import Cocoa
import WebKit

// Current canvas only. Starts its own WKWebView; never attaches to a user's
// document. Field changes use AppKit mouse/key events and the native colour
// popover, not JavaScript value assignments or synthetic DOM change events.
@MainActor final class TextFormatProbe: NSObject, WKNavigationDelegate {
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1460, height: 1080))
    let env = ProcessInfo.processInfo.environment
    var window: NSWindow!
    var started = false
    var out: URL { URL(fileURLWithPath: env["MOLSTUDIO_NATIVE_TEST_OUT"] ?? "/tmp/molstudio-text-format-native", isDirectory: true) }
    func start() {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1460, height: 1080), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "MolStudio isolated native text format regression"
        window.contentView = web; web.navigationDelegate = self
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let port = env["MOLSTUDIO_PORT"] ?? "49166"
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/canvas.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { self.fail("Native text format regression timed out") }
    }
    func pause(_ seconds: Double = 0.12) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    func js(_ source: String) async throws -> Any { try await withCheckedThrowingContinuation { continuation in web.callAsyncJavaScript("return await (" + source + ")", arguments: [:], in: nil, in: .page) { continuation.resume(with: $0) } } }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }; started = true
        Task { do { try await run() } catch { fail(String(describing: error)) } }
    }
    func click(_ selector: String) async throws {
        let quoted = String(data: try JSONSerialization.data(withJSONObject: [selector]), encoding: .utf8)!
        let value = try await js("(()=>{const node=document.querySelector((\(quoted))[0]);if(!node)throw Error('Missing control');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
        guard let p = value as? [String: Double], let x = p["x"], let y = p["y"] else { throw NSError(domain: "NativeTextFormat", code: 1) }
        let point = web.convert(NSPoint(x: x, y: web.isFlipped ? y : web.bounds.height - y), to: nil)
        mouse(point, in: window); await pause()
    }
    func mouse(_ point: NSPoint, in target: NSWindow) {
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
            NSApp.sendEvent(event)
        }
    }
    func key(_ chars: String, _ code: UInt16 = 0, flags: NSEvent.ModifierFlags = []) async {
        for type: NSEvent.EventType in [.keyDown, .keyUp] {
            NSApp.sendEvent(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!)
        }
        await pause()
    }
    func size(_ text: String) async throws {
        try await click("[data-doc-format=font-size]"); await key("a", flags: [.command])
        for char in text { await key(String(char)) }; await key("\r", 36)
    }
    func choose(_ name: String, _ prefix: String) async throws {
        try await click("[data-doc-format=\(name)]"); await key(prefix)
    }
    func run() async throws {
        for _ in 0..<250 {
            if try await js("Boolean(window.k3dAPI?.workbenchReady?.()&&window.MolStudio?.document)") as? Bool == true { break }
            await pause(0.1)
        }
        _ = try await js("""
        (()=>{const c=MolWorkbench.app.documentController;c.init({mode:'paper'});c.fitPage();window.__id=c.addText({x:12,y:14,w:24,h:5,text:'base'});c.editText(__id);window.__audit=[];for(const d of [document,c.doc])for(const t of ['mousedown','change','input','blur','focus','keydown'])d.addEventListener(t,e=>setTimeout(()=>__audit.push({type:t,target:e.target?.dataset?.docFormat||e.target?.id||e.target?.tagName,key:e.key,value:e.target?.value,prevented:e.defaultPrevented,top:document.activeElement?.tagName,frame:c.doc.activeElement?.tagName,editor:!!c.editor}),0),true);window.__history=c.adapter.ed.historySize().undo;window.__editor=c.editor;return true})()
        """)
        for char in " newly typed" { await key(String(char)) }
        _ = try await js("(()=>{const c=MolWorkbench.app.documentController,r=c.doc.createRange();r.selectNodeContents(c.editor.div);const s=c.win.getSelection();s.removeAllRanges();s.addRange(r);return true})()")
        try await size("26")
        try await choose("font", "t")
        try await click("[data-doc-format=color]"); await pause(0.25)
        if !NSApp.windows.contains(where: { $0.isVisible && NSStringFromClass(type(of: $0)).contains("Popover") }) { try await click("[data-doc-format=color]"); await pause(0.25) }
        guard let popover = NSApp.windows.first(where: { $0.isVisible && NSStringFromClass(type(of: $0)).contains("Popover") }), let content = popover.contentView, let swatches = content.subviews.first(where: { NSStringFromClass(type(of: $0)).contains("ColorPickerMatrix") }) else { print("NATIVE WINDOWS", NSApp.windows.map { "\(NSStringFromClass(type(of:$0))) visible=\($0.isVisible) title=\($0.title) frame=\($0.frame)" }); print("AUDIT",try await js("JSON.stringify(__audit)")); throw NSError(domain: "Native colour popover did not open", code: 2) }
        mouse(swatches.convert(NSPoint(x: 9, y: 9), to: nil), in: popover); await pause(0.25)
        if popover.isVisible { popover.close() }; window.makeKeyAndOrderFront(nil)
        try await choose("align", "居")
        try await choose("line-height", "2")
        try await size("28")
        let raw = try await js("""
        (async()=>{const c=MolWorkbench.app.documentController,checks=[];const check=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});const rich=c.readTextEditRich(c.editor),run=rich.runs?.[0],dom=c.editor.div;check('native font, repeated size, and native colour swatch retain the same text selection',rich.text==='base newly typed'&&run?.start===0&&run?.end===16&&run.fontSize===28&&run.fontFamily.replace(/["'\\s]/g,'')==='TimesNewRoman,SongtiSC,serif'&&run.color==='#ff2600',{rich,html:dom.innerHTML});check('native alignment and line spacing change the DOM and model',rich.align==='center'&&rich.lineHeight===2.2&&dom.style.textAlign==='center'&&dom.style.lineHeight==='2.2',{align:dom.style.textAlign,lineHeight:dom.style.lineHeight});check('typing and changing controls preserve the editor and create no premature undo entries',c.editor===__editor&&c.adapter.ed.historySize().undo===__history,{history:c.adapter.ed.historySize(),initial:__history});const saved=await k3dAPI.serializeWorkbench(),snapshot=JSON.parse(saved).document.objects.find(o=>o.id===__id).rich;check('read-only native snapshots preserve the complete formatted draft',JSON.stringify(snapshot)===JSON.stringify(rich)&&c.editor===__editor,{snapshot});c.finishTextEdit();check('finishing the session creates exactly one undo entry',c.adapter.ed.historySize().undo===__history+1,{history:c.adapter.ed.historySize()});k3dAPI.undo();check('one undo restores the original text and formatting',c.object(__id).rich.text==='base'&&!c.object(__id).rich.runs,{rich:c.object(__id).rich});k3dAPI.redo();check('redo restores all formatting and typed text together',JSON.stringify(c.object(__id).rich)===JSON.stringify(rich),{rich:c.object(__id).rich});await k3dAPI.loadWorkbench(saved);check('saving and reopening preserves the native field choices',JSON.stringify(c.object(__id).rich)===JSON.stringify(rich),{rich:c.object(__id).rich});const visible=[...c.doc.querySelectorAll('[data-doc-id="'+__id+'"] tspan')].find(node=>node.getAttribute('font-family')?.includes('Times New Roman'));check('the reopened canvas visibly renders the chosen font family',visible?.textContent===rich.text,{fontFamily:visible?.getAttribute('font-family')});c.editText(__id);const unchanged=JSON.stringify(c.object(__id).rich),history=c.adapter.ed.historySize().undo;c.finishTextEdit();check('an untouched text session creates no empty undo entry',c.adapter.ed.historySize().undo===history&&JSON.stringify(c.object(__id).rich)===unchanged);c.editText(__id);const r=c.doc.createRange();r.selectNodeContents(c.editor.div);const sel=c.win.getSelection();sel.removeAllRanges();sel.addRange(r);MolWorkbench.app.documentUI.applySelectionRich({color:'#0000ff'});c.finishTextEdit(true);check('cancelling discards staged formatting without history',JSON.stringify(c.object(__id).rich)===unchanged&&c.adapter.ed.historySize().undo===history,{rich:c.object(__id).rich,history:c.adapter.ed.historySize()});const glyphMetrics = id => {
        const object=c.object(id),textNode=c.doc.querySelector('[data-doc-id="'+id+'"] text'),box=textNode.getBBox();
        let character=0;
        // WebKit returns the whole text element's bbox for each child tspan.
        // Read the root SVG text's per-character extents to measure each line.
        const lines=[...textNode.children].map(line=>{let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;for(let i=0;i<line.textContent.length;i++){const b=textNode.getExtentOfChar(character++);left=Math.min(left,b.x);top=Math.min(top,b.y);right=Math.max(right,b.x+b.width);bottom=Math.max(bottom,b.y+b.height);}return {x:left,y:top,width:right-left,height:bottom-top};});
        return {id,object:{x:object.x,y:object.y,w:object.w,h:object.h},box:{x:box.x,y:box.y,width:box.width,height:box.height},lines,
        inside:box.x>=object.x-1e-5&&box.y>=object.y-1e-5&&box.x+box.width<=object.x+object.w+1e-5&&box.y+box.height<=object.y+object.h+1e-5,
        separated:lines.every((line,i)=>!i||line.y>=lines[i-1].y+lines[i-1].height-1e-5)};
        };
        const chosenMetrics=glyphMetrics(__id);
        check('the native 28pt font glyphs stay within the text object after reopening',chosenMetrics.inside,chosenMetrics);
        const narrowText='WWWW MMMM wide large letters wrap';
        const narrowId=c.addText({x:12,y:22,w:8,h:.5,text:narrowText,rich:{fontSize:12,runs:[{start:0,end:narrowText.length,fontSize:28}]}});
        const mixedText=['small','WIDE','small','BIGGER'].join(String.fromCharCode(10));
        const mixedId=c.addText({x:24,y:22,w:14,h:.5,text:mixedText,rich:{fontSize:12,lineHeight:1.4,runs:[{start:6,end:10,fontSize:28},{start:17,end:23,fontSize:36}]}});
        const narrowMetrics=glyphMetrics(narrowId),mixedMetrics=glyphMetrics(mixedId);
        check('larger font runs wrap using actual glyph advances and remain inside object bounds',narrowMetrics.inside&&narrowMetrics.lines.length>1,narrowMetrics);
        check('mixed font-size lines stay inside the object and never overlap at normal line spacing',mixedMetrics.inside&&mixedMetrics.separated,mixedMetrics);
        const finalSaved=await k3dAPI.serializeWorkbench();await k3dAPI.loadWorkbench(finalSaved);
        check('saving and reopening preserves run-size wrapping and non-overlapping line bounds',[__id,narrowId,mixedId].every(id=>{const metric=glyphMetrics(id);return metric.inside&&metric.separated}),[__id,narrowId,mixedId].map(glyphMetrics));
        return JSON.stringify({application:'MolStudio current canvas',page:'fusion/canvas.html',runtime:'AppKit/WKWebView native input',ok:checks.every(x=>x.pass),checks,audit:__audit,saved:finalSaved},null,2)})()
        """)
        guard let text = raw as? String, var report = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw NSError(domain: "Native report missing", code: 3) }
        if let saved = report.removeValue(forKey: "saved") as? String { try saved.write(to: out.appendingPathComponent("formatted-text.molwork"), atomically: true, encoding: .utf8) }
        report["build"] = env["MOLSTUDIO_TEST_BUILD"] ?? "source checkout: fusion/canvas.html"
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]); try data.write(to: out.appendingPathComponent("report.json"))
        print(String(data: data, encoding: .utf8)!); let ok = report["ok"] as? Bool == true
        web.takeSnapshot(with: nil) { image, _ in
            if let bitmap = image?.tiffRepresentation.flatMap({ NSBitmapImageRep(data: $0) }), let png = bitmap.representation(using: .png, properties: [:]) { try? png.write(to: self.out.appendingPathComponent("canvas.png")) }
            exit(ok ? 0 : 1)
        }
    }
    func fail(_ message: String) { try? JSONSerialization.data(withJSONObject: ["ok": false, "error": message], options: [.prettyPrinted]).write(to: out.appendingPathComponent("report.json")); print(message); exit(2) }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let menu = NSMenu(), edit = NSMenuItem(); menu.addItem(edit)
let editMenu = NSMenu(title: "Edit"); edit.submenu = editMenu
let all = NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"); all.keyEquivalentModifierMask = [.command]; editMenu.addItem(all); application.mainMenu = menu
MainActor.assumeIsolated { let probe = TextFormatProbe(); probe.start(); application.run(); withExtendedLifetime(probe) {} }
