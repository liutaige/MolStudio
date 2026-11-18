import AppKit
import Foundation

/// Converts public agent Markdown, LaTeX math (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`),
/// and mhchem `\ce{...}` formulas into selectable AppKit `NSAttributedString`, while preserving raw text
/// and optional `renderedHtml` on `WorkspacePublicMessage` so custom host rich views never lose fidelity.
enum WorkspaceAgentMessageFormatter {
    private static let latexSymbols: [String: String] = [
        "\\Delta": "Δ", "\\delta": "δ", "\\alpha": "α", "\\beta": "β", "\\gamma": "γ",
        "\\epsilon": "ε", "\\zeta": "ζ", "\\eta": "η", "\\theta": "θ", "\\kappa": "κ",
        "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\pi": "π", "\\rho": "ρ",
        "\\sigma": "σ", "\\tau": "τ", "\\phi": "φ", "\\chi": "χ", "\\psi": "ψ",
        "\\omega": "ω", "\\Omega": "Ω", "\\Sigma": "Σ", "\\Phi": "Φ", "\\Psi": "Ψ",
        "\\rightarrow": "→", "\\to": "→", "\\leftarrow": "←", "\\leftrightarrow": "↔",
        "\\rightleftharpoons": "⇌", "\\Rightarrow": "⇒", "\\Leftrightarrow": "⇔",
        "\\cdot": "·", "\\times": "×", "\\div": "÷", "\\pm": "±", "\\mp": "∓",
        "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠",
        "\\approx": "≈", "\\equiv": "≡", "\\propto": "∝", "\\infty": "∞",
        "\\circ": "°", "\\degree": "°", "\\partial": "∂", "\\nabla": "∇",
        "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\sqrt": "√",
        "\\hbar": "ℏ", "\\angstrom": "Å", "\\AA": "Å",
        "\\ln": "ln", "\\log": "log", "\\exp": "exp",
        "\\sin": "sin", "\\cos": "cos", "\\tan": "tan", "\\lim": "lim"
    ]

    static func containsFormulaSyntax(_ text: String) -> Bool {
        text.contains("\\ce{") || text.contains("$") || text.contains("\\(") || text.contains("\\[")
    }

    static func formatAttributedString(
        from message: WorkspacePublicMessage,
        baseFont: NSFont = .systemFont(ofSize: 12.5),
        textColor: NSColor = .labelColor,
        secondaryColor: NSColor = .secondaryLabelColor,
        linkColor: NSColor = .linkColor
    ) -> NSAttributedString {
        formatAttributedString(
            from: message.text,
            baseFont: baseFont,
            textColor: textColor,
            secondaryColor: secondaryColor,
            linkColor: linkColor
        )
    }

