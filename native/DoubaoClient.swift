import AppKit
import ApplicationServices

private let bundleID = "com.bot.pc.doubao"

struct Command: Decodable {
    let op: String
    let route: String?
    let text: String?
}

struct ClientError: Error {
    let code: String
    let message: String
}

func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success ? result : nil
}

func element(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return (raw as! AXUIElement)
}

func children(_ item: AXUIElement) -> [AXUIElement] {
    value(item, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func role(_ item: AXUIElement) -> String {
    value(item, kAXRoleAttribute) as? String ?? ""
}

func label(_ item: AXUIElement) -> String {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
        if let text = value(item, key) as? String, !text.isEmpty { return text }
    }
    return ""
}

func visit(_ root: AXUIElement, limit: Int = 1600, _ inspect: (AXUIElement) -> Bool) {
    var stack = [root]
    var scanned = 0
    while let item = stack.popLast(), scanned < limit {
        scanned += 1
        if !inspect(item) { return }
        stack.append(contentsOf: children(item).reversed())
    }
}

func find(_ root: AXUIElement, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
    var selected: AXUIElement?
    visit(root) {
        if match($0) {
            selected = $0
            return false
        }
        return true
    }
    return selected
}

func textIn(_ group: AXUIElement) -> String {
    var parts: [String] = []
    visit(group, limit: 250) {
        if role($0) == kAXStaticTextRole, let text = value($0, kAXValueAttribute) as? String, !text.isEmpty {
            parts.append(text)
        }
        return true
    }
    return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func replyText(for speak: AXUIElement) -> String {
    var prior = speak
    for _ in 0..<5 {
        guard let parent = element(value(prior, kAXParentAttribute)) else { break }
        let preceding = children(parent).prefix(while: { !CFEqual($0, prior) })
        let text = preceding.map(textIn).filter { !$0.isEmpty }.joined(separator: "\n")
        if !text.isEmpty { return String(text.prefix(2000)) }
        prior = parent
    }
    return ""
}

private let readLabels = ["朗读", "停止朗读", "暂停朗读"]

func latestUserTurn(after speaker: AXUIElement?) -> [String: String]? {
    guard var prior = speaker else { return nil }
    for _ in 0..<4 {
        guard let parent = element(value(prior, kAXParentAttribute)) else { break }
        for item in children(parent).reversed() where role(item) == kAXGroupRole {
            let parts = children(item)
            let buttons = parts.filter { [kAXButtonRole, kAXPopUpButtonRole].contains(role($0)) }
            guard buttons.count >= 2, buttons.count <= 3, buttons.allSatisfy({ label($0).isEmpty }),
                  parts.contains(where: { role($0) == kAXStaticTextRole }),
                  find(item, { readLabels.contains(label($0)) }) == nil else { continue }
            let text = String(textIn(item).prefix(2200))
            guard !text.isEmpty else { continue }
            let id = value(item, "AXDOMIdentifier") as? String ?? value(item, kAXIdentifierAttribute) as? String
            return ["text": text, "id": id ?? ""]
        }
        prior = parent
    }
    return nil
}

func draftIn(_ composer: AXUIElement) -> String {
    let text = (value(composer, kAXValueAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return ["发消息或按住空格说话", "发消息或按住空格说话...", "发消息或按住空格说话…"].contains(text) ? "" : text
}

func waitFor<T>(_ condition: () -> T?, seconds: TimeInterval = 0.65) -> T? {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if let value = condition() { return value }
        RunLoop.current.run(until: Date().addingTimeInterval(0.04))
    } while Date() < deadline
    return nil
}

func postKey(_ key: CGKeyCode, command: Bool = false) {
    for pressed in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: pressed) else { continue }
        if command { event.flags = .maskCommand }
        event.post(tap: .cgSessionEventTap)
    }
}

func sendText(_ text: String, to composer: AXUIElement, in page: AXUIElement, app: NSRunningApplication,
              window: AXUIElement, root: AXUIElement) throws {
    // Chromium can expose line breaks as spaces in the accessible composer value.
    let words = text.split(whereSeparator: \.isWhitespace)
    let matchesDraft = { draftIn(composer).split(whereSeparator: \.isWhitespace) == words }
    let draft = draftIn(composer)
    guard draft.isEmpty || matchesDraft() else {
        throw ClientError(code: "CLIENT_DRAFT", message: "豆包聊天框已有其他草稿，请先处理草稿。")
    }
    let findSend = { find(page) { role($0) == kAXButtonRole && label($0) == "发送" &&
        (value($0, kAXEnabledAttribute) as? Bool) != false } }
    if draft.isEmpty {
        AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString)
    }
    if let button = waitFor(findSend), matchesDraft(),
       AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
        if waitFor({ draftIn(composer).isEmpty ? true : nil }) != nil { return }
    }
    // Chromium dispatches a real input event on paste, which makes the send button available.
    app.activate()
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let isFocused = {
        guard app.isActive, let focused = element(value(root, kAXFocusedUIElementAttribute)) else { return false }
        return CFEqual(focused, composer)
    }
    guard waitFor({ isFocused() ? true : nil }) != nil else {
        throw ClientError(code: "CLIENT_INPUT", message: "无法聚焦豆包输入框，请切回绑定的对话再试。")
    }
    guard draftIn(composer).isEmpty || matchesDraft() else {
        throw ClientError(code: "CLIENT_DRAFT", message: "豆包聊天框已有其他草稿，请先处理草稿。")
    }
    if matchesDraft() {
        // Clear only the draft that matches this request; reinsert it through an actual input event.
        postKey(0, command: true)
        postKey(51)
        guard waitFor({ isFocused() && draftIn(composer).isEmpty ? true : nil }) != nil else {
            throw ClientError(code: "CLIENT_INPUT", message: "无法更新豆包输入框。请在豆包里确认草稿后发送。")
        }
    }
    let clipboard = NSPasteboard.general
    let saved: [NSPasteboardItem] = (clipboard.pasteboardItems ?? []).map { item in
        let copy = NSPasteboardItem()
        for type in item.types {
            if let data = item.data(forType: type) { copy.setData(data, forType: type) }
        }
        return copy
    }
    clipboard.clearContents()
    clipboard.setString(text, forType: .string)
    let changeCount = clipboard.changeCount
    defer {
        if clipboard.changeCount == changeCount {
            clipboard.clearContents()
            if !saved.isEmpty { clipboard.writeObjects(saved as [any NSPasteboardWriting]) }
        }
    }
    guard isFocused() else {
        throw ClientError(code: "CLIENT_INPUT", message: "豆包输入框已失焦，请重新发送。")
    }
    postKey(9, command: true)
    guard let button = waitFor({ matchesDraft() ? findSend() : nil }), isFocused() else {
        throw ClientError(code: "CLIENT_INPUT", message: "豆包没有接收到粘贴的文字。")
    }
    AXUIElementPerformAction(button, kAXPressAction as CFString)
    if waitFor({ draftIn(composer).isEmpty ? true : nil }) != nil { return }
    if isFocused(), matchesDraft() {
        postKey(36)
        if waitFor({ draftIn(composer).isEmpty ? true : nil }, seconds: 1) != nil { return }
    }
    throw ClientError(code: "CLIENT_SEND", message: "豆包没有确认发送。请检查豆包输入框，再点击发送。")
}

