import Foundation
import CoreText

@_silgen_name("uncompress") private func zUncompress(_ dest: UnsafeMutablePointer<UInt8>, _ destLen: UnsafeMutablePointer<UInt>, _ source: UnsafePointer<UInt8>, _ sourceLen: UInt) -> Int32
@_silgen_name("compress2") private func zCompress(_ dest: UnsafeMutablePointer<UInt8>, _ destLen: UnsafeMutablePointer<UInt>, _ source: UnsafePointer<UInt8>, _ sourceLen: UInt, _ level: Int32) -> Int32

func matches(_ pattern:String, _ text:NSString) -> [NSTextCheckingResult] {
    (try? NSRegularExpression(pattern:pattern,options:[]).matches(in:text as String,range:NSRange(location:0,length:text.length))) ?? []
}
func inflate(_ data:Data) throws -> Data {
    var size=max(4096,data.count*8)
    while size <= 4_194_304 {
        var out=[UInt8](repeating:0,count:size); var length=UInt(size)
        let result=data.withUnsafeBytes { bytes in zUncompress(&out,&length,bytes.bindMemory(to:UInt8.self).baseAddress!,UInt(data.count)) }
        if result == 0 { return Data(out.prefix(Int(length))) }
        if result != -5 { break }; size *= 2
    }
    throw NSError(domain:"PrototypePDF",code:1,userInfo:[NSLocalizedDescriptionKey:"Cannot decode PDF Unicode map"])
}
func deflate(_ data:Data) throws -> Data {
    var out=[UInt8](repeating:0,count:data.count+data.count/500+64); var length=UInt(out.count)
    let result=data.withUnsafeBytes { bytes in zCompress(&out,&length,bytes.bindMemory(to:UInt8.self).baseAddress!,UInt(data.count),9) }
    guard result == 0 else { throw NSError(domain:"PrototypePDF",code:2,userInfo:[NSLocalizedDescriptionKey:"Cannot encode PDF Unicode map"]) }
    return Data(out.prefix(Int(length)))
}
func isCJKScalar(_ value:UInt32)->Bool { (0x2e80...0x2fff).contains(value) || (0x3400...0x9fff).contains(value) || (0xf900...0xfaff).contains(value) || (0x20000...0x3134f).contains(value) }
func unicodeScalarFromHex(_ hex:String)->UInt32? {
    guard hex.count==4 || hex.count==8 else{return nil}
    var units:[UInt16]=[];var start=hex.startIndex
    while start<hex.endIndex {let end=hex.index(start,offsetBy:4);guard let u=UInt16(hex[start..<end],radix:16) else{return nil};units.append(u);start=end}
    let value=String(decoding:units,as:UTF16.self);guard value.unicodeScalars.count==1,let scalar=value.unicodeScalars.first,scalar.value != 0xfffd else{return nil};return scalar.value
}
func unicodeHex(_ scalar:UInt32)->String {guard let value=UnicodeScalar(scalar) else{return ""};return String(value).utf16.map{String(format:"%04X",$0)}.joined()}
private func glyph(_ value:UInt32,_ font:CTFont) -> CGGlyph? {
    guard let scalar=UnicodeScalar(value) else{return nil};let chars=Array(String(scalar).utf16);var result=[CGGlyph](repeating:0,count:chars.count)
    let success=chars.withUnsafeBufferPointer { source in result.withUnsafeMutableBufferPointer { dest in CTFontGetGlyphsForCharacters(font,source.baseAddress!,dest.baseAddress!,chars.count) } }
    return success ? result.first(where:{$0 != 0}) : nil
}
/// Repair only ambiguous CJK mappings where the actual page source identifies a unique
/// character for the same glyph. Never normalize or infer characters absent from the source.
func repairPDFTextMappings(_ input:Data, source:String, fontSources:[String:String] = [:], allowAmbiguous:Bool = false) throws -> (Data,Int) {
    guard let encoded=String(data:input,encoding:.isoLatin1) else { throw NSError(domain:"PrototypePDF",code:3,userInfo:[NSLocalizedDescriptionKey:"Cannot read PDF data"]) }
    let text=encoded as NSString, objectHeaders=matches("(?m)^(\\d+) 0 obj\\s",text)
    var objects:[Int:NSRange]=[:]
    for (i,m) in objectHeaders.enumerated() {
        guard let n=Int(text.substring(with:m.range(at:1))) else { continue }
        let start=m.range.location, end=i+1<objectHeaders.count ? objectHeaders[i+1].range.location : text.length
        objects[n]=NSRange(location:start,length:end-start)
    }
    var cmapFonts:[Int:String]=[:]
    for region in objects.values {
        let obj=text.substring(with:region) as NSString
        guard obj.contains("/Type /Font"), let name=matches("/BaseFont\\s*/(?:[A-Z]+\\+)?([^\\s/<>]+)",obj).first,
              let ref=matches("/ToUnicode\\s+(\\d+)\\s+0\\s+R",obj).first,
              let id=Int(obj.substring(with:ref.range(at:1))) else { continue }
        let fontName=obj.substring(with:name.range(at:1))
        if let old=cmapFonts[id],old != fontName { throw NSError(domain:"PrototypePDF",code:4,userInfo:[NSLocalizedDescriptionKey:"Shared PDF Unicode map uses different fonts"]) }
        cmapFonts[id]=fontName
    }
    var updated:[Int:Data]=[:],changed=0
    for (id,name) in cmapFonts {
        guard let region=objects[id] else { throw NSError(domain:"PrototypePDF",code:5,userInfo:[NSLocalizedDescriptionKey:"Missing PDF Unicode map"]) }
        let obj=text.substring(with:region) as NSString
        guard obj.contains("/FlateDecode"), let lengthMatch=matches("/Length\\s+(\\d+)",obj).first,
              let length=Int(obj.substring(with:lengthMatch.range(at:1))), let stream=matches("stream\\r?\\n",obj).first else { continue }
        let start=region.location+NSMaxRange(stream.range)
        guard start>=0,length>0,start+length<=input.count else { throw NSError(domain:"PrototypePDF",code:6,userInfo:[NSLocalizedDescriptionKey:"Invalid PDF stream bounds"]) }
        let decoded=try inflate(input.subdata(in:start..<(start+length)))
        guard var cmap=String(data:decoded,encoding:.ascii) else { continue }
        let font=CTFontCreateWithName(name as CFString,16,nil)
        guard (CTFontCopyPostScriptName(font) as String)==name else { throw NSError(domain:"PrototypePDF",code:7,userInfo:[NSLocalizedDescriptionKey:"Cannot resolve PDF font \(name)"]) }
        let candidates=Set((fontSources[name] ?? source).unicodeScalars.map(\.value).filter { isCJKScalar($0) })
        var byGlyph:[CGGlyph:Set<UInt32>]=[:]
        for c in candidates { if let g=glyph(c,font) { byGlyph[g,default:[]].insert(c) } }
        let original=cmap as NSString
        var destinations:[(NSRange,UInt32)]=[]
        for block in matches("(?s)begin(bfchar|bfrange)(.*?)end\\1",original) {
            let kind=original.substring(with:block.range(at:1)), bodyRange=block.range(at:2), body=original.substring(with:bodyRange) as NSString
            if kind == "bfrange" && body.contains("[") { throw NSError(domain:"PrototypePDF",code:11,userInfo:[NSLocalizedDescriptionKey:"Unsupported PDF Unicode array mapping"]) }
            let pattern = kind == "bfrange" ? "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?)>\\s*$" : "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?)>\\s*$"
            for m in matches(pattern,body) {
                let dest=m.range(at:kind == "bfrange" ? 3 : 2)
                var span:UInt32=0
                if kind == "bfrange" {
                    guard let first=UInt32(body.substring(with:m.range(at:1)),radix:16), let last=UInt32(body.substring(with:m.range(at:2)),radix:16), last>=first, last-first<=255 else { throw NSError(domain:"PrototypePDF",code:11,userInfo:[NSLocalizedDescriptionKey:"Unsupported PDF Unicode range"]) }
                    span=last-first
                }
                destinations.append((NSRange(location:bodyRange.location+dest.location,length:dest.length),span))
            }
        }
        var local=0
        for (dest,span) in destinations.reversed() {
            let digits=original.substring(with:dest);guard let startScalar=unicodeScalarFromHex(digits),startScalar+span<=0x10ffff else { continue }
            if digits.count==8 && span>0,let low=UInt16(digits.suffix(4),radix:16),UInt32(low)+span>0xdfff {throw NSError(domain:"PrototypePDF",code:11,userInfo:[NSLocalizedDescriptionKey:"Unsupported supplementary Unicode range"])}
            var values:[UInt32]=[];var modified=false
            for scalar in startScalar...startScalar+span {
                guard isCJKScalar(scalar) else { values.append(scalar);continue }
                guard let g=glyph(scalar,font), let choices=byGlyph[g], !choices.isEmpty else { throw NSError(domain:"PrototypePDF",code:12,userInfo:[NSLocalizedDescriptionKey:"Cannot match a PDF glyph to its source character"]) }
                if choices.count != 1 {
                    guard allowAmbiguous else { throw NSError(domain:"PrototypePDF",code:8,userInfo:[NSLocalizedDescriptionKey:"PDF font shares a glyph for distinct source characters; exact copying cannot be guaranteed"]) }
                    values.append(scalar);continue
                }
                guard let selected=choices.first else { throw NSError(domain:"PrototypePDF",code:8,userInfo:[NSLocalizedDescriptionKey:"PDF font has no source character"]) }
                values.append(selected);if selected != scalar { modified=true;local += 1 }
            }
            guard modified else { continue }
            let replacement:String, replacementRange:NSRange
            if span==0 { replacement=unicodeHex(values[0]);replacementRange=dest }
            else { replacement="["+values.map{"<"+unicodeHex($0)+">"}.joined()+"]";replacementRange=NSRange(location:dest.location-1,length:dest.length+2) }
            guard let range=Range(replacementRange,in:cmap) else { throw NSError(domain:"PrototypePDF",code:9,userInfo:[NSLocalizedDescriptionKey:"Cannot update PDF mapping"]) }
            cmap.replaceSubrange(range,with:replacement)
        }
        if local>0 {
            let compressed=try deflate(Data(cmap.utf8))
            updated[id]=compressed;changed += local
        }
    }
    guard !updated.isEmpty else { return (input,0) }
    guard let trailer=matches("(?s)trailer\\s*<<(.*?)>>\\s*startxref\\s*(\\d+)\\s*%%EOF",text).last,
          let previous=Int(text.substring(with:trailer.range(at:2))) else { throw NSError(domain:"PrototypePDF",code:10,userInfo:[NSLocalizedDescriptionKey:"Unsupported PDF trailer for text repair"]) }
    var dictionary=text.substring(with:trailer.range(at:1))
    guard !dictionary.contains("/Encrypt") else { throw NSError(domain:"PrototypePDF",code:13,userInfo:[NSLocalizedDescriptionKey:"Encrypted PDF cannot be repaired"]) }
    dictionary=dictionary.replacingOccurrences(of:"/Prev\\s+\\d+",with:"",options:.regularExpression)
    var output=input
    func append(_ string:String) { output.append(Data(string.utf8)) }
    append("\n");var offsets:[Int:Int]=[:]
    for id in updated.keys.sorted() {
        let compressed=updated[id]!;offsets[id]=output.count
        append("\(id) 0 obj\n<< /Length \(compressed.count) /Filter /FlateDecode >>\nstream\n")
        output.append(compressed);append("\nendstream\nendobj\n")
    }
    let xref=output.count;append("xref\n")
    for id in offsets.keys.sorted() { append("\(id) 1\n");append(String(format:"%010d 00000 n \n",offsets[id]!)) }
    append("trailer\n<<\(dictionary) /Prev \(previous) >>\nstartxref\n\(xref)\n%%EOF\n")
    return (output,changed)
}