    /// Renders raw Markdown + LaTeX + `\ce{...}` formulas into an `NSAttributedString`.
    /// HTML tags in Markdown remain literal text (`html: false` semantics), and only `http`/`https` links become clickable.
    static func formatAttributedString(
        from rawText: String,
        baseFont: NSFont = .systemFont(ofSize: 12.5),
        textColor: NSColor = .labelColor,
        secondaryColor: NSColor = .secondaryLabelColor,
        linkColor: NSColor = .linkColor
    ) -> NSAttributedString {
        let output = NSMutableAttributedString()
        let lines = rawText.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")

        var index = 0
        var inCodeBlock = false
        var codeLanguage = ""
        var codeBuffer: [String] = []
        var inDisplayMath = false
        var mathBuffer: [String] = []

        func appendNewlineIfNeeded() {
            if output.length > 0 && !output.string.hasSuffix("\n") {
                output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: textColor]))
            }
        }

        func flushCodeBlock() {
            appendNewlineIfNeeded()
            let codeFont = NSFont.monospacedSystemFont(ofSize: max(10.5, baseFont.pointSize - 1), weight: .regular)
            let para = NSMutableParagraphStyle()
            para.headIndent = 10
            para.firstLineHeadIndent = 10
            para.tailIndent = -8
            para.paragraphSpacing = 4

            if !codeLanguage.isEmpty {
                let capAttrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold),
                    .foregroundColor: secondaryColor,
                    .paragraphStyle: para,
                ]
                output.append(NSAttributedString(string: "\(codeLanguage)\n", attributes: capAttrs))
            }

            let joined = codeBuffer.joined(separator: "\n")
            let codeAttrs: [NSAttributedString.Key: Any] = [
                .font: codeFont,
                .foregroundColor: textColor,
                .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.28),
                .paragraphStyle: para,
            ]
            output.append(NSAttributedString(string: joined, attributes: codeAttrs))
            codeBuffer.removeAll()
            codeLanguage = ""
        }

        func flushDisplayMathBlock() {
            appendNewlineIfNeeded()
            let expr = mathBuffer.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            para.paragraphSpacing = 6
            para.paragraphSpacingBefore = 4
            let rendered = NSMutableAttributedString(attributedString: renderMathOrChemistrySegment(
                expr,
                isChemistry: expr.contains("\\ce{"),
                baseFont: NSFont.systemFont(ofSize: baseFont.pointSize + 1, weight: .medium),
                textColor: textColor
            ))
            rendered.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: rendered.length))
            output.append(rendered)
            mathBuffer.removeAll()
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if inCodeBlock {
                if trimmed.hasPrefix("```") {
                    flushCodeBlock()
                    inCodeBlock = false
                } else {
                    codeBuffer.append(line)
                }
                index += 1
                continue
            }

            if inDisplayMath {
                if trimmed == "$$" || trimmed == "\\]" {
                    flushDisplayMathBlock()
                    inDisplayMath = false
                } else {
                    mathBuffer.append(trimmed)
                }
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                inCodeBlock = true
                codeLanguage = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                codeBuffer.removeAll()
                index += 1
                continue
            }

            if trimmed == "$$" || trimmed == "\\[" {
                inDisplayMath = true
                mathBuffer.removeAll()
                index += 1
                continue
            }

            if (trimmed.hasPrefix("$$") && trimmed.hasSuffix("$$") && trimmed.count > 4)
                || (trimmed.hasPrefix("\\[") && trimmed.hasSuffix("\\]") && trimmed.count > 4) {
                let inner = String(trimmed.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
                mathBuffer = [inner]
                flushDisplayMathBlock()
                index += 1
                continue
            }

            if trimmed.isEmpty {
                appendNewlineIfNeeded()
                index += 1
                continue
            }

            appendNewlineIfNeeded()

            // Headings (#..####)
            if let headingMatch = matchHeading(trimmed) {
                let headingSize = max(baseFont.pointSize + 1, baseFont.pointSize + CGFloat(5 - headingMatch.level))
                let hFont = NSFont.systemFont(ofSize: headingSize, weight: .semibold)
                let para = NSMutableParagraphStyle()
                para.paragraphSpacing = 4
                para.paragraphSpacingBefore = 6
                let seg = NSMutableAttributedString(attributedString: renderInline(
                    headingMatch.body,
                    baseFont: hFont,
                    textColor: textColor,
                    linkColor: linkColor
                ))
                seg.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: seg.length))
                output.append(seg)
                index += 1
                continue
            }

            // Blockquote
            if trimmed.hasPrefix("> ") {
                let body = String(trimmed.dropFirst(2))
                let para = NSMutableParagraphStyle()
                para.headIndent = 12
                para.firstLineHeadIndent = 12
                para.paragraphSpacing = 3
                let seg = NSMutableAttributedString(string: "│ ", attributes: [.font: baseFont, .foregroundColor: secondaryColor])
                seg.append(renderInline(body, baseFont: baseFont, textColor: secondaryColor, linkColor: linkColor))
                seg.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: seg.length))
                output.append(seg)
                index += 1
                continue
            }

            // Unordered list
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                let body = String(trimmed.dropFirst(2))
                let para = NSMutableParagraphStyle()
                para.firstLineHeadIndent = 6
                para.headIndent = 18
                para.paragraphSpacing = 2
                let seg = NSMutableAttributedString(string: "• ", attributes: [.font: baseFont, .foregroundColor: secondaryColor])
                seg.append(renderInline(body, baseFont: baseFont, textColor: textColor, linkColor: linkColor))
                seg.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: seg.length))
                output.append(seg)
                index += 1
                continue
            }

            // Ordered list (e.g., "1. text")
            if let ordered = matchOrderedList(trimmed) {
                let para = NSMutableParagraphStyle()
                para.firstLineHeadIndent = 4
                para.headIndent = 22
                para.paragraphSpacing = 2
                let seg = NSMutableAttributedString(string: "\(ordered.prefix) ", attributes: [.font: baseFont, .foregroundColor: secondaryColor])
                seg.append(renderInline(ordered.body, baseFont: baseFont, textColor: textColor, linkColor: linkColor))
                seg.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: seg.length))
                output.append(seg)
                index += 1
                continue
            }

            let para = NSMutableParagraphStyle()
            para.paragraphSpacing = 3
            let seg = NSMutableAttributedString(attributedString: renderInline(
                line,
                baseFont: baseFont,
                textColor: textColor,
                linkColor: linkColor
            ))
            seg.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: seg.length))
            output.append(seg)
            index += 1
        }

        if inCodeBlock && !codeBuffer.isEmpty {
            flushCodeBlock()
        }
        if inDisplayMath && !mathBuffer.isEmpty {
            flushDisplayMathBlock()
        }

        return output
    }

    private static func matchHeading(_ trimmed: String) -> (level: Int, body: String)? {
        var count = 0
        for ch in trimmed {
            if ch == "#" { count += 1 } else { break }
        }
        guard (1...4).contains(count) else { return nil }
        let rest = trimmed.dropFirst(count)
        guard rest.first == " " else { return nil }
        return (count, String(rest.dropFirst()))
    }

    private static func matchOrderedList(_ trimmed: String) -> (prefix: String, body: String)? {
        var digits = ""
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex, trimmed[idx].isNumber {
            digits.append(trimmed[idx])
            idx = trimmed.index(after: idx)
        }
        guard !digits.isEmpty, idx < trimmed.endIndex, trimmed[idx] == "." else { return nil }
        let afterDot = trimmed.index(after: idx)
        guard afterDot < trimmed.endIndex, trimmed[afterDot] == " " else { return nil }
        return ("\(digits).", String(trimmed[trimmed.index(after: afterDot)...]))
    }

    /// Parses inline formatting: `` `code` ``, bare `\ce{...}`, `$...$`, `$$...$$`, `\(...\)`, `[text](url)`, `**bold**`, `*italic*`.
    private static func renderInline(
        _ text: String,
        baseFont: NSFont,
        textColor: NSColor,
        linkColor: NSColor
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var idx = text.startIndex
        var plainBuffer = ""

        func flushPlain() {
            guard !plainBuffer.isEmpty else { return }
            result.append(NSAttributedString(string: plainBuffer, attributes: [.font: baseFont, .foregroundColor: textColor]))
            plainBuffer = ""
        }

        while idx < text.endIndex {
            let rem = text[idx...]

            // Inline code `...`
            if text[idx] == "`" {
                let nextStart = text.index(after: idx)
                if let closeIdx = text[nextStart...].firstIndex(of: "`") {
                    flushPlain()
                    let codeText = String(text[nextStart..<closeIdx])
                    let codeFont = NSFont.monospacedSystemFont(ofSize: max(10.5, baseFont.pointSize - 0.5), weight: .regular)
                    result.append(NSAttributedString(
                        string: codeText,
                        attributes: [
                            .font: codeFont,
                            .foregroundColor: textColor,
                            .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.32),
                        ]
                    ))
                    idx = text.index(after: closeIdx)
                    continue
                }
            }

            // Bare \ce{...}
            if rem.hasPrefix("\\ce{") {
                if let braced = extractBalancedBraces(in: text, startingAt: text.index(idx, offsetBy: 3)) {
                    flushPlain()
                    result.append(renderChemistryExpression(braced.content, baseFont: baseFont, textColor: textColor))
                    idx = braced.afterClosingBrace
                    continue
                }
            }

            // Display/inline dollar math $$...$$ or $...$
            if text[idx] == "$" {
                let isDouble = rem.hasPrefix("$$")
                let delim = isDouble ? "$$" : "$"
                let searchStart = text.index(idx, offsetBy: delim.count)
                if let endRange = text.range(of: delim, range: searchStart..<text.endIndex) {
                    let expr = String(text[searchStart..<endRange.lowerBound])
                    if isDouble || !expr.trimmingCharacters(in: .whitespaces).isEmpty {
                        flushPlain()
                        result.append(renderMathOrChemistrySegment(
                            expr,
                            isChemistry: expr.contains("\\ce{"),
                            baseFont: baseFont,
                            textColor: textColor
                        ))
                        idx = endRange.upperBound
                        continue
                    }
                }
            }

            // \( ... \) inline math
            if rem.hasPrefix("\\(") {
                let searchStart = text.index(idx, offsetBy: 2)
                if let endRange = text.range(of: "\\)", range: searchStart..<text.endIndex) {
                    let expr = String(text[searchStart..<endRange.lowerBound])
                    flushPlain()
                    result.append(renderMathOrChemistrySegment(
                        expr,
                        isChemistry: expr.contains("\\ce{"),
                        baseFont: baseFont,
                        textColor: textColor
                    ))
                    idx = endRange.upperBound
                    continue
                }
            }

            // Safe Markdown link [label](https://...)
            if text[idx] == "[" {
                if let link = matchSafeMarkdownLink(in: text, from: idx) {
                    flushPlain()
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: baseFont,
                        .foregroundColor: linkColor,
                        .link: link.url,
                        .underlineStyle: NSUnderlineStyle.single.rawValue,
                    ]
                    result.append(NSAttributedString(string: link.label, attributes: attrs))
                    idx = link.afterCloseParen
                    continue
                }
            }

            // **bold**
            if rem.hasPrefix("**") {
                let searchStart = text.index(idx, offsetBy: 2)
                if let endRange = text.range(of: "**", range: searchStart..<text.endIndex) {
                    let body = String(text[searchStart..<endRange.lowerBound])
                    flushPlain()
                    let boldFont = NSFontManager.shared.convert(baseFont, toHaveTrait: .boldFontMask)
                    result.append(renderInline(body, baseFont: boldFont, textColor: textColor, linkColor: linkColor))
                    idx = endRange.upperBound
                    continue
                }
            }

            // *italic*
            if text[idx] == "*" && !rem.hasPrefix("**") {
                let searchStart = text.index(after: idx)
                if let endIdx = text[searchStart...].firstIndex(of: "*"), endIdx > searchStart {
                    let body = String(text[searchStart..<endIdx])
                    if !body.hasPrefix(" ") && !body.hasSuffix(" ") {
                        flushPlain()
                        let italicFont = NSFontManager.shared.convert(baseFont, toHaveTrait: .italicFontMask)
                        result.append(renderInline(body, baseFont: italicFont, textColor: textColor, linkColor: linkColor))
                        idx = text.index(after: endIdx)
                        continue
                    }
                }
            }

            plainBuffer.append(text[idx])
            idx = text.index(after: idx)
        }

        flushPlain()
        return result
    }

    private static func matchSafeMarkdownLink(in text: String, from openBracket: String.Index) -> (label: String, url: URL, afterCloseParen: String.Index)? {
        let afterOpen = text.index(after: openBracket)
        guard let closeBracket = text[afterOpen...].firstIndex(of: "]") else { return nil }
        let afterCloseBracket = text.index(after: closeBracket)
        guard afterCloseBracket < text.endIndex, text[afterCloseBracket] == "(" else { return nil }
        let urlStart = text.index(after: afterCloseBracket)
        guard let closeParen = text[urlStart...].firstIndex(of: ")") else { return nil }
        let label = String(text[afterOpen..<closeBracket])
        let urlStr = String(text[urlStart..<closeParen]).trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: urlStr),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return (label, url, text.index(after: closeParen))
    }

    private static func extractBalancedBraces(in text: String, startingAt openBrace: String.Index) -> (content: String, afterClosingBrace: String.Index)? {
        guard openBrace < text.endIndex, text[openBrace] == "{" else { return nil }
        var depth = 0
        var idx = openBrace
        while idx < text.endIndex {
            let ch = text[idx]
            if ch == "{" {
                depth += 1
            } else if ch == "}" {
                depth -= 1
                if depth == 0 {
                    let innerStart = text.index(after: openBrace)
                    let content = String(text[innerStart..<idx])
                    return (content, text.index(after: idx))
                }
            }
            idx = text.index(after: idx)
        }
        return nil
    }

    /// Renders `$...$` / `$$...$$` math and nested `\ce{...}` blocks into AppKit superscript/subscript attributed runs.
    static func renderMathOrChemistrySegment(
        _ expr: String,
        isChemistry: Bool,
        baseFont: NSFont,
        textColor: NSColor
    ) -> NSAttributedString {
        if isChemistry {
            let result = NSMutableAttributedString()
            var idx = expr.startIndex
            while idx < expr.endIndex {
                if expr[idx...].hasPrefix("\\ce{"),
                   let braced = extractBalancedBraces(in: expr, startingAt: expr.index(idx, offsetBy: 3)) {
                    result.append(renderChemistryExpression(braced.content, baseFont: baseFont, textColor: textColor))
                    idx = braced.afterClosingBrace
                } else {
                    if let ceRange = expr.range(of: "\\ce{", range: idx..<expr.endIndex) {
                        let prefix = String(expr[idx..<ceRange.lowerBound])
                        result.append(renderPureMathExpression(prefix, baseFont: baseFont, textColor: textColor))
                        idx = ceRange.lowerBound
                    } else {
                        let tail = String(expr[idx...])
                        result.append(renderPureMathExpression(tail, baseFont: baseFont, textColor: textColor))
                        break
                    }
                }
            }
            return result
        }
        return renderPureMathExpression(expr, baseFont: baseFont, textColor: textColor)
    }

    /// Formats mhchem `\ce{...}` content with proper arrows (`→`, `⇌`, `↔`), lowered formula subscripts, and raised charges.
    static func renderChemistryExpression(_ raw: String, baseFont: NSFont, textColor: NSColor) -> NSAttributedString {
        var normalized = raw
            .replacingOccurrences(of: "<=>>", with: " ⇌ ")
            .replacingOccurrences(of: "\\rightleftharpoons", with: " ⇌ ")
            .replacingOccurrences(of: "<=>", with: " ⇌ ")
            .replacingOccurrences(of: "<-->", with: " ↔ ")
            .replacingOccurrences(of: "->", with: " → ")
            .replacingOccurrences(of: "<-", with: " ← ")

        for (cmd, sym) in latexSymbols {
            normalized = normalized.replacingOccurrences(of: cmd, with: sym)
        }
        while normalized.contains("  ") {
            normalized = normalized.replacingOccurrences(of: "  ", with: " ")
        }

        let result = NSMutableAttributedString()
        let scriptFont = NSFont.systemFont(ofSize: max(8.5, baseFont.pointSize * 0.76), weight: baseFont.fontDescriptor.object(forKey: .face) as? String == "Bold" ? .bold : .regular)
        let normalAttrs: [NSAttributedString.Key: Any] = [.font: baseFont, .foregroundColor: textColor]
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: scriptFont,
            .foregroundColor: textColor,
            .baselineOffset: -baseFont.pointSize * 0.18,
        ]
        let supAttrs: [NSAttributedString.Key: Any] = [
            .font: scriptFont,
            .foregroundColor: textColor,
            .baselineOffset: baseFont.pointSize * 0.30,
        ]

        var idx = normalized.startIndex
        var prevChar: Character?
        while idx < normalized.endIndex {
            let ch = normalized[idx]

            // Explicit superscript `^{...}` or `^2-` / `^+` / `^-`
            if ch == "^" {
                let nextIdx = normalized.index(after: idx)
                if nextIdx < normalized.endIndex, normalized[nextIdx] == "{",
                   let braced = extractBalancedBraces(in: normalized, startingAt: nextIdx) {
                    result.append(NSAttributedString(string: braced.content, attributes: supAttrs))
                    idx = braced.afterClosingBrace
                    prevChar = "}"
                    continue
                }
                var endIdx = nextIdx
                while endIdx < normalized.endIndex && (normalized[endIdx].isNumber || normalized[endIdx] == "+" || normalized[endIdx] == "-" || normalized[endIdx] == "·") {
                    endIdx = normalized.index(after: endIdx)
                }
                if endIdx > nextIdx {
                    result.append(NSAttributedString(string: String(normalized[nextIdx..<endIdx]), attributes: supAttrs))
                    idx = endIdx
                    prevChar = normalized[normalized.index(before: endIdx)]
                    continue
                }
            }

            // Explicit subscript `_{...}` or `_n`
            if ch == "_" {
                let nextIdx = normalized.index(after: idx)
                if nextIdx < normalized.endIndex, normalized[nextIdx] == "{",
                   let braced = extractBalancedBraces(in: normalized, startingAt: nextIdx) {
                    result.append(NSAttributedString(string: braced.content, attributes: subAttrs))
                    idx = braced.afterClosingBrace
                    prevChar = "}"
                    continue
                }
                var endIdx = nextIdx
                while endIdx < normalized.endIndex && (normalized[endIdx].isNumber || normalized[endIdx].isLetter) {
                    endIdx = normalized.index(after: endIdx)
                }
                if endIdx > nextIdx {
                    result.append(NSAttributedString(string: String(normalized[nextIdx..<endIdx]), attributes: subAttrs))
                    idx = endIdx
                    prevChar = normalized[normalized.index(before: endIdx)]
                    continue
                }
            }

            // Implicit chemical subscript digits after an element letter or `)`/`]` (not leading stoichiometry after whitespace/+ )
            if ch.isNumber, let prev = prevChar, (prev.isLetter || prev == ")" || prev == "]") {
                var endIdx = idx
                while endIdx < normalized.endIndex && normalized[endIdx].isNumber {
                    endIdx = normalized.index(after: endIdx)
                }
                result.append(NSAttributedString(string: String(normalized[idx..<endIdx]), attributes: subAttrs))
                idx = endIdx
                prevChar = normalized[normalized.index(before: endIdx)]
                continue
            }

            if ch == "{" || ch == "}" {
                idx = normalized.index(after: idx)
                continue
            }

            result.append(NSAttributedString(string: String(ch), attributes: normalAttrs))
            prevChar = ch
            idx = normalized.index(after: idx)
        }

        return result
    }

    private static func renderPureMathExpression(_ raw: String, baseFont: NSFont, textColor: NSColor) -> NSAttributedString {
        var expanded = raw
        // Simplify `\frac{a}{b}` -> `a/b` cleanly without dropping tokens.
        while let fracRange = expanded.range(of: "\\frac{") {
            let openA = expanded.index(fracRange.lowerBound, offsetBy: 5)
            guard let num = extractBalancedBraces(in: expanded, startingAt: openA),
                  num.afterClosingBrace < expanded.endIndex,
                  expanded[num.afterClosingBrace] == "{",
                  let den = extractBalancedBraces(in: expanded, startingAt: num.afterClosingBrace) else {
                break
            }
            expanded.replaceSubrange(fracRange.lowerBound..<den.afterClosingBrace, with: "(\(num.content))/(\(den.content))")
        }

        for tag in ["\\text{", "\\mathrm{", "\\mathbf{", "\\mathit{"] {
            while let range = expanded.range(of: tag) {
                let openIdx = expanded.index(before: range.upperBound)
                guard let inner = extractBalancedBraces(in: expanded, startingAt: openIdx) else { break }
                expanded.replaceSubrange(range.lowerBound..<inner.afterClosingBrace, with: inner.content)
            }
        }

        for (cmd, sym) in latexSymbols {
            expanded = expanded.replacingOccurrences(of: cmd, with: sym)
        }

        let result = NSMutableAttributedString()
        let scriptFont = NSFont.systemFont(ofSize: max(8.5, baseFont.pointSize * 0.76))
        let normalAttrs: [NSAttributedString.Key: Any] = [.font: baseFont, .foregroundColor: textColor]
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: scriptFont,
            .foregroundColor: textColor,
            .baselineOffset: -baseFont.pointSize * 0.18,
        ]
        let supAttrs: [NSAttributedString.Key: Any] = [
            .font: scriptFont,
            .foregroundColor: textColor,
            .baselineOffset: baseFont.pointSize * 0.30,
        ]

        var idx = expanded.startIndex
        while idx < expanded.endIndex {
            let ch = expanded[idx]
            if ch == "^" || ch == "_" {
                let attrs = ch == "^" ? supAttrs : subAttrs
                let nextIdx = expanded.index(after: idx)
                if nextIdx < expanded.endIndex, expanded[nextIdx] == "{",
                   let braced = extractBalancedBraces(in: expanded, startingAt: nextIdx) {
                    result.append(NSAttributedString(string: braced.content, attributes: attrs))
                    idx = braced.afterClosingBrace
                    continue
                } else if nextIdx < expanded.endIndex {
                    let afterOne = expanded.index(after: nextIdx)
                    result.append(NSAttributedString(string: String(expanded[nextIdx..<afterOne]), attributes: attrs))
                    idx = afterOne
                    continue
                }
            }
            result.append(NSAttributedString(string: String(ch), attributes: normalAttrs))
            idx = expanded.index(after: idx)
        }

        return result
    }
}

