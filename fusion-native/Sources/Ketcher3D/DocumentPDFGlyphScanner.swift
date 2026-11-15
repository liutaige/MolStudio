import Foundation
import CoreGraphics

// Experimental Quartz PDF scanner. Positions are PDF page coordinates; source
// bytes are preserved so the consumer can address a specific drawing operation.
// Fail closed for unsupported fonts/operators; this is not yet a PDF rewriter.
struct PDFDrawnGlyph {
    let fontResource:String, fontName:String, xobjectPath:[String]
    let operation:Int, arrayIndex:Int?, byteOffset:Int, bytes:[UInt8], cid:Int
    let fontSize:CGFloat
    let textMatrix:CGAffineTransform, ctm:CGAffineTransform, origin:CGPoint
    let clipActive:Bool
}
private struct State {
    var ctm = CGAffineTransform.identity, text = CGAffineTransform.identity, line = CGAffineTransform.identity
    var font = "", fontSize:CGFloat = 0, charSpace:CGFloat = 0, wordSpace:CGFloat = 0, hScale:CGFloat = 1, leading:CGFloat = 0, rise:CGFloat = 0
    var clipActive = false, pendingClip = false, positionReliable = true
}
private struct Font {
    let name:String, codeBytes:Int, widths:[Int:CGFloat], defaultWidth:CGFloat, metricsKnown:Bool
    func width(_ code:Int)->CGFloat { widths[code] ?? defaultWidth }
}
private final class ScannerState {
    var state=State(), stack=[State](), fontStack=[Font?](), output=[PDFDrawnGlyph](), error:String?, operation=0, path=[String]()
    var font:Font?
    func fail(_ reason:String){if error == nil {error=reason}}
}
private func data(_ s:CGPDFStringRef)->[UInt8] {guard let p=CGPDFStringGetBytePtr(s) else{return []};return Array(UnsafeBufferPointer(start:p,count:CGPDFStringGetLength(s)))}
private func dict(_ d:CGPDFDictionaryRef,_ key:String)->CGPDFDictionaryRef? {var x:CGPDFDictionaryRef?;return CGPDFDictionaryGetDictionary(d,key,&x) ? x:nil}
private func array(_ d:CGPDFDictionaryRef,_ key:String)->CGPDFArrayRef? {var x:CGPDFArrayRef?;return CGPDFDictionaryGetArray(d,key,&x) ? x:nil}
private func name(_ d:CGPDFDictionaryRef,_ key:String)->String? {var x:UnsafePointer<CChar>?;return CGPDFDictionaryGetName(d,key,&x) ? x.map(String.init(cString:)):nil}
private func number(_ d:CGPDFDictionaryRef,_ key:String)->CGFloat? {var x:CGPDFReal=0;return CGPDFDictionaryGetNumber(d,key,&x) ? x:nil}
private func readFont(_ d:CGPDFDictionaryRef)throws->Font {
    let subtype=name(d,"Subtype") ?? "", fontName=name(d,"BaseFont") ?? "unknown"
    var widths=[Int:CGFloat](), defaultWidth:CGFloat=0
    if subtype == "Type0" {
        guard name(d,"Encoding") == "Identity-H",let descendants=array(d,"DescendantFonts") else {throw ScanError.unsupported("Type0 encoding")}
        var child:CGPDFDictionaryRef?;guard CGPDFArrayGetDictionary(descendants,0,&child),let child else {throw ScanError.unsupported("CID descendant")}
        defaultWidth=number(child,"DW") ?? 1000
        if let w=array(child,"W") {var i=0;while i<CGPDFArrayGetCount(w){
            var first:CGPDFInteger=0;guard CGPDFArrayGetInteger(w,i,&first) else {throw ScanError.unsupported("CID W")};i+=1
            var series:CGPDFArrayRef?
            if CGPDFArrayGetArray(w,i,&series),let series {for j in 0..<CGPDFArrayGetCount(series){var n:CGPDFReal=0;guard CGPDFArrayGetNumber(series,j,&n) else {throw ScanError.unsupported("CID W array")};widths[Int(first)+j]=n};i+=1}
            else {var last:CGPDFInteger=0,n:CGPDFReal=0;guard CGPDFArrayGetInteger(w,i,&last),CGPDFArrayGetNumber(w,i+1,&n),last>=first,last-first<100000 else {throw ScanError.unsupported("CID W range")};for j in first...last{widths[Int(j)]=n};i+=2}
        }}
        return Font(name:fontName,codeBytes:2,widths:widths,defaultWidth:defaultWidth,metricsKnown:true)
    }
    guard ["Type1","TrueType","Type3"].contains(subtype),let a=array(d,"Widths"),let first=number(d,"FirstChar") else {throw ScanError.unsupported("simple font widths \(subtype) \(fontName)")}
    for i in 0..<CGPDFArrayGetCount(a){var n:CGPDFReal=0;if CGPDFArrayGetNumber(a,i,&n){widths[Int(first)+i]=n}}
    if let desc=dict(d,"FontDescriptor"){defaultWidth=number(desc,"MissingWidth") ?? 0}
    return Font(name:fontName,codeBytes:1,widths:widths,defaultWidth:defaultWidth,metricsKnown:true)
}
private enum ScanError:Error {case unsupported(String)}
private func context(_ p:UnsafeMutableRawPointer?)->ScannerState {Unmanaged<ScannerState>.fromOpaque(p!).takeUnretainedValue()}
private func pop(_ s:CGPDFScannerRef,_ n:Int)->[CGFloat]? {var vals=[CGFloat]();for _ in 0..<n {var x:CGPDFReal=0;guard CGPDFScannerPopNumber(s,&x) else{return nil};vals.append(x)};return vals.reversed()}
private func show(_ s:CGPDFScannerRef,_ c:ScannerState,_ str:CGPDFStringRef,_ arrayIndex:Int?) {
    guard let font=c.font else{c.fail("Missing font");return};let bytes=data(str);guard bytes.count%font.codeBytes==0 else{c.fail("Invalid font code length");return}
    for offset in stride(from:0,to:bytes.count,by:font.codeBytes){
        let codeBytes=Array(bytes[offset..<offset+font.codeBytes]);let cid=codeBytes.reduce(0){($0<<8)|Int($1)}
        let point = c.state.positionReliable && font.metricsKnown ? CGPoint(x:0,y:c.state.rise).applying(c.state.text).applying(c.state.ctm) : CGPoint(x:CGFloat.nan,y:CGFloat.nan)
        c.output.append(PDFDrawnGlyph(fontResource:c.state.font,fontName:font.name,xobjectPath:c.path,operation:c.operation,arrayIndex:arrayIndex,byteOffset:offset,bytes:codeBytes,cid:cid,fontSize:c.state.fontSize,textMatrix:c.state.text,ctm:c.state.ctm,origin:point,clipActive:c.state.clipActive))
        if !font.metricsKnown {c.state.positionReliable=false}
        let advance=(font.width(cid)/1000*c.state.fontSize+c.state.charSpace+(cid==32 ? c.state.wordSpace:0))*c.state.hScale
        c.state.text=CGAffineTransform(translationX:advance,y:0).concatenating(c.state.text)
    }
}
private func table()->CGPDFOperatorTableRef {
    let t=CGPDFOperatorTableCreate()!
    CGPDFOperatorTableSetCallback(t,"q"){_,p in let c=context(p);c.stack.append(c.state);c.fontStack.append(c.font)}
    CGPDFOperatorTableSetCallback(t,"Q"){_,p in let c=context(p);if let s=c.stack.popLast(){c.state=s;c.font=c.fontStack.removeLast()}else{c.fail("Unbalanced Q")}}
    CGPDFOperatorTableSetCallback(t,"cm"){s,p in let c=context(p);if let a=pop(s,6){c.state.ctm=CGAffineTransform(a:a[0],b:a[1],c:a[2],d:a[3],tx:a[4],ty:a[5]).concatenating(c.state.ctm)}else{c.fail("cm operands")}}
    CGPDFOperatorTableSetCallback(t,"W"){_,p in context(p).state.pendingClip=true}
    CGPDFOperatorTableSetCallback(t,"W*"){_,p in context(p).state.pendingClip=true}
    for op in ["n","S","s","f","F","f*","B","B*","b","b*"] {CGPDFOperatorTableSetCallback(t,op){_,p in let c=context(p);if c.state.pendingClip{c.state.clipActive=true;c.state.pendingClip=false}}}
    CGPDFOperatorTableSetCallback(t,"BT"){_,p in let c=context(p);c.state.text = .identity;c.state.line = .identity;c.state.positionReliable=true}
    CGPDFOperatorTableSetCallback(t,"Tm"){s,p in let c=context(p);if let a=pop(s,6){c.state.text=CGAffineTransform(a:a[0],b:a[1],c:a[2],d:a[3],tx:a[4],ty:a[5]);c.state.line=c.state.text;c.state.positionReliable=true}else{c.fail("Tm operands")}}
    CGPDFOperatorTableSetCallback(t,"Td"){s,p in let c=context(p);if let a=pop(s,2){c.state.line=CGAffineTransform(translationX:a[0],y:a[1]).concatenating(c.state.line);c.state.text=c.state.line;c.state.positionReliable=true}else{c.fail("Td operands")}}
    CGPDFOperatorTableSetCallback(t,"TD"){s,p in let c=context(p);if let a=pop(s,2){c.state.leading = -a[1];c.state.line=CGAffineTransform(translationX:a[0],y:a[1]).concatenating(c.state.line);c.state.text=c.state.line;c.state.positionReliable=true}else{c.fail("TD operands")}}
    CGPDFOperatorTableSetCallback(t,"T*"){_,p in let c=context(p);c.state.line=CGAffineTransform(translationX:0,y:-c.state.leading).concatenating(c.state.line);c.state.text=c.state.line;c.state.positionReliable=true}
    CGPDFOperatorTableSetCallback(t,"Tc"){s,p in if let a=pop(s,1){context(p).state.charSpace=a[0]}else{context(p).fail("Tc")}}
    CGPDFOperatorTableSetCallback(t,"Tw"){s,p in if let a=pop(s,1){context(p).state.wordSpace=a[0]}else{context(p).fail("Tw")}}
    CGPDFOperatorTableSetCallback(t,"Tz"){s,p in if let a=pop(s,1){context(p).state.hScale=a[0]/100}else{context(p).fail("Tz")}}
    CGPDFOperatorTableSetCallback(t,"TL"){s,p in if let a=pop(s,1){context(p).state.leading=a[0]}else{context(p).fail("TL")}}
    CGPDFOperatorTableSetCallback(t,"Ts"){s,p in if let a=pop(s,1){context(p).state.rise=a[0]}else{context(p).fail("Ts")}}
    CGPDFOperatorTableSetCallback(t,"Tf"){s,p in let c=context(p);var sz:CGPDFReal=0;var ptr:UnsafePointer<CChar>?;guard CGPDFScannerPopNumber(s,&sz),CGPDFScannerPopName(s,&ptr),let ptr else{c.fail("Tf operands");return};let key=String(cString:ptr);c.state.font=key;c.state.fontSize=sz;let stream=CGPDFScannerGetContentStream(s);guard let object=CGPDFContentStreamGetResource(stream,"Font",key) else{c.fail("Missing font resource \(key)");return};var d:CGPDFDictionaryRef?;guard CGPDFObjectGetValue(object,.dictionary,&d),let d else{c.fail("Font dictionary");return};do{c.font=try readFont(d)}catch{let subtype=name(d,"Subtype") ?? "";c.font=Font(name:name(d,"BaseFont") ?? "unknown",codeBytes:subtype=="Type0" ? 2:1,widths:[:],defaultWidth:0,metricsKnown:false)}}
    CGPDFOperatorTableSetCallback(t,"Tj"){s,p in let c=context(p);c.operation+=1;var str:CGPDFStringRef?;if CGPDFScannerPopString(s,&str),let str{show(s,c,str,nil)}else{c.fail("Tj")}}
    CGPDFOperatorTableSetCallback(t,"TJ"){s,p in let c=context(p);c.operation+=1;var a:CGPDFArrayRef?;guard CGPDFScannerPopArray(s,&a),let a else{c.fail("TJ");return};for i in 0..<CGPDFArrayGetCount(a){var str:CGPDFStringRef?;var n:CGPDFReal=0;if CGPDFArrayGetString(a,i,&str),let str{show(s,c,str,i)}else if CGPDFArrayGetNumber(a,i,&n){c.state.text=CGAffineTransform(translationX:-n/1000*c.state.fontSize*c.state.hScale,y:0).concatenating(c.state.text)}else{c.fail("TJ entry")}}}
    CGPDFOperatorTableSetCallback(t,"'"){_,p in context(p).fail("Unsupported quote text operator")}
    CGPDFOperatorTableSetCallback(t,"\""){_,p in context(p).fail("Unsupported double quote text operator")}
    CGPDFOperatorTableSetCallback(t,"Do"){s,p in let c=context(p);var ptr:UnsafePointer<CChar>?;guard CGPDFScannerPopName(s,&ptr),let ptr else{c.fail("Do operands");return};let key=String(cString:ptr);let stream=CGPDFScannerGetContentStream(s);guard let object=CGPDFContentStreamGetResource(stream,"XObject",key) else{c.fail("Missing XObject");return};var x:CGPDFStreamRef?;guard CGPDFObjectGetValue(object,.stream,&x),let x,let d=CGPDFStreamGetDictionary(x) else{c.fail("XObject stream");return};guard name(d,"Subtype")=="Form" else{return};guard c.path.count<16 else{c.fail("XObject recursion limit");return};let saved=c.state, savedFont=c.font,depth=c.stack.count;c.path.append(key)
        if let m=array(d,"Matrix"),CGPDFArrayGetCount(m)==6{var a=[CGFloat]();for i in 0..<6{var x:CGPDFReal=0;if CGPDFArrayGetNumber(m,i,&x){a.append(x)}};if a.count==6{c.state.ctm=CGAffineTransform(a:a[0],b:a[1],c:a[2],d:a[3],tx:a[4],ty:a[5]).concatenating(c.state.ctm)}else{c.fail("Form Matrix")}}
        c.state.clipActive=true // Form BBox is an implicit clip; not a visibility verdict.
        guard let resources=dict(d,"Resources") else{c.fail("Form missing resources");c.state=saved;c.font=savedFont;c.path.removeLast();return};let child=CGPDFContentStreamCreateWithStream(x,resources,stream);let scanner=CGPDFScannerCreate(child,table(),p);if !CGPDFScannerScan(scanner){c.fail("Form scan")};if c.stack.count != depth{c.fail("Unbalanced Form state")};c.state=saved;c.font=savedFont;c.path.removeLast()
    }
    return t
}
func scanPageGlyphs(_ page:CGPDFPage)throws->[PDFDrawnGlyph] {
    let c=ScannerState();let opaque=Unmanaged.passUnretained(c).toOpaque();let stream=CGPDFContentStreamCreateWithPage(page);let scanner=CGPDFScannerCreate(stream,table(),opaque);guard CGPDFScannerScan(scanner) else{throw ScanError.unsupported("Cannot scan page")}
    if let error=c.error{throw ScanError.unsupported(error)};if !c.stack.isEmpty{throw ScanError.unsupported("Unbalanced graphics state")};return c.output
}
