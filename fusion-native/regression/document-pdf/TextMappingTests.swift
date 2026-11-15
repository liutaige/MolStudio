import Foundation
import CoreGraphics
import CoreText
import PDFKit

@main struct TextMappingTests {
    static func makePDF(_ text:String) -> Data {
        let data=NSMutableData(),consumer=CGDataConsumer(data:data as CFMutableData)!
        var box=CGRect(x:0,y:0,width:400,height:300)
        let context=CGContext(consumer:consumer,mediaBox:&box,nil)!
        context.beginPDFPage(nil)
        let font=CTFontCreateWithName("PingFangSC-Regular" as CFString,24,nil)
        let line=CTLineCreateWithAttributedString(NSAttributedString(string:text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font]))
        context.textPosition=CGPoint(x:20,y:200); CTLineDraw(line,context);context.endPDFPage();context.closePDF()
        return data as Data
    }
    static func pixels(_ pdf:Data) -> [UInt8] {
        let document=PDFDocument(data:pdf)!,page=document.page(at:0)!,width=400,height=300
        var data=[UInt8](repeating:255,count:width*height*4)
        data.withUnsafeMutableBytes { bytes in
            let ctx=CGContext(data:bytes.baseAddress,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
            page.draw(with:.mediaBox,to:ctx)
        }
        withExtendedLifetime(document) {}
        return data
    }
    // The old compressed map is 36 bytes; mapping 2F42 to 6587 needs 37.
    // It proves the updated map can grow without rewriting drawing offsets.
    static func makeGrowthFixture() -> Data {
        var pdf=Data("%PDF-1.4\n".utf8);var offsets=[Int](repeating:0,count:7)
        func add(_ text:String) { pdf.append(Data(text.utf8)) }
        let objects=["", "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /PingFangSC-Regular /ToUnicode 6 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"]
        for id in 1...5 { offsets[id]=pdf.count;add("\(id) 0 obj\n\(objects[id])\nendobj\n") }
        let stream=Data(base64Encoded:"eNpLSk3PzEtKK0rMS0/lsjEytIPgNBMjO67UvBSYDAD8DQw3")!
        offsets[6]=pdf.count;add("6 0 obj\n<< /Length \(stream.count) /Filter /FlateDecode >>\nstream\n");pdf.append(stream);add("\nendstream\nendobj\n")
        let xref=pdf.count;add("xref\n0 7\n0000000000 65535 f \n")
        for id in 1...6 {add(String(format:"%010d 00000 n \n",offsets[id]))}
        add("trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n")
        return pdf
    }
    static func main() throws {
        let text="本页正文工人";let original=makePDF(text)
        let (fixed,_)=try repairPDFTextMappings(original,source:text)
        guard let extracted=PDFDocument(data:fixed)?.string,extracted.contains(text),pixels(original)==pixels(fixed) else { fatalError("ordinary Chinese text or page pixels changed") }
        let compatibility="本页⽂";let compatiblePDF=makePDF(compatibility)
        let (unchanged,_)=try repairPDFTextMappings(compatiblePDF,source:compatibility)
        guard let extracted=PDFDocument(data:unchanged)?.string,extracted.contains("⽂"),pixels(compatiblePDF)==pixels(unchanged) else { fatalError("compatibility character was normalized") }
        do { _=try repairPDFTextMappings(original,source:text+"⽂");fatalError("ambiguous source was accepted") } catch { print("Ambiguous source rejected: \(error.localizedDescription)") }
        let supplementary="你你";let supplementaryPDF=makePDF(supplementary)
        let (supplementaryFixed,_)=try repairPDFTextMappings(supplementaryPDF,source:supplementary)
        guard PDFDocument(data:supplementaryFixed)?.string?.contains(supplementary)==true,pixels(supplementaryPDF)==pixels(supplementaryFixed) else{fatalError("supplementary Chinese was changed")}
        let growth=makeGrowthFixture(), (expanded,changes)=try repairPDFTextMappings(growth,source:"文")
        let raw=String(data:expanded,encoding:.isoLatin1)!
        guard changes==1,raw.contains("/Length 37 /Filter /FlateDecode"),raw.contains("/Prev "),PDFDocument(data:expanded) != nil else { fatalError("expanded incremental PDF mapping failed") }
        print("Source-driven PDF text mapping, incremental growth, and pixels passed")
    }
}
