import Foundation
import PDFKit
import CoreGraphics
@main struct PDFTextPatchTests {
 static func document(_ content:Data)->Data {
  var pdf=Data("%PDF-1.4\n".utf8), offsets=[Int](repeating:0,count:6)
  func add(_ s:String){pdf.append(Data(s.utf8))}
  let objects=["","<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
  for i in 1...4 {offsets[i]=pdf.count;add("\(i) 0 obj\n\(objects[i])\nendobj\n")}
  offsets[5]=pdf.count;add("5 0 obj\n<< /Length \(content.count) >>\nstream\n");pdf.append(content);add("\nendstream\nendobj\n")
  let xref=pdf.count;add("xref\n0 6\n0000000000 65535 f \n");for i in 1...5 {add(String(format:"%010d 00000 n \n",offsets[i]))};add("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n");return pdf
 }
 static func fontMappedDocument(_ content:Data)->Data {
  var pdf=Data("%PDF-1.4\n".utf8),offsets=[Int](repeating:0,count:14)
  func add(_ s:String){pdf.append(Data(s.utf8))}
  func object(_ id:Int,_ s:String){offsets[id]=pdf.count;add("\(id) 0 obj\n\(s)\nendobj\n")}
  object(1,"<< /Type /Catalog /Pages 2 0 R >>");object(2,"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  object(3,"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources 13 0 R /Contents 5 0 R >>")
  for (font,cmap) in [(4,9),(6,10),(7,11),(8,12)] {object(font,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode \(cmap) 0 R >>")}
  offsets[5]=pdf.count;add("5 0 obj\n<< /Length \(content.count) >>\nstream\n");pdf.append(content);add("\nendstream\nendobj\n")
  for (id,unicode) in [(9,"6587"),(10,"2F42"),(11,"9875"),(12,"2EDA")] {
   let cmap="/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00><FF>\nendcodespacerange\n1 beginbfchar\n<57><\(unicode)>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end"
   object(id,"<< /Length \(cmap.utf8.count) >>\nstream\n\(cmap)\nendstream")
  }
  object(13,"<< /Font << /F0 4 0 R /F1 6 0 R /F2 7 0 R /F3 8 0 R >> >>")
  let xref=pdf.count;add("xref\n0 14\n0000000000 65535 f \n");for i in 1...13 {add(String(format:"%010d 00000 n \n",offsets[i]))};add("trailer\n<< /Size 14 /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n");return pdf
 }
 static func pixels(_ pdf:Data)->[UInt8] {
  let doc=PDFDocument(data:pdf)!,page=doc.page(at:0)!;var data=[UInt8](repeating:255,count:400*300*4)
  data.withUnsafeMutableBytes {b in let c=CGContext(data:b.baseAddress,width:400,height:300,bitsPerComponent:8,bytesPerRow:1600,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!;page.draw(with:.mediaBox,to:c)};withExtendedLifetime(doc){};return data
 }
 static func main() throws {
  let stream=Data("BT /F1 20 Tf 40 200 Td (W\\127) Tj [<57> -50 (W)] TJ ET".utf8)
  let runs=try pdfTextRuns(stream);guard runs.map({$0.bytes}) == [[87,87],[87],[87]] else {fatalError("PDF string decoding")}
  let values=["文","⽂","页","⻚"]
  let patched=try patchPDFText(stream,replacements:[.init(run:0,byteOffset:0,byteLength:1,text:values[0]),.init(run:0,byteOffset:1,byteLength:1,text:values[1]),.init(run:1,byteOffset:0,byteLength:1,text:values[2]),.init(run:2,byteOffset:0,byteLength:1,text:values[3])])
  let original=document(stream), modified=document(patched),doc=PDFDocument(data:modified)!,page=doc.page(at:0)!
  let text=(page.string ?? "").filter{!$0.isWhitespace};guard text==values.joined() else {fatalError("ActualText extraction: \(text)")}
  for i in 0..<4 {let range=NSRange(location:i,length:1);guard let selection=page.selection(for:range),selection.string==values[i],!selection.bounds(for:page).isEmpty else {fatalError("individual selection \(i)")}}
  guard pixels(original)==pixels(modified) else {fatalError("drawing changed")}
  let originalFontStream=Data("BT /F0 20 Tf 40 200 Td (WW) Tj [<57> -50 (W)] TJ ET".utf8)
  let mapped=try patchPDFTextFonts(originalFontStream,replacements:[.init(run:0,byteOffset:1,byteLength:1,font:"F1",originalFont:"F0",size:20),.init(run:1,byteOffset:0,byteLength:1,font:"F2",originalFont:"F0",size:20),.init(run:2,byteOffset:0,byteLength:1,font:"F3",originalFont:"F0",size:20)])
  let before=fontMappedDocument(originalFontStream),after=fontMappedDocument(mapped),mappedPage=PDFDocument(data:after)!.page(at:0)!
  guard (mappedPage.string ?? "").filter({!$0.isWhitespace}) == values.joined(),pixels(before)==pixels(after) else {fatalError("source-specific font mapping or pixels")}
  for i in 0..<4 { guard let selection=mappedPage.selection(for:NSRange(location:i,length:1)),selection.string==values[i],!selection.bounds(for:mappedPage).isEmpty else {fatalError("font-mapped selection \(i)")} }
  let resourcePatched=try patchPDFResources(before,assignments:[
   .init(page:0,operation:1,arrayIndex:nil,byteOffset:1,bytes:[87],fontResource:"F0",fontSize:20,text:"⽂"),
   .init(page:0,operation:2,arrayIndex:0,byteOffset:0,bytes:[87],fontResource:"F0",fontSize:20,text:"页"),
   .init(page:0,operation:2,arrayIndex:2,byteOffset:0,bytes:[87],fontResource:"F0",fontSize:20,text:"⻚")])
  let resourceDoc=PDFDocument(data:resourcePatched)!,resourcePage=resourceDoc.page(at:0)!
  guard (resourcePage.string ?? "").filter({!$0.isWhitespace})==values.joined(),pixels(before)==pixels(resourcePatched) else{fatalError("font cloning or pixels")}
  for i in 0..<4 {guard resourcePage.selection(for:NSRange(location:i,length:1))?.string==values[i] else {fatalError("cloned font selection")}}
  try resourcePatched.write(to:URL(fileURLWithPath:"/tmp/molstudio-font-mapping-test.pdf"))
  print("PDF per-character ActualText and font mappings, Tj/TJ spacing, independent selection and pixels passed")
 }
}