/// Auto-sizing selectable `NSTextView` supporting rich Markdown/formula attributed strings and safe link opening.
final class WorkspaceRichMessageTextView: NSTextView {
    override var intrinsicContentSize: NSSize {
        guard let layoutManager, let textContainer else {
            return super.intrinsicContentSize
        }
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        return NSSize(width: NSView.noIntrinsicMetric, height: ceil(used.height) + 4)
    }

    override func didChangeText() {
        super.didChangeText()
        invalidateIntrinsicContentSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        invalidateIntrinsicContentSize()
    }
}

/// IME-aware AI composer (`NSTextView`): Return sends only when `hasMarkedText()` is false; Shift+Return inserts newline; native Undo/Clipboard enabled.
final class WorkspaceComposerTextView: NSTextView {
    var onSubmitRequested: (() -> Void)?
    var onTextDidChangeCallback: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }

        let isReturn = (event.keyCode == 36 || event.keyCode == 76)
        if isReturn {
            let flags = event.modifierFlags.intersection([.shift, .command, .option, .control])
            if flags.isEmpty {
                onSubmitRequested?()
                return
            }
            if flags == [.shift] {
                insertNewline(self)
                return
            }
        }
        super.keyDown(with: event)
    }

    override func didChangeText() {
        super.didChangeText()
        onTextDidChangeCallback?()
    }
}

