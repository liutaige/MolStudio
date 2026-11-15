import Foundation
import CoreGraphics
import CoreText
import PDFKit
@main struct PDFOccurrenceTests {
 static func makePDF()->Data {
  let out=NSMutableData(),consumer=CGDataConsumer(data:out as CFMutableData)!;var box=CGRect(x:0,y:0,width:400,height:300);let context=CGContext(consumer:consumer,mediaBox:&box,nil)!
  context.beginPDFPage(nil);let font=CTFontCreateWithName("PingFangSC-Regular" as CFString,24,nil)
  for (i,char) in ["文","⽂","页","⻚"].enumerated(){let line=CTLineCreateWithAttributedString(NSAttributedString(string:char,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font]));context.textPosition=CGPoint(x:20+24*i,y:100);CTLineDraw(line,context)}
  context.endPDFPage();context.closePDF();return out as Data
 }
 static func pixels(_ pdf:Data)->[UInt8] {
  let doc=PDFDocument(data:pdf)!,page=doc.page(at:0)!;var data=[UInt8](repeating:255,count:400*300*4)
  data.withUnsafeMutableBytes {bytes in let c=CGContext(data:bytes.baseAddress,width:400,height:300,bitsPerComponent:8,bytesPerRow:1600,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!;page.draw(with:.mediaBox,to:c)};withExtendedLifetime(doc){};return data
 }
 static func main() throws {
  let values=["文","⽂","页","⻚"],source=values.joined(),pdf=makePDF()
  let geometry=SourcePageGeometry(width:400,height:300,glyphs:values.enumerated().map { i,c in SourceGlyphGeometry(character:c,x:Double(20+24*i),y:176,width:24,height:28) })
  let assignments=try resolvePDFAmbiguities(pdf,source:source,geometry:[geometry]);guard assignments.count==4 else{fatalError("expected four individually matched glyphs")}
  let normalized=try repairPDFTextMappings(pdf,source:source,allowAmbiguous:true).0,fixed=try patchPDFResources(normalized,assignments:assignments)
  let document=PDFDocument(data:fixed)!,page=document.page(at:0)!,text=(page.string ?? "").filter{!$0.isWhitespace}
  guard text==source,pixels(pdf)==pixels(fixed) else{fatalError("mixed Unicode or pixels: \(text)")}
  for i in 0..<4 {guard page.selection(for:NSRange(location:i,length:1))?.string==values[i] else{fatalError("individual character selection")}}
  print("Mixed source glyph occurrence mapping, individual selection and pixels passed")
 }
}
