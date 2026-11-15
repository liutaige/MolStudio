import Foundation

/// One glyph occurrence verified against the frozen page geometry.
struct PDFResourceAssignment {
    let page:Int, operation:Int, arrayIndex:Int?, byteOffset:Int
    let bytes:[UInt8], fontResource:String, fontSize:Double, text:String
}
private func resourceError(_ message:String)->NSError {NSError(domain:"PrototypePDFResource",code:1,userInfo:[NSLocalizedDescriptionKey:message])}
private func html(_ text:NSString,_ pattern:String,_ group:Int=1)->String? {guard let m=matches(pattern,text).first else{return nil};return text.substring(with:m.range(at:group))}
private func pageObjectIDs(_ objects:[Int:NSString]) throws -> [Int] {
    guard let catalog=objects.values.first(where:{!matches("/Type\\s*/Catalog\\b",$0).isEmpty}),let root=html(catalog,"/Pages\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init) else{throw resourceError("Missing PDF page tree")}
    var result:[Int]=[],seen=Set<Int>()
    func visit(_ id:Int) throws {
        guard seen.insert(id).inserted,let obj=objects[id] else{throw resourceError("Invalid PDF page tree")}
        if !matches("/Type\\s*/Page(?!s)\\b",obj).isEmpty {result.append(id);return}
        guard !matches("/Type\\s*/Pages\\b",obj).isEmpty,let children=matches("(?s)/Kids\\s*\\[(.*?)\\]",obj).first else{throw resourceError("Unsupported PDF page tree")}
        let body=obj.substring(with:children.range(at:1)) as NSString,refs=matches("(\\d+)\\s+0\\s+R",body)
        guard !refs.isEmpty else{throw resourceError("Empty PDF page tree")}
        for ref in refs {guard let child=Int(body.substring(with:ref.range(at:1))) else{throw resourceError("Invalid page reference")};try visit(child)}
    }
    try visit(root);return result
}
private func getStream(_ object:NSString) throws -> Data {
    guard let n=html(object,"/Length\\s+(\\d+)").flatMap(Int.init),let marker=matches("stream\\r?\n",object).first else {throw resourceError("Unsupported PDF stream")}
    let start=NSMaxRange(marker.range);guard n>=0,start+n<=object.length else {throw resourceError("PDF stream length invalid")}
    guard let raw=object.substring(with:NSRange(location:start,length:n)).data(using:.isoLatin1) else {throw resourceError("Cannot decode PDF stream")}
    return object.contains("/FlateDecode") ? try inflate(raw) : raw
}
private func stringHex(_ text:String)->String {text.utf16.map{String(format:"%04X",$0)}.joined()}
private func mappedCMap(_ original:Data,code:[UInt8],text:String) throws -> Data {
    guard var map=String(data:original,encoding:.ascii),let key=UInt32(code.map{String(format:"%02X",$0)}.joined(),radix:16) else {throw resourceError("Unsupported font encoding")}
    let base=map as NSString;var target:NSRange?, replacement:String?
    for block in matches("(?s)begin(bfchar|bfrange)(.*?)end\\1",base) {
        let kind=base.substring(with:block.range(at:1)),section=block.range(at:2),body=base.substring(with:section) as NSString
        if kind == "bfrange" {
            for array in matches("(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*\\[([^\\]]*)\\]\\s*$",body) {
                guard let first=UInt32(body.substring(with:array.range(at:1)),radix:16),let last=UInt32(body.substring(with:array.range(at:2)),radix:16),last>=first,key>=first,key<=last else{continue}
                let inner=array.range(at:3),values=body.substring(with:inner) as NSString,items=matches("<([0-9a-fA-F]+)>",values),offset=Int(key-first)
                guard items.count==Int(last-first+1),offset<items.count else{throw resourceError("Invalid Unicode array mapping")}
                let dest=items[offset].range(at:1);target=NSRange(location:section.location+inner.location+dest.location,length:dest.length);replacement=stringHex(text);break
            }
            if target != nil {break}
        }
        let pattern=kind == "bfrange" ? "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*$" : "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*$"
        for m in matches(pattern,body) {
            guard let first=UInt32(body.substring(with:m.range(at:1)),radix:16) else {continue}
            let end=kind == "bfrange" ? UInt32(body.substring(with:m.range(at:2)),radix:16) : first
            guard let end,end>=first,key>=first,key<=end,end-first<=255 else{continue}
            let dest=m.range(at:kind == "bfrange" ? 3 : 2),destValue=body.substring(with:dest)
            if end==first {target=NSRange(location:section.location+dest.location,length:dest.length);replacement=stringHex(text)}
            else {
                guard let initial=unicodeScalarFromHex(destValue),initial+end-first<=0x10ffff else {throw resourceError("Unsupported multi-code font mapping")}
                var result="[";for i in first...end { result += "<"+(i==key ? stringHex(text):unicodeHex(initial+i-first))+">" };result+="]"
                target=NSRange(location:section.location+dest.location-1,length:dest.length+2);replacement=result
            }
            break
        }
        if target != nil {break}
    }
    guard let target,let replacement,let range=Range(target,in:map) else{throw resourceError("Cannot find glyph in font Unicode map")}
    map.replaceSubrange(range,with:replacement);return Data(map.utf8)
}
/// Clone existing PDF font dictionaries and Unicode maps while retaining their
/// embedded glyphs and metrics; switch fonts only for verified glyph occurrences.
func patchPDFResources(_ pdf:Data,assignments:[PDFResourceAssignment]) throws -> Data {
    guard !assignments.isEmpty else{return pdf}
    guard let str=String(data:pdf,encoding:.isoLatin1) else{throw resourceError("Cannot parse PDF")}
    let text=str as NSString,headers=matches("(?m)^(\\d+) 0 obj\\s",text);var objects:[Int:NSString]=[:]
    for (i,m) in headers.enumerated(){guard let id=Int(text.substring(with:m.range(at:1))) else{continue};let start=m.range.location,end=i+1<headers.count ? headers[i+1].range.location:text.length;objects[id]=text.substring(with:NSRange(location:start,length:end-start)) as NSString}
    guard let trailer=matches("(?s)trailer\\s*<<(.*?)>>\\s*startxref\\s*(\\d+)\\s*%%EOF",text).last,let prev=Int(text.substring(with:trailer.range(at:2))) else{throw resourceError("Unsupported PDF trailer")}
    var dictionary=text.substring(with:trailer.range(at:1));guard !dictionary.contains("/Encrypt") else{throw resourceError("Encrypted PDF unsupported")}
    guard let size=html(dictionary as NSString,"/Size\\s+(\\d+)").flatMap(Int.init) else{throw resourceError("Missing PDF size")};var next=size
    let pages=try pageObjectIDs(objects)
    var updates:[Int:Data]=[:];var serial=0
    for page in Set(assignments.map(\.page)).sorted() {
        guard page>=0,page<pages.count,let pageObject=objects[pages[page]],let rid=html(pageObject,"/Resources\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let cid=html(pageObject,"/Contents\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let resource=objects[rid],let content=objects[cid] else{throw resourceError("Unsupported PDF page resources")}
        guard let fontBlock=matches("(?s)/Font\\s*<<(.*?)>>",resource).first else{throw resourceError("Unsupported PDF font resources")}
        let fontBody=resource.substring(with:fontBlock.range(at:1)) as NSString,raw=try getStream(content),runs=try pdfTextRuns(raw)
        let newResources=next,newContents=next+1;next+=2
        var extra="", switches:[PDFTextFontReplacement]=[], aliases:[String:String]=[:]
        for item in assignments.filter({$0.page==page}) {
            guard item.fontSize.isFinite,item.fontSize>0,!item.bytes.isEmpty,!item.text.isEmpty,
                  let fontID=html(fontBody,"/"+NSRegularExpression.escapedPattern(for:item.fontResource)+"\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let font=objects[fontID],
                  let mapID=html(font,"/ToUnicode\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let cmap=objects[mapID] else{throw resourceError("Cannot resolve PDF font mapping")}
            let runCandidates=runs.enumerated().filter{$0.element.operation==item.operation && $0.element.arrayIndex==item.arrayIndex}
            guard runCandidates.count==1,let run=runCandidates.first,item.byteOffset>=0,item.byteOffset+item.bytes.count<=run.element.bytes.count,Array(run.element.bytes[item.byteOffset..<(item.byteOffset+item.bytes.count)])==item.bytes else{throw resourceError("PDF glyph stream does not match scanner")}
            let key="\(fontID):\(item.bytes.map{String(format:"%02X",$0)}.joined()):\(stringHex(item.text))"
            let alias:String
            if let existing=aliases[key] {alias=existing}
            else {
                serial+=1;alias="MSX\(serial)";guard html(fontBody,"/"+alias+"\\b",0)==nil else{throw resourceError("PDF font alias collision")}
                let newMap=next,newFont=next+1;next+=2
                let compressed=try deflate(mappedCMap(getStream(cmap),code:item.bytes,text:item.text))
                var stream=Data("<< /Length \(compressed.count) /Filter /FlateDecode >>\nstream\n".utf8);stream.append(compressed);stream.append(Data("\nendstream".utf8));updates[newMap]=stream
                guard let header=matches("(?s)^\\d+\\s+0\\s+obj\\s*(.*?)\\s*endobj",font).first else{throw resourceError("Cannot clone PDF font")}
                let body=font.substring(with:header.range(at:1));let mapped=body.replacingOccurrences(of:"/ToUnicode\\s+\\d+\\s+0\\s+R",with:"/ToUnicode \(newMap) 0 R",options:.regularExpression)
                guard mapped != body else{throw resourceError("Cannot update font Unicode reference")};updates[newFont]=Data(mapped.utf8)
                extra+=" /\(alias) \(newFont) 0 R";aliases[key]=alias
            }
            switches.append(PDFTextFontReplacement(run:run.offset,byteOffset:item.byteOffset,byteLength:item.bytes.count,font:alias,originalFont:item.fontResource,size:item.fontSize))
        }
        let newContent=try patchPDFTextFonts(raw,replacements:switches),packed=try deflate(newContent)
        var contentBody=Data("<< /Length \(packed.count) /Filter /FlateDecode >>\nstream\n".utf8);contentBody.append(packed);contentBody.append(Data("\nendstream".utf8));updates[newContents]=contentBody
        var resourceString=resource as String;guard let range=Range(NSRange(location:NSMaxRange(fontBlock.range(at:1)),length:0),in:resourceString) else{throw resourceError("Cannot update PDF resources")};resourceString.insert(contentsOf:extra,at:range.lowerBound)
        guard let header=matches("(?s)^\\d+\\s+0\\s+obj\\s*(.*?)\\s*endobj",resourceString as NSString).first else{throw resourceError("Cannot update PDF resource object")}
        updates[newResources]=Data((resourceString as NSString).substring(with:header.range(at:1)).utf8)
        guard let pageHeader=matches("(?s)^\\d+\\s+0\\s+obj\\s*(.*?)\\s*endobj",pageObject).first else{throw resourceError("Cannot clone PDF page")}
        let pageBody=pageObject.substring(with:pageHeader.range(at:1))
        let updatedPage=pageBody.replacingOccurrences(of:"/Resources\\s+\\d+\\s+0\\s+R",with:"/Resources \(newResources) 0 R",options:.regularExpression).replacingOccurrences(of:"/Contents\\s+\\d+\\s+0\\s+R",with:"/Contents \(newContents) 0 R",options:.regularExpression)
        guard updatedPage != pageBody else{throw resourceError("Cannot update PDF page")};updates[pages[page]]=Data(updatedPage.utf8)
    }
    dictionary=dictionary.replacingOccurrences(of:"/Prev\\s+\\d+",with:"",options:.regularExpression).replacingOccurrences(of:"/Size\\s+\\d+",with:"/Size \(next)",options:.regularExpression)
    var output=pdf;func append(_ s:String){output.append(Data(s.utf8))};append("\n");var offsets:[Int:Int]=[:]
    for id in updates.keys.sorted(){offsets[id]=output.count;append("\(id) 0 obj\n");output.append(updates[id]!);append("\nendobj\n")}
    let xref=output.count;append("xref\n");for id in offsets.keys.sorted(){append("\(id) 1\n");append(String(format:"%010d 00000 n \n",offsets[id]!))};append("trailer\n<<\(dictionary) /Prev \(prev) >>\nstartxref\n\(xref)\n%%EOF\n");return output
}

/// Read the Unicode mappings of page fonts from the Quartz-produced PDF.
func pdfPageFontMaps(_ pdf:Data,page:Int) throws -> [String:[Int:String]] {
    guard let raw=String(data:pdf,encoding:.isoLatin1) else{throw resourceError("Cannot parse PDF")}
    let text=raw as NSString,headers=matches("(?m)^(\\d+) 0 obj\\s",text);var objects:[Int:NSString]=[:]
    for (i,m) in headers.enumerated(){guard let id=Int(text.substring(with:m.range(at:1))) else{continue};let start=m.range.location,end=i+1<headers.count ? headers[i+1].range.location:text.length;objects[id]=text.substring(with:NSRange(location:start,length:end-start)) as NSString}
    let pages=try pageObjectIDs(objects)
    guard page>=0,page<pages.count,let p=objects[pages[page]],let rid=html(p,"/Resources\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let resources=objects[rid],let block=matches("(?s)/Font\\s*<<(.*?)>>",resources).first else{throw resourceError("Cannot find PDF page font resources")}
    let body=resources.substring(with:block.range(at:1)) as NSString;var output:[String:[Int:String]]=[:]
    for ref in matches("/([^\\s/<>]+)\\s+(\\d+)\\s+0\\s+R",body) {
        let name=body.substring(with:ref.range(at:1));guard let fid=Int(body.substring(with:ref.range(at:2))),let f=objects[fid],let mid=html(f,"/ToUnicode\\s+(\\d+)\\s+0\\s+R").flatMap(Int.init),let cmap=objects[mid],let map=String(data:try getStream(cmap),encoding:.ascii) else{continue}
        let text=map as NSString;var codes:[Int:String]=[:]
        for block in matches("(?s)begin(bfchar|bfrange)(.*?)end\\1",text) {
            let kind=text.substring(with:block.range(at:1)),body=text.substring(with:block.range(at:2)) as NSString
            let pattern=kind=="bfrange" ? "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?)>\\s*$" : "(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?)>\\s*$"
            if kind=="bfrange" {
                for array in matches("(?m)^\\s*<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*\\[([^\\]]*)\\]\\s*$",body) {
                    guard let start=Int(body.substring(with:array.range(at:1)),radix:16),let end=Int(body.substring(with:array.range(at:2)),radix:16),end>=start,end-start<=255 else{continue}
                    let inner=body.substring(with:array.range(at:3)) as NSString,values=matches("<([0-9a-fA-F]{4}(?:[0-9a-fA-F]{4})?)>",inner)
                    guard values.count==end-start+1 else{continue}
                    for (i,m) in values.enumerated(){if let value=unicodeScalarFromHex(inner.substring(with:m.range(at:1))),let scalar=UnicodeScalar(value){codes[start+i]=String(scalar)}}
                }
            }
            for m in matches(pattern,body) {
                guard let start=Int(body.substring(with:m.range(at:1)),radix:16),let end=(kind=="bfrange" ? Int(body.substring(with:m.range(at:2)),radix:16):start),let u=unicodeScalarFromHex(body.substring(with:m.range(at:kind=="bfrange" ? 3:2))),end>=start,end-start<=255 else{continue}
                for code in start...end {if let scalar=UnicodeScalar(u+UInt32(code-start)){codes[code]=String(scalar)}}
            }
        }
        output[name]=codes
    }
    return output
}