/// Inline settings panel backed strictly by `WorkspacePublicConfig` and `WorkspaceSettingsSaveRequest`.
/// API key stays strictly inside an `NSSecureTextField`, is sent once on save, and is cleared immediately.
final class WorkspaceAgentSettingsView: NSView {
    private let providerPopup = NSPopUpButton()
    private let baseUrlField = NSTextField()
    private let modelField = NSTextField()
    let apiKeyField = NSSecureTextField()
    private let profilePopup = NSPopUpButton()
    private let effortPopup = NSPopUpButton()
    private let maxTokensField = NSTextField()

    let saveButton = NSButton(title: "保存设置", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)

    private var currentConfig = WorkspacePublicConfig()

    var onSaveRequested: ((WorkspaceSettingsSaveRequest) -> Void)?
    var onCloseRequested: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        setupLayout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func setupLayout() {
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 0.75
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor

        let header = NSTextField(labelWithString: "AI 模型接口设置")
        header.font = .systemFont(ofSize: 12.5, weight: .semibold)

        providerPopup.controlSize = .small
        providerPopup.addItems(withTitles: ["openai-compatible", "openai", "anthropic", "deepseek", "gemini"])

        baseUrlField.controlSize = .small
        baseUrlField.placeholderString = "https://api.example.com/v1"

        modelField.controlSize = .small
        modelField.placeholderString = "例如 gpt-5.4 / deepseek-chat"
        modelField.target = self
        modelField.action = #selector(modelOrProfileChanged(_:))

        apiKeyField.controlSize = .small
        apiKeyField.placeholderString = "留空保留已保存密钥（绝不落盘到状态中）"

        profilePopup.controlSize = .small
        profilePopup.addItems(withTitles: ["provider-default", "openai", "deepseek"])
        profilePopup.target = self
        profilePopup.action = #selector(modelOrProfileChanged(_:))

        effortPopup.controlSize = .small

        maxTokensField.controlSize = .small
        maxTokensField.placeholderString = "可选，例如 4096"

        saveButton.bezelStyle = .rounded
        saveButton.controlSize = .small
        saveButton.keyEquivalent = "\r"
        saveButton.target = self
        saveButton.action = #selector(saveClicked(_:))

        cancelButton.bezelStyle = .rounded
        cancelButton.controlSize = .small
        cancelButton.target = self
        cancelButton.action = #selector(cancelClicked(_:))

        let form = NSStackView(views: [
            header,
            labeledRow("接口类型", providerPopup),
            labeledRow("Base URL", baseUrlField),
            labeledRow("模型名称", modelField),
            labeledRow("API Key", apiKeyField),
            labeledRow("参数配置", profilePopup),
            labeledRow("推理强度", effortPopup),
            labeledRow("最大输出", maxTokensField),
        ])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 6
        form.translatesAutoresizingMaskIntoConstraints = false

        let buttons = NSStackView(views: [NSView(), cancelButton, saveButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        addSubview(form)
        addSubview(buttons)

        NSLayoutConstraint.activate([
            form.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            form.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            form.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),

            buttons.topAnchor.constraint(equalTo: form.bottomAnchor, constant: 10),
            buttons.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            buttons.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            buttons.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        rebuildEffortMenu(selectedEffort: "default")
    }

    private func labeledRow(_ title: String, _ control: NSView) -> NSView {
        let lbl = NSTextField(labelWithString: title)
        lbl.font = .systemFont(ofSize: 11, weight: .medium)
        lbl.textColor = .secondaryLabelColor
        lbl.translatesAutoresizingMaskIntoConstraints = false
        lbl.widthAnchor.constraint(equalToConstant: 64).isActive = true

        control.translatesAutoresizingMaskIntoConstraints = false
        let row = NSStackView(views: [lbl, control])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        return row
    }

    func applyPublicConfig(_ config: WorkspacePublicConfig, busy: Bool, running: Bool) {
        currentConfig = config
        if !config.provider.isEmpty {
            if providerPopup.indexOfItem(withTitle: config.provider) == -1 {
                providerPopup.addItem(withTitle: config.provider)
            }
            providerPopup.selectItem(withTitle: config.provider)
        }
        baseUrlField.stringValue = config.baseUrl
        modelField.stringValue = config.model
        if profilePopup.indexOfItem(withTitle: config.generation.profile) != -1 {
            profilePopup.selectItem(withTitle: config.generation.profile)
        }
        if let maxTok = config.generation.maxOutputTokens {
            maxTokensField.stringValue = "\(maxTok)"
        } else {
            maxTokensField.stringValue = ""
        }
        rebuildEffortMenu(selectedEffort: config.generation.effort)

        let editable = !busy && !running
        providerPopup.isEnabled = editable
        baseUrlField.isEditable = editable
        modelField.isEditable = editable
        apiKeyField.isEditable = editable
        profilePopup.isEnabled = editable
        effortPopup.isEnabled = editable
        maxTokensField.isEditable = editable
        saveButton.isEnabled = editable
    }

    /// Clears transient secret field immediately without logging or storing in state.
    func clearTransientSecretField() {
        apiKeyField.stringValue = ""
    }

    private func rebuildEffortMenu(selectedEffort: String) {
        let profile = profilePopup.titleOfSelectedItem ?? "provider-default"
        let model = modelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        var options = ["default"]
        if profile == "openai",
           let supportedForModel = currentConfig.generationCapabilities?.openaiModels[model],
           !supportedForModel.isEmpty {
            options.append(contentsOf: supportedForModel)
        } else if profile == "openai" {
            options.append(contentsOf: ["none", "low", "medium", "high", "xhigh", "max"])
        } else {
            options.append(contentsOf: ["low", "medium", "high"])
        }

        effortPopup.removeAllItems()
        effortPopup.addItems(withTitles: options)
        if effortPopup.indexOfItem(withTitle: selectedEffort) != -1 {
            effortPopup.selectItem(withTitle: selectedEffort)
        } else {
            effortPopup.selectItem(at: 0)
        }
    }

    @objc private func modelOrProfileChanged(_ sender: Any?) {
        let currentSelection = effortPopup.titleOfSelectedItem ?? "default"
        rebuildEffortMenu(selectedEffort: currentSelection)
    }

    @objc private func saveClicked(_ sender: Any?) {
        let provider = providerPopup.titleOfSelectedItem ?? "openai-compatible"
        let baseUrl = baseUrlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = modelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = profilePopup.titleOfSelectedItem ?? "provider-default"
        let effort = effortPopup.titleOfSelectedItem ?? "default"
        let parsedMaxTokens = Int(maxTokensField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))

        let request = WorkspaceSettingsSaveRequest(
            provider: provider,
            baseUrl: baseUrl,
            model: model,
            apiKey: secret.isEmpty ? nil : secret,
            generation: WorkspaceGenerationConfig(profile: profile, effort: effort, maxOutputTokens: parsedMaxTokens)
        )
        clearTransientSecretField()
        onSaveRequested?(request)
    }

    @objc private func cancelClicked(_ sender: Any?) {
        clearTransientSecretField()
        onCloseRequested?()
    }
}

/// Native AI Assistant view controller consuming `WorkspaceStateCoordinator.agentStore` (no second runtime).
/// Supports public timeline cards, collapsible model thinking, plan/tools/diagnostics JSON disclosure,
/// progress/checkpoint/usage status, recovery (`continue`/`stop`/`reset`), settings with transient API key,
/// and Markdown + LaTeX + `\ce{...}` display compatibility.
final class WorkspaceAgentViewController: NSViewController {
    let coordinator: WorkspaceStateCoordinator

    /// Optional rich custom view hook if host later embeds a dedicated KaTeX/HTML view for complex display equations.
    var customRichMessageViewProvider: ((WorkspacePublicMessage) -> NSView?)?

    private let statusLabel = NSTextField(labelWithString: "就绪")
    private let usageLabel = NSTextField(labelWithString: "")
    let settingsToggleButton = NSButton()
    let resetButton = NSButton()

    private let configNoticeBanner = NSView()
    private let configNoticeLabel = NSTextField(labelWithString: "请先在设置中配置模型与 API Key")
    private let configOpenSettingsButton = NSButton(title: "打开设置", target: nil, action: nil)

    private let errorBanner = NSView()
    private let errorBannerLabel = NSTextField(labelWithString: "")
    private let errorDismissButton = NSButton()

    private let progressBanner = NSView()
    private let progressBannerLabel = NSTextField(labelWithString: "")

    let settingsView = WorkspaceAgentSettingsView()
    private(set) var isSettingsVisible = false

    private let timelineScrollView = NSScrollView()
    private let timelineStack = NSStackView()

    private var expandedThinkingRunIds = Set<String>()
    private var expandedDiagnosticIds = Set<String>()
    private struct TimelineKey: Hashable {
        let id: String
        let occurrence: Int
    }
    private struct RenderedTimelineItem {
        let key: TimelineKey
        let item: WorkspaceAgentTimelineItem
        let view: NSView
        let widthConstraint: NSLayoutConstraint
    }
    private var renderedTimeline: [RenderedTimelineItem] = []
    private var renderedEmptyReady: Bool?
    private var invalidatedTimelineIds = Set<String>()
    private var timelineRefreshScheduled = false

    let stopButton = NSButton(title: "停止", target: nil, action: nil)
    let continueButton = NSButton(title: "继续执行", target: nil, action: nil)
    let sendButton = NSButton(title: "发送", target: nil, action: nil)

    let composerScrollView = NSScrollView()
    let composerTextView = WorkspaceComposerTextView()

    init(coordinator: WorkspaceStateCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
        coordinator.addObserver(self) { [weak self] in
            self?.refreshFromStore()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 600))
        view = root
        setupLayout(in: root)
        refreshFromStore()
    }

    func setSettingsVisible(_ visible: Bool) {
        isSettingsVisible = visible
        if isViewLoaded {
            settingsView.isHidden = !visible
            if visible {
                settingsView.applyPublicConfig(
                    coordinator.agentStore.config,
                    busy: coordinator.agentStore.settingsBusy,
                    running: coordinator.agentStore.running || coordinator.agentStore.pendingStart
                )
            } else {
                settingsView.clearTransientSecretField()
            }
        }
    }

    private func setupLayout(in root: NSView) {
        // Header Bar
        statusLabel.font = .systemFont(ofSize: 11.5, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail

        usageLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        usageLabel.textColor = .tertiaryLabelColor
        usageLabel.setContentHuggingPriority(.required, for: .horizontal)

        settingsToggleButton.bezelStyle = .accessoryBarAction
        settingsToggleButton.isBordered = true
        settingsToggleButton.image = WorkspaceIconHelper.symbolImage("slider.horizontal.3", accessibilityDescription: "AI 设置", pointSize: 12)
        settingsToggleButton.imagePosition = .imageOnly
        settingsToggleButton.toolTip = "模型与生成参数设置"
        settingsToggleButton.target = self
        settingsToggleButton.action = #selector(toggleSettingsClicked(_:))

        resetButton.bezelStyle = .accessoryBarAction
        resetButton.isBordered = true
        resetButton.image = WorkspaceIconHelper.symbolImage("plus.bubble", accessibilityDescription: "新对话", pointSize: 12)
        resetButton.imagePosition = .imageOnly
        resetButton.toolTip = "清空显示历史，开始新对话"
        resetButton.target = self
        resetButton.action = #selector(resetClicked(_:))

        let headerRow = NSStackView(views: [statusLabel, NSView(), usageLabel, settingsToggleButton, resetButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 6
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        // Config Notice Banner
        styleBanner(configNoticeBanner, color: NSColor.systemBlue.withAlphaComponent(0.10))
        configNoticeLabel.font = .systemFont(ofSize: 11.5)
        configNoticeLabel.maximumNumberOfLines = 2
        configOpenSettingsButton.bezelStyle = .rounded
        configOpenSettingsButton.controlSize = .mini
        configOpenSettingsButton.target = self
        configOpenSettingsButton.action = #selector(openSettingsClicked(_:))
        let noticeStack = NSStackView(views: [configNoticeLabel, NSView(), configOpenSettingsButton])
        noticeStack.orientation = .horizontal
        noticeStack.alignment = .centerY
        noticeStack.spacing = 6
        noticeStack.translatesAutoresizingMaskIntoConstraints = false
        configNoticeBanner.addSubview(noticeStack)
        pinAllEdges(noticeStack, inside: configNoticeBanner, inset: 8)

        // Error Banner
        styleBanner(errorBanner, color: NSColor.systemRed.withAlphaComponent(0.12))
        errorBannerLabel.font = .systemFont(ofSize: 11.5)
        errorBannerLabel.textColor = .systemRed
        errorBannerLabel.maximumNumberOfLines = 3
        errorDismissButton.bezelStyle = .accessoryBarAction
        errorDismissButton.isBordered = false
        errorDismissButton.image = WorkspaceIconHelper.symbolImage("xmark.circle.fill", accessibilityDescription: "关闭错误提示", pointSize: 12)
        errorDismissButton.imagePosition = .imageOnly
        errorDismissButton.target = self
        errorDismissButton.action = #selector(dismissErrorClicked(_:))
        let errorStack = NSStackView(views: [errorBannerLabel, NSView(), errorDismissButton])
        errorStack.orientation = .horizontal
        errorStack.alignment = .centerY
        errorStack.spacing = 6
        errorStack.translatesAutoresizingMaskIntoConstraints = false
        errorBanner.addSubview(errorStack)
        pinAllEdges(errorStack, inside: errorBanner, inset: 8)

        // Progress Banner
        styleBanner(progressBanner, color: NSColor.quaternaryLabelColor.withAlphaComponent(0.20))
        progressBannerLabel.font = .systemFont(ofSize: 11)
        progressBannerLabel.textColor = .secondaryLabelColor
        progressBannerLabel.maximumNumberOfLines = 3
        progressBannerLabel.translatesAutoresizingMaskIntoConstraints = false
        progressBanner.addSubview(progressBannerLabel)
        pinAllEdges(progressBannerLabel, inside: progressBanner, inset: 8)

        settingsView.isHidden = true
        settingsView.onSaveRequested = { [weak self] request in
            self?.coordinator.saveAgentSettings(request) { result in
                if case .success = result {
                    self?.setSettingsVisible(false)
                }
            }
        }
        settingsView.onCloseRequested = { [weak self] in
            self?.setSettingsVisible(false)
        }

        // Timeline ScrollView
        timelineScrollView.translatesAutoresizingMaskIntoConstraints = false
        timelineScrollView.hasVerticalScroller = true
        timelineScrollView.hasHorizontalScroller = false
        timelineScrollView.drawsBackground = false
        timelineScrollView.borderType = .noBorder

        timelineStack.orientation = .vertical
        timelineStack.alignment = .leading
        timelineStack.spacing = 10
        timelineStack.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 10, right: 10)
        timelineStack.translatesAutoresizingMaskIntoConstraints = false

        let docView = NSView()
        docView.translatesAutoresizingMaskIntoConstraints = false
        docView.addSubview(timelineStack)
        timelineScrollView.documentView = docView

        // Control Bar (Stop / Continue) + Composer
        stopButton.bezelStyle = .rounded
        stopButton.controlSize = .small
        stopButton.contentTintColor = .systemOrange
        stopButton.target = self
        stopButton.action = #selector(stopClicked(_:))

        continueButton.bezelStyle = .rounded
        continueButton.controlSize = .small
        continueButton.contentTintColor = .controlAccentColor
        continueButton.target = self
        continueButton.action = #selector(continueClicked(_:))

        sendButton.bezelStyle = .rounded
        sendButton.controlSize = .small
        sendButton.target = self
        sendButton.action = #selector(sendClicked(_:))

        composerTextView.isRichText = false
        composerTextView.allowsUndo = true
        composerTextView.font = .systemFont(ofSize: 12.5)
        composerTextView.textContainerInset = NSSize(width: 6, height: 6)
        composerTextView.isVerticallyResizable = true
        composerTextView.isHorizontallyResizable = false
        composerTextView.textContainer?.widthTracksTextView = true
        composerTextView.onSubmitRequested = { [weak self] in
            self?.submitComposerText()
        }
        composerTextView.onTextDidChangeCallback = { [weak self] in
            self?.updateComposerButtonsEnabled()
        }

        composerScrollView.documentView = composerTextView
        composerScrollView.hasVerticalScroller = true
        composerScrollView.borderType = .bezelBorder
        composerScrollView.translatesAutoresizingMaskIntoConstraints = false

        let actionRow = NSStackView(views: [stopButton, continueButton, NSView(), sendButton])
        actionRow.orientation = .horizontal
        actionRow.alignment = .centerY
        actionRow.spacing = 6
        actionRow.translatesAutoresizingMaskIntoConstraints = false

        let topStack = NSStackView(views: [headerRow, configNoticeBanner, errorBanner, progressBanner, settingsView])
        topStack.orientation = .vertical
        topStack.alignment = .leading
        topStack.spacing = 6
        topStack.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(topStack)
        root.addSubview(timelineScrollView)
        root.addSubview(actionRow)
        root.addSubview(composerScrollView)

        NSLayoutConstraint.activate([
            topStack.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
            topStack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            topStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            headerRow.widthAnchor.constraint(equalTo: topStack.widthAnchor),
            configNoticeBanner.widthAnchor.constraint(equalTo: topStack.widthAnchor),
            errorBanner.widthAnchor.constraint(equalTo: topStack.widthAnchor),
            progressBanner.widthAnchor.constraint(equalTo: topStack.widthAnchor),
            settingsView.widthAnchor.constraint(equalTo: topStack.widthAnchor),

            timelineScrollView.topAnchor.constraint(equalTo: topStack.bottomAnchor, constant: 6),
            timelineScrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            timelineScrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),

            docView.leadingAnchor.constraint(equalTo: timelineScrollView.contentView.leadingAnchor),
            docView.trailingAnchor.constraint(equalTo: timelineScrollView.contentView.trailingAnchor),
            docView.topAnchor.constraint(equalTo: timelineScrollView.contentView.topAnchor),
            docView.widthAnchor.constraint(equalTo: timelineScrollView.contentView.widthAnchor),

            timelineStack.leadingAnchor.constraint(equalTo: docView.leadingAnchor),
            timelineStack.trailingAnchor.constraint(equalTo: docView.trailingAnchor),
            timelineStack.topAnchor.constraint(equalTo: docView.topAnchor),
            timelineStack.bottomAnchor.constraint(equalTo: docView.bottomAnchor),

            actionRow.topAnchor.constraint(equalTo: timelineScrollView.bottomAnchor, constant: 6),
            actionRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            actionRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),

            composerScrollView.topAnchor.constraint(equalTo: actionRow.bottomAnchor, constant: 6),
            composerScrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            composerScrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            composerScrollView.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -10),
            composerScrollView.heightAnchor.constraint(equalToConstant: 72),
        ])
    }

