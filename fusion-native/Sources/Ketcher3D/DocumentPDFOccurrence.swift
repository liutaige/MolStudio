import Foundation
import CoreText
import CoreGraphics

struct SourceGlyphGeometry {
    let character:String, x:Double, y:Double, width:Double, height:Double
    var baselineX:Double? = nil, baselineY:Double? = nil
    var orderedPaint:Bool = false
}
struct SourcePageGeometry { let width:Double, height:Double, glyphs:[SourceGlyphGeometry] }
private func occurrenceError(_ message:String)->NSError {NSError(domain:"PrototypePDFOccurrence",code:1,userInfo:[NSLocalizedDescriptionKey:message])}
private func glyphForString(_ text:String,_ font:CTFont)->CGGlyph? {
    let chars=Array(text.utf16);guard (1...2).contains(chars.count) else{return nil};var result=[CGGlyph](repeating:0,count:chars.count)
    let success=chars.withUnsafeBufferPointer { source in result.withUnsafeMutableBufferPointer { dest in CTFontGetGlyphsForCharacters(font,source.baseAddress!,dest.baseAddress!,chars.count) } }
    return success ? result.first(where:{$0 != 0}) : nil
}
/// Match ambiguous glyphs by the actual drawn origin, font cmap and frozen source boxes.
/// A guessed match is never written: overlap and unsupported form reuse throw.
func resolvePDFAmbiguities(_ pdf:Data,source:String,geometry:[SourcePageGeometry]) throws -> [PDFResourceAssignment] {
    guard let provider=CGDataProvider(data:pdf as CFData),let doc=CGPDFDocument(provider),doc.numberOfPages==geometry.count else{throw occurrenceError("PDF page count does not match source geometry")}
    let chars=Set(source.unicodeScalars.filter{isCJKScalar($0.value)}.map(String.init))
    var fontGroups:[String:[CGGlyph:Set<String>]]=[:],result:[PDFResourceAssignment]=[]
    for p in 0..<geometry.count {
        guard let page=doc.page(at:p+1) else{throw occurrenceError("Missing PDF page")}
        let maps=try pdfPageFontMaps(pdf,page:p),drawn=try scanPageGlyphs(page),geo=geometry[p],bounds=page.getBoxRect(.mediaBox)
        guard geo.width>0,geo.height>0 else{throw occurrenceError("Invalid source page geometry")}
        let scale=min(bounds.width/geo.width,bounds.height/geo.height),xOffset=(bounds.width-geo.width*scale)/2,yOffset=(bounds.height-geo.height*scale)/2
        var used=Set<Int>()
        for item in drawn {
            guard let mapped=maps[item.fontResource]?[item.cid],mapped.unicodeScalars.count==1,let scalar=mapped.unicodeScalars.first,
                  isCJKScalar(scalar.value) else{continue}
            let fontName=String(item.fontName.split(separator:"+").last ?? Substring(item.fontName)),font=CTFontCreateWithName(fontName as CFString,16,nil)
            if fontGroups[fontName]==nil {var groups:[CGGlyph:Set<String>]=[:];for c in chars {if let g=glyphForString(c,font){groups[g,default:[]].insert(c)}};fontGroups[fontName]=groups}
            guard let g=glyphForString(mapped,font),let choices=fontGroups[fontName]?[g],!choices.isEmpty else{continue}
            let possible=geo.glyphs.enumerated().filter { index,box in
                guard !used.contains(index),choices.contains(box.character) else{return false}
                if let bx=box.baselineX,let by=box.baselineY {
                    return abs(item.origin.x-(bounds.minX+xOffset+bx*scale))<=1.5 && abs(item.origin.y-(bounds.maxY-yOffset-by*scale))<=1.5
                }
                let left=bounds.minX+xOffset+box.x*scale,top=bounds.maxY-yOffset-box.y*scale,bottom=top-box.height*scale
                return abs(item.origin.x-left)<=1.5 && item.origin.y>=bottom-1.5 && item.origin.y<=top+1.5
            }
            // For board's absolute-positioned sibling items and SVG paint trees,
            // collection and PDF scanning both follow verified paint order. This
            // disambiguates perfectly overlapping identical glyphs without guessing
            // their semantic character from appearance alone.
            // A cloned scene can contain off-page text which is clipped by the
            // page capture. Such PDF operations have no visible source box.
            guard let (index,box)=possible.first else { continue }
            guard possible.count==1 || possible.allSatisfy({$0.element.orderedPaint}) else{throw occurrenceError("Cannot uniquely locate source for an ambiguous PDF glyph")}
            used.insert(index)
            if choices.count>1 {
                guard item.xobjectPath.isEmpty else{throw occurrenceError("Ambiguous text inside a reused PDF Form requires per-instance resources")}
                result.append(.init(page:p,operation:item.operation,arrayIndex:item.arrayIndex,byteOffset:item.byteOffset,bytes:item.bytes,fontResource:item.fontResource,fontSize:Double(item.fontSize),text:box.character))
            }
        }
        for (index,box) in geo.glyphs.enumerated() where !used.contains(index) {
            _ = box
            throw occurrenceError("A visible source character could not be matched to a PDF occurrence (page \(p + 1), source index \(index))")
        }
    }
    return result
}
