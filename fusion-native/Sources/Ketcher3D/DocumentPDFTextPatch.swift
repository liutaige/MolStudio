import Foundation

/// A character occurrence inside the decoded bytes of one PDF text string.
struct PDFTextReplacement {
    let run:Int
    let byteOffset:Int
    let byteLength:Int
    let text:String
}
struct PDFTextRun { let operation:Int; let arrayIndex:Int?; let bytes:[UInt8] }
struct PDFTextFontReplacement {
    let run:Int, byteOffset:Int, byteLength:Int
    let font:String, originalFont:String, size:Double
}
private struct CharacterPatch { let run:Int, byteOffset:Int, byteLength:Int; let prefix:String, suffix:String }
private struct Token { let start:Int;let end:Int;let kind:String;let bytes:[UInt8] }
private func pdfError(_ message:String)->NSError { NSError(domain:"PrototypePDFText",code:1,userInfo:[NSLocalizedDescriptionKey:message]) }
private func isWhitespace(_ c:UInt8)->Bool { [0,9,10,12,13,32].contains(c) }
private func isDelimiter(_ c:UInt8)->Bool { isWhitespace(c) || [40,41,60,62,91,93,123,125,47,37].contains(c) }
private func lexPDF(_ input:[UInt8]) throws -> [Token] {
    var out:[Token]=[], i=0
    while i<input.count {
        if isWhitespace(input[i]) { i+=1;continue }
        if input[i]==37 { while i<input.count && input[i] != 10 && input[i] != 13 {i+=1};continue }
        let start=i,c=input[i]
        if c==40 {
            i+=1;var depth=1, value:[UInt8]=[]
            while i<input.count && depth>0 {
                let ch=input[i];i+=1
                if ch==92 {
                    guard i<input.count else {throw pdfError("Truncated PDF string escape")};let e=input[i];i+=1
                    switch e {
                    case 110:value.append(10);case 114:value.append(13);case 116:value.append(9);case 98:value.append(8);case 102:value.append(12)
                    case 10:break
                    case 13:if i<input.count && input[i]==10{i+=1}
                    case 48...55:
                        var n=Int(e-48),k=1
                        while k<3 && i<input.count && (48...55).contains(input[i]) {n=n*8+Int(input[i]-48);i+=1;k+=1}
                        value.append(UInt8(n & 255))
                    default:value.append(e)
                    }
                } else if ch==40 {depth+=1;value.append(ch)}
                else if ch==41 {depth-=1;if depth>0{value.append(ch)}}
                else {value.append(ch)}
            }
            guard depth==0 else {throw pdfError("Unterminated PDF string")}
            out.append(Token(start:start,end:i,kind:"string",bytes:value));continue
        }
        if c==60 && i+1<input.count && input[i+1] != 60 {
            i+=1;var digits:[UInt8]=[]
            while i<input.count && input[i] != 62 { if !isWhitespace(input[i]) {digits.append(input[i])};i+=1 }
            guard i<input.count else {throw pdfError("Unterminated hexadecimal string")};i+=1
            if digits.count%2 != 0 {digits.append(48)};var value:[UInt8]=[]
            for j in stride(from:0,to:digits.count,by:2) {guard let byte=UInt8(String(decoding:digits[j...j+1],as:UTF8.self),radix:16) else {throw pdfError("Invalid PDF hexadecimal string")};value.append(byte)}
            out.append(Token(start:start,end:i,kind:"string",bytes:value));continue
        }
        if c==91 || c==93 {i+=1;out.append(Token(start:start,end:i,kind:c==91 ? "[" : "]",bytes:[]));continue}
        if c==60 || c==62 {i+=1;if i<input.count && input[i]==c {i+=1};out.append(Token(start:start,end:i,kind:"delimiter",bytes:[]));continue}
        if c==47 {i+=1;while i<input.count && !isDelimiter(input[i]){i+=1};out.append(Token(start:start,end:i,kind:"name",bytes:Array(input[start..<i])));continue}
        if c==41 || c==123 || c==125 {i+=1;out.append(Token(start:start,end:i,kind:"delimiter",bytes:[]));continue}
        i+=1;while i<input.count && !isDelimiter(input[i]){i+=1}
        out.append(Token(start:start,end:i,kind:String(decoding:input[start..<i],as:UTF8.self),bytes:[]))
    }
    return out
}
private func hex(_ bytes:[UInt8])->String { bytes.map {String(format:"%02X",$0)}.joined() }
private func actual(_ value:String)->String { "FEFF"+value.utf16.map{String(format:"%04X",$0)}.joined() }
private struct TextOp {let range:Range<Int>;let parts:[Token];let array:Bool}
private func operations(_ tokens:[Token]) throws -> [TextOp] {
    var result:[TextOp]=[]
    for i in tokens.indices {
        let op=tokens[i]
        if op.kind=="BI" { throw pdfError("Inline PDF image streams require separate parsing") }
        if op.kind=="Tj" {
            guard i>0,tokens[i-1].kind=="string" else {throw pdfError("Invalid Tj operand")}
            result.append(TextOp(range:tokens[i-1].start..<op.end,parts:[tokens[i-1]],array:false))
        } else if op.kind=="TJ" {
            guard i>0,tokens[i-1].kind=="]" else {throw pdfError("Invalid TJ operand")}
            var j=i-1,level=1
            while j>0 && level>0 {j-=1;if tokens[j].kind=="]"{level+=1};if tokens[j].kind=="["{level-=1}}
            guard level==0 else {throw pdfError("Unterminated TJ array")}
            let parts=Array(tokens[(j+1)..<(i-1)])
            guard parts.allSatisfy({$0.kind=="string" || Double($0.kind) != nil}) else {throw pdfError("Unsupported TJ array operand")}
            result.append(TextOp(range:tokens[j].start..<op.end,parts:parts,array:true))
        } else if op.kind=="'" || op.kind=="\"" {throw pdfError("Unsupported shorthand PDF text operator")}
    }
    return result
}
/// Return decoded PDF string bytes in drawing order, without interpreting font encodings.
func pdfTextRuns(_ data:Data) throws -> [PDFTextRun] {
    var runs:[PDFTextRun]=[]
    for (index,op) in try operations(lexPDF([UInt8](data))).enumerated() {
        for (partIndex,part) in op.parts.enumerated() where part.kind=="string" { runs.append(PDFTextRun(operation:index+1,arrayIndex:op.array ? partIndex : nil,bytes:part.bytes)) }
    }
    return runs
}
/// Insert one ActualText tag for each verified character occurrence. The scanner must
/// verify font/code/geometry for every byte range before passing replacements here.
func patchPDFText(_ data:Data,replacements:[PDFTextReplacement]) throws -> Data {
    try patch(data, replacements:replacements.map { CharacterPatch(run:$0.run,byteOffset:$0.byteOffset,byteLength:$0.byteLength,prefix:"/Span << /ActualText <"+actual($0.text)+"> >> BDC ",suffix:" EMC") })
}
/// Split text operators and switch to an equivalent font resource whose ToUnicode
/// differs for this code; restore the original text font after each occurrence.
func patchPDFTextFonts(_ data:Data,replacements:[PDFTextFontReplacement]) throws -> Data {
    let safe=CharacterSet(charactersIn:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    for r in replacements {
        guard !r.font.isEmpty,!r.originalFont.isEmpty,r.font.unicodeScalars.allSatisfy({safe.contains($0)}),r.originalFont.unicodeScalars.allSatisfy({safe.contains($0)}),r.size.isFinite else {throw pdfError("Invalid PDF font switch")}
    }
    return try patch(data,replacements:replacements.map { CharacterPatch(run:$0.run,byteOffset:$0.byteOffset,byteLength:$0.byteLength,prefix:"/\($0.font) \($0.size) Tf ",suffix:" /\($0.originalFont) \($0.size) Tf") })
}
private func patch(_ data:Data,replacements:[CharacterPatch]) throws -> Data {
    let input=[UInt8](data),ops=try operations(lexPDF(input));var edits:[(Range<Int>,String)]=[],runIndex=0
    let grouped=Dictionary(grouping:replacements,by:{$0.run})
    for op in ops {
        var pieces:[String]=[],arrayParts:[String]=[],didChange=false
        func flushArray(){if !arrayParts.isEmpty{pieces.append("["+arrayParts.joined(separator:" ")+"] TJ");arrayParts=[]}}
        for part in op.parts {
            if part.kind != "string" {arrayParts.append(part.kind);continue}
            let replacements=(grouped[runIndex] ?? []).sorted{$0.byteOffset<$1.byteOffset};runIndex+=1
            guard !replacements.isEmpty else {if op.array {arrayParts.append("<"+hex(part.bytes)+">")}else{pieces.append("<"+hex(part.bytes)+"> Tj")};continue}
            didChange=true;var cursor=0
            for replacement in replacements {
                let end=replacement.byteOffset+replacement.byteLength
                guard replacement.byteLength>0,replacement.byteOffset>=cursor,end<=part.bytes.count else {throw pdfError("Invalid or overlapping PDF character replacement")}
                let prefix=Array(part.bytes[cursor..<replacement.byteOffset])
                if op.array {if !prefix.isEmpty {arrayParts.append("<"+hex(prefix)+">")};flushArray()}
                else if !prefix.isEmpty {pieces.append("<"+hex(prefix)+"> Tj")}
                let value=Array(part.bytes[replacement.byteOffset..<end]);pieces.append(replacement.prefix+"<"+hex(value)+"> Tj"+replacement.suffix)
                cursor=end
            }
            let suffix=Array(part.bytes[cursor...]);if !suffix.isEmpty {if op.array{arrayParts.append("<"+hex(suffix)+">")}else{pieces.append("<"+hex(suffix)+"> Tj")}}
        }
        if op.array {flushArray()}
        if didChange {edits.append((op.range,pieces.joined(separator:" ")))}
    }
    guard grouped.keys.allSatisfy({$0>=0 && $0<runIndex}) else {throw pdfError("PDF text run index out of range")}
    var output=Data(),cursor=0
    for (range,replacement) in edits {output.append(contentsOf:input[cursor..<range.lowerBound]);output.append(Data(replacement.utf8));cursor=range.upperBound}
    output.append(contentsOf:input[cursor...]);return output
}