    private func styleBanner(_ banner: NSView, color: NSColor) {
        banner.wantsLayer = true
        banner.layer?.cornerRadius = 8
        banner.layer?.backgroundColor = color.cgColor
        banner.translatesAutoresizingMaskIntoConstraints = false
    }

    private func pinAllEdges(_ child: NSView, inside parent: NSView, inset: CGFloat) {
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset),
            child.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset),
            child.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset),
            child.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset),
        ])
    }

    func refreshFromStore() {
        guard isViewLoaded else { return }
        let store = coordinator.agentStore

        var statusParts = [store.statusText]
        if let sec = store.elapsedSeconds, sec > 0 {
            statusParts.append("\(sec)s")
        }
        statusLabel.stringValue = statusParts.joined(separator: " · ")
        statusLabel.toolTip = store.generationTooltip
        usageLabel.stringValue = store.usageSummary
        usageLabel.toolTip = store.usageDetailTooltip.isEmpty ? nil : store.usageDetailTooltip

        configNoticeBanner.isHidden = !store.configNoticeVisible
        if let notice = store.config.notice, !notice.isEmpty {
            configNoticeLabel.stringValue = notice
        } else {
            configNoticeLabel.stringValue = "请先在设置中配置模型与 API Key"
        }

        if let err = store.errorMessage, !err.isEmpty {
            errorBanner.isHidden = false
            errorBannerLabel.stringValue = err
        } else {
            errorBanner.isHidden = true
        }

        var progressLines: [String] = []
        if let t = store.transportProgressText, !t.isEmpty { progressLines.append(t) }
        if let p = store.taskProgressText, !p.isEmpty { progressLines.append(p) }
        if let cp = store.checkpoint {
            let phaseInfo = cp.phases?.compactMap { phase -> String? in
                guard let obj = phase.objective, !obj.isEmpty else { return nil }
                return "\(phase.status ?? "pending"): \(obj)"
            }.joined(separator: " / ") ?? ""
            if let goal = cp.goal, !goal.isEmpty {
                progressLines.append(phaseInfo.isEmpty ? "目标：\(goal)" : "目标：\(goal) (\(phaseInfo))")
            } else if !phaseInfo.isEmpty {
                progressLines.append(phaseInfo)
            }
        }
        progressBanner.isHidden = progressLines.isEmpty
        progressBannerLabel.stringValue = progressLines.joined(separator: "\n")

        if store.shouldOpenSettings {
            store.acknowledgeSettingsOpened()
            setSettingsVisible(true)
        } else if isSettingsVisible {
            settingsView.applyPublicConfig(
                store.config,
                busy: store.settingsBusy,
                running: store.running || store.pendingStart
            )
        }

        scheduleTimelineRefresh()
        updateComposerButtonsEnabled()
    }

    private func updateComposerButtonsEnabled() {
        let store = coordinator.agentStore
        let surfaceOwned = coordinator.ownsSurface(.agent)
        let ready = coordinator.isAgentSurfaceReady()
        let isRunning = store.running || store.pendingStart

        settingsToggleButton.isEnabled = surfaceOwned && coordinator.isCommandSupported("agent.settings.load")
        resetButton.isEnabled = ready && coordinator.isCommandSupported("agent.reset") && !isRunning

        stopButton.isHidden = !isRunning
        stopButton.isEnabled = surfaceOwned && coordinator.isCommandSupported("agent.stop") && isRunning && !store.stopRequested

        let canShowContinue = store.canContinue && !isRunning
        continueButton.isHidden = !canShowContinue
        continueButton.isEnabled = ready && coordinator.isCommandSupported("agent.continue") && canShowContinue

        let hasText = !composerTextView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        composerTextView.isEditable = ready && !isRunning
        sendButton.isEnabled = ready && coordinator.isCommandSupported("agent.send") && !isRunning && hasText
    }

    private func scheduleTimelineRefresh() {
        guard !timelineRefreshScheduled else { return }
        timelineRefreshScheduled = true
        // Stream chunks often arrive in bursts. Render the latest snapshot at
        // most once per frame interval, including the final chunk of a burst.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 30.0) { [weak self] in
            guard let self else { return }
            self.timelineRefreshScheduled = false
            self.rebuildTimeline()
        }
    }

    private func rebuildTimeline() {
        let items = coordinator.agentStore.timeline
        if invalidatedTimelineIds.isEmpty,
           items.count == renderedTimeline.count,
           !items.isEmpty,
           zip(items, renderedTimeline).allSatisfy({ pair in pair.0 == pair.1.item }) { return }
        if items.isEmpty {
            let ready = coordinator.isAgentSurfaceReady()
            guard !renderedTimeline.isEmpty || renderedEmptyReady != ready else { return }
            timelineStack.arrangedSubviews.forEach {
                timelineStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            renderedTimeline.removeAll()
            invalidatedTimelineIds.removeAll()
            renderedEmptyReady = ready
            let emptyLabel = NSTextField(labelWithString: ready
                ? "描述要绘制的分子或反应"
                : "AI 助手正在准备就绪…")
            emptyLabel.font = .systemFont(ofSize: 12)
            emptyLabel.textColor = .secondaryLabelColor
            emptyLabel.maximumNumberOfLines = 4
            timelineStack.addArrangedSubview(emptyLabel)
            emptyLabel.widthAnchor.constraint(equalTo: timelineStack.widthAnchor, constant: -20).isActive = true
            return
        }

        if renderedEmptyReady != nil {
            timelineStack.arrangedSubviews.forEach {
                timelineStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            renderedEmptyReady = nil
        }

        // A notification can be unrelated to the conversation (for example a
        // viewport change). Keep existing cards and their text views whenever
        // the corresponding public timeline item has not changed.
        var previous = Dictionary(uniqueKeysWithValues: renderedTimeline.map { ($0.key, $0) })
        var occurrences: [String: Int] = [:]
        var arranged = timelineStack.arrangedSubviews
        var next: [RenderedTimelineItem] = []
        for (index, entry) in items.enumerated() {
            let occurrence = occurrences[entry.id, default: 0]
            occurrences[entry.id] = occurrence + 1
            let key = TimelineKey(id: entry.id, occurrence: occurrence)
            let old = previous.removeValue(forKey: key)
            let card: NSView
            let widthConstraint: NSLayoutConstraint
            if let old, old.item == entry, !invalidatedTimelineIds.contains(entry.id) {
                card = old.view
                widthConstraint = old.widthConstraint
            } else {
                if let old {
                    old.widthConstraint.isActive = false
                    timelineStack.removeArrangedSubview(old.view)
                    old.view.removeFromSuperview()
                    if let oldIndex = arranged.firstIndex(where: { $0 === old.view }) {
                        arranged.remove(at: oldIndex)
                    }
                }
                switch entry {
                case .userMessage(let msg): card = makeUserCard(message: msg)
                case .runTurn(let run, let messages): card = makeRunCard(run: run, messages: messages)
                }
                widthConstraint = card.widthAnchor.constraint(equalTo: timelineStack.widthAnchor, constant: -20)
            }
            if index >= arranged.count || arranged[index] !== card {
                widthConstraint.isActive = false
                if card.superview != nil {
                    timelineStack.removeArrangedSubview(card)
                    if let oldIndex = arranged.firstIndex(where: { $0 === card }) { arranged.remove(at: oldIndex) }
                }
                timelineStack.insertArrangedSubview(card, at: index)
                arranged.insert(card, at: index)
                widthConstraint.isActive = true
            }
            next.append(RenderedTimelineItem(key: key, item: entry, view: card, widthConstraint: widthConstraint))
        }
        for old in previous.values {
            old.widthConstraint.isActive = false
            timelineStack.removeArrangedSubview(old.view)
            old.view.removeFromSuperview()
        }
        renderedTimeline = next
        invalidatedTimelineIds.removeAll()
    }

    private func makeUserCard(message: WorkspacePublicMessage) -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.cornerRadius = 10
        card.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.14).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false

        let contentView = makeMessageContentView(message)
        card.addSubview(contentView)
        pinAllEdges(contentView, inside: card, inset: 8)
        return card
    }

    private func makeRunCard(run: WorkspacePublicRun, messages: [WorkspacePublicMessage]) -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.cornerRadius = 10
        card.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.72).cgColor
        card.layer?.borderWidth = 0.5
        card.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        pinAllEdges(stack, inside: card, inset: 8)

        if run.external {
            let ext = NSTextField(labelWithString: "外部会话 · \(run.clientName ?? "MCP")")
            ext.font = .systemFont(ofSize: 10.5, weight: .semibold)
            ext.textColor = .systemPurple
            stack.addArrangedSubview(ext)
        }

        // Collapsible Public Model Thinking
        let cleanThinking = run.thinkingText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanThinking.isEmpty {
            let expanded = expandedThinkingRunIds.contains(run.id)
            let toggleBtn = NSButton(
                title: expanded ? "▾ 思考过程" : "▸ 思考过程",
                target: self,
                action: #selector(toggleThinkingClicked(_:))
            )
            toggleBtn.bezelStyle = .accessoryBarAction
            toggleBtn.isBordered = false
            toggleBtn.font = .systemFont(ofSize: 11, weight: .semibold)
            toggleBtn.contentTintColor = .secondaryLabelColor
            toggleBtn.identifier = NSUserInterfaceItemIdentifier(run.id)
            stack.addArrangedSubview(toggleBtn)

            if expanded {
                let thinkLabel = makeSelectableTextView(attributedString: WorkspaceAgentMessageFormatter.formatAttributedString(
                    from: cleanThinking,
                    baseFont: .systemFont(ofSize: 11.5),
                    textColor: .secondaryLabelColor
                ))
                stack.addArrangedSubview(thinkLabel)
                thinkLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        }

        // Plan steps
        if !run.plan.isEmpty {
            let planBox = NSStackView()
            planBox.orientation = .vertical
            planBox.alignment = .leading
            planBox.spacing = 3
            for step in run.plan {
                let icon: String
                switch step.status {
                case .completed: icon = "✓"
                case .running: icon = "●"
                case .failed: icon = "✕"
                case .pending: icon = "○"
                }
                let lbl = NSTextField(labelWithString: "\(icon) \(step.text)")
                lbl.font = .systemFont(ofSize: 11.5)
                lbl.textColor = (step.status == .completed) ? .secondaryLabelColor : .labelColor
                lbl.maximumNumberOfLines = 3
                planBox.addArrangedSubview(lbl)
            }
            stack.addArrangedSubview(planBox)
            planBox.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // Tool calls & diagnostic disclosure
        for tool in run.tools {
            let toolRow = makeToolCallView(tool: tool)
            stack.addArrangedSubview(toolRow)
            toolRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // Messages
        for msg in messages {
            let contentView = makeMessageContentView(msg)
            stack.addArrangedSubview(contentView)
            contentView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // Status / recovery reason badge
        if run.finished, let reason = run.reason, !reason.isEmpty, reason != "completed" {
            let reasonLabel = NSTextField(labelWithString: friendlyReasonText(status: run.status, reason: reason))
            reasonLabel.font = .systemFont(ofSize: 11)
            reasonLabel.textColor = (run.status == "failed") ? .systemRed : .secondaryLabelColor
            reasonLabel.maximumNumberOfLines = 2
            stack.addArrangedSubview(reasonLabel)
        }

        return card
    }

    private func makeToolCallView(tool: WorkspacePublicToolCall) -> NSView {
        let box = NSStackView()
        box.orientation = .vertical
        box.alignment = .leading
        box.spacing = 2

        let badge: String
        switch tool.state {
        case .running: badge = "执行中"
        case .complete: badge = "完成"
        case .incomplete: badge = "未完成"
        case .failed: badge = "失败"
        case .stopped: badge = "已停止"
        }

        let headerText = tool.summary.isEmpty ? "\(tool.label) · \(badge)" : "\(tool.label) · \(badge)：\(tool.summary)"
        let title = NSTextField(labelWithString: headerText)
        title.font = .systemFont(ofSize: 11.5, weight: .medium)
        title.textColor = (tool.state == .failed) ? .systemRed : .secondaryLabelColor
        title.maximumNumberOfLines = 3
        box.addArrangedSubview(title)

        for change in tool.changes {
            let changeLabel = NSTextField(labelWithString: "  • \(change)")
            changeLabel.font = .systemFont(ofSize: 11)
            changeLabel.textColor = .secondaryLabelColor
            changeLabel.maximumNumberOfLines = 2
            box.addArrangedSubview(changeLabel)
        }

        if let diag = tool.diagnostic {
            let diagSummary = NSTextField(labelWithString: diag.formattedSummary())
            diagSummary.font = .systemFont(ofSize: 11)
            diagSummary.textColor = .systemOrange
            diagSummary.maximumNumberOfLines = 3
            box.addArrangedSubview(diagSummary)

            let expanded = expandedDiagnosticIds.contains(tool.id)
            let diagToggle = NSButton(
                title: expanded ? "▾ 隐藏诊断 JSON" : "▸ 查看诊断 JSON",
                target: self,
                action: #selector(toggleDiagnosticClicked(_:))
            )
            diagToggle.bezelStyle = .accessoryBarAction
            diagToggle.isBordered = false
            diagToggle.font = .systemFont(ofSize: 10.5, weight: .medium)
            diagToggle.identifier = NSUserInterfaceItemIdentifier(tool.id)
            box.addArrangedSubview(diagToggle)

            if expanded {
                let jsonView = NSTextField(labelWithString: diag.prettyJSONString())
                jsonView.isSelectable = true
                jsonView.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
                jsonView.textColor = .secondaryLabelColor
                jsonView.maximumNumberOfLines = 0
                box.addArrangedSubview(jsonView)
            }
        }

        return box
    }

    private func makeMessageContentView(_ message: WorkspacePublicMessage) -> NSView {
        if let customView = customRichMessageViewProvider?(message) {
            return customView
        }
        let attr = WorkspaceAgentMessageFormatter.formatAttributedString(from: message)
        return makeSelectableTextView(attributedString: attr)
    }

    private func makeSelectableTextView(attributedString: NSAttributedString) -> NSView {
        let tv = WorkspaceRichMessageTextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.drawsBackground = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.textContainerInset = NSSize(width: 0, height: 2)
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainer?.widthTracksTextView = true
        tv.textStorage?.setAttributedString(attributedString)
        tv.translatesAutoresizingMaskIntoConstraints = false
        return tv
    }

    private func friendlyReasonText(status: String?, reason: String) -> String {
        switch reason {
        case "stopped", "user_stop": return "已停止当前回合"
        case "recovery_scheduled": return "正在准备自动恢复重试…"
        case "recovery_exhausted": return "自动恢复次数已用尽，可点击“继续执行”重试"
        case "manual_edit": return "因画布手动编辑已暂停执行"
        default: return "状态：\(status ?? "")（\(reason)）"
        }
    }

    // MARK: - Actions

    @objc private func toggleThinkingClicked(_ sender: NSButton) {
        guard let runId = sender.identifier?.rawValue else { return }
        if expandedThinkingRunIds.contains(runId) {
            expandedThinkingRunIds.remove(runId)
        } else {
            expandedThinkingRunIds.insert(runId)
        }
        invalidatedTimelineIds.insert("run:\(runId)")
        rebuildTimeline()
    }

    @objc private func toggleDiagnosticClicked(_ sender: NSButton) {
        guard let toolId = sender.identifier?.rawValue else { return }
        if expandedDiagnosticIds.contains(toolId) {
            expandedDiagnosticIds.remove(toolId)
        } else {
            expandedDiagnosticIds.insert(toolId)
        }
        for item in coordinator.agentStore.timeline {
            if case .runTurn(let run, _) = item, run.tools.contains(where: { $0.id == toolId }) {
                invalidatedTimelineIds.insert(item.id)
            }
        }
        rebuildTimeline()
    }

    @objc private func toggleSettingsClicked(_ sender: Any?) {
        let next = !isSettingsVisible
        setSettingsVisible(next)
        if next {
            coordinator.loadAgentSettings()
        }
    }

    @objc private func openSettingsClicked(_ sender: Any?) {
        setSettingsVisible(true)
        coordinator.loadAgentSettings()
    }

    @objc private func dismissErrorClicked(_ sender: Any?) {
        coordinator.agentStore.dismissError()
    }

    @objc private func resetClicked(_ sender: Any?) {
        coordinator.resetAgent()
    }

    @objc private func stopClicked(_ sender: Any?) {
        coordinator.stopAgent()
    }

    @objc private func continueClicked(_ sender: Any?) {
        coordinator.continueAgent()
    }

    @objc private func sendClicked(_ sender: Any?) {
        submitComposerText()
    }

    private func submitComposerText() {
        let text = composerTextView.string
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              coordinator.isAgentSurfaceReady(),
              coordinator.isCommandSupported("agent.send"),
              !coordinator.agentStore.running,
              !coordinator.agentStore.pendingStart else {
            return
        }
        composerTextView.string = ""
        updateComposerButtonsEnabled()
        coordinator.sendAgentMessage(trimmed)
    }
}