func run(_ cmd: Command) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw ClientError(code: "AX_PERMISSION", message: "请在 macOS「隐私与安全性 → 辅助功能」允许 VA，然后再绑定。")
    }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
        throw ClientError(code: "CLIENT_CLOSED", message: "请先打开本机豆包客户端。")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1)
    let main = element(value(root, kAXFocusedWindowAttribute)) ?? element(value(root, kAXMainWindowAttribute))
        ?? (value(root, kAXWindowsAttribute) as? [AXUIElement])?.first
    guard let main, let page = find(main, { role($0) == "AXWebArea" }),
          let url = (value(page, kAXURLAttribute) as? URL)?.absoluteString ?? value(page, kAXURLAttribute) as? String,
          url.range(of: #"^chrome://doubao-chat/chat/[0-9]+/?$"#, options: .regularExpression) != nil else {
        throw ClientError(code: "CLIENT_ROUTE", message: "请在豆包里打开一条已有对话，再绑定当前对话。")
    }
    let route = url.hasSuffix("/") ? String(url.dropLast()) : url
    if let expected = cmd.route, route != expected {
        throw ClientError(code: "CLIENT_ROUTE", message: "请切回绑定的豆包对话。")
    }
    var speakers: [AXUIElement] = []
    var composer: AXUIElement?
    visit(page) {
        let kind = role($0)
        if kind == kAXButtonRole && readLabels.contains(label($0)) { speakers.append($0) }
        if kind == kAXTextAreaRole {
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable($0, kAXValueAttribute as CFString, &settable)
            if settable.boolValue { composer = $0 }
        }
        return true
    }
    switch cmd.op {
    case "inspect":
        let text = speakers.last.map(replyText) ?? ""
        let title = value(main, kAXTitleAttribute) as? String ?? "豆包"
        var result: [String: Any] = ["route": route, "title": title, "reply": text, "replyCount": speakers.count]
        if let turn = latestUserTurn(after: speakers.last) { result["userTurn"] = turn }
        return result
    case "read":
        guard let speak = speakers.last, label(speak) == "朗读",
              AXUIElementPerformAction(speak, kAXPressAction as CFString) == .success else {
            throw ClientError(code: "CLIENT_VOICE", message: "当前回复无法通过豆包客户端朗读。")
        }
    case "send":
        guard let composer, let text = cmd.text,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 2800 else {
            throw ClientError(code: "CLIENT_INPUT", message: "没有找到可用的豆包聊天输入框。")
        }
        try sendText(text.trimmingCharacters(in: .whitespacesAndNewlines), to: composer, in: page,
                     app: app, window: main, root: root)
    default:
        throw ClientError(code: "CLIENT_INPUT", message: "无效的豆包操作。")
    }
    return [:]
}

do {
    let command = try JSONDecoder().decode(Command.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let result = try run(command)
    let json = try JSONSerialization.data(withJSONObject: ["ok": true, "data": result])
    FileHandle.standardOutput.write(json)
} catch {
    let detail = error as? ClientError
    let result = ["ok": false, "code": detail?.code ?? "CLIENT_ERROR", "message": detail?.message ?? "豆包客户端操作失败。"] as [String: Any]
    if let json = try? JSONSerialization.data(withJSONObject: result) { FileHandle.standardOutput.write(json) }
}
