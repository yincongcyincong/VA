using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

// Windows-only client adapter. It uses public accessibility patterns, never
// reads Doubao's profile, cookies, database or authentication information.
public static class WindowsDoubaoClient {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
    static readonly Regex ChatUrl = new Regex(@"^chrome://doubao-chat/chat/[0-9]+/?$", RegexOptions.IgnoreCase);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();

    sealed class ClientError : Exception {
        public string Code;
        public ClientError(string code, string message) : base(message) { Code = code; }
    }
    public sealed class Node {
        public int id, parent;
        public string kind, name, help, value, automationId, key;
        public bool enabled, offscreen, invoke, editable, focusable, textPattern;
        [ScriptIgnore] public AutomationElement element;
    }
    public sealed class Snapshot {
        public int pid;
        public string windowId, title, url, route;
        public List<Node> nodes = new List<Node>();
        [ScriptIgnore] public IntPtr handle;
    }
    static string StringValue(object value) { return value as string ?? ""; }
    static string Limit(string value, int max) { return value.Length <= max ? value : value.Substring(0, max); }
    static object Property(AutomationElement element, AutomationProperty property) {
        try { return element.GetCachedPropertyValue(property, true); } catch { return null; }
    }
    static bool Flag(AutomationElement element, AutomationProperty property) { return Object.Equals(Property(element, property), true); }
    static string Value(AutomationElement element) {
        try {
            var value = StringValue(element.GetCurrentPropertyValue(ValuePattern.ValueProperty, true));
            if (value.Length > 0) return value;
            object pattern;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(45001);
        } catch { }
        return "";
    }
    static string Key(AutomationElement element) { return String.Join(".", element.GetRuntimeId().Select(id => id.ToString()).ToArray()); }
    static void Visit(AutomationElement element, int parent, Snapshot snapshot) {
        if (snapshot.nodes.Count >= 2200) return;
        var type = Property(element, AutomationElement.ControlTypeProperty) as ControlType;
        var node = new Node { id = snapshot.nodes.Count, parent = parent, element = element,
            kind = type == null ? "" : type.ProgrammaticName.Replace("ControlType.", ""),
            name = Limit(StringValue(Property(element, AutomationElement.NameProperty)), 6000),
            help = Limit(StringValue(Property(element, AutomationElement.HelpTextProperty)), 1000),
            automationId = StringValue(Property(element, AutomationElement.AutomationIdProperty)),
            value = Limit(StringValue(Property(element, ValuePattern.ValueProperty)), 46000),
            enabled = Flag(element, AutomationElement.IsEnabledProperty),
            offscreen = Flag(element, AutomationElement.IsOffscreenProperty),
            invoke = Flag(element, AutomationElement.IsInvokePatternAvailableProperty),
            editable = Flag(element, AutomationElement.IsValuePatternAvailableProperty),
            focusable = Flag(element, AutomationElement.IsKeyboardFocusableProperty),
            textPattern = Flag(element, AutomationElement.IsTextPatternAvailableProperty), key = Key(element) };
        if (node.kind == "Group" && node.focusable && node.textPattern) node.value = Value(element);
        snapshot.nodes.Add(node);
        if (node.kind == "Document" && ChatUrl.IsMatch(node.value)) snapshot.url = node.value.TrimEnd('/');
        try { foreach (AutomationElement child in element.CachedChildren) Visit(child, node.id, snapshot); } catch (InvalidOperationException) { }
    }
    static Snapshot Inspect(string expected) {
        var candidates = Process.GetProcessesByName("Doubao");
        if (candidates.Length == 0) throw new ClientError("CLIENT_CLOSED", "请先打开本机豆包客户端，并打开一条聊天。");
        var conditions = candidates.Select(p => (Condition)new PropertyCondition(AutomationElement.ProcessIdProperty, p.Id)).ToArray();
        var windows = AutomationElement.RootElement.FindAll(TreeScope.Children,
            conditions.Length == 1 ? conditions[0] : new OrCondition(conditions));
        if (windows.Count == 0) throw new ClientError("CLIENT_CLOSED", "没有找到豆包聊天窗口，请先打开豆包。");
        var snapshots = new List<Snapshot>();
        foreach (AutomationElement window in windows) {
            var handle = new IntPtr(window.Current.NativeWindowHandle);
            var snapshot = new Snapshot { pid = window.Current.ProcessId, handle = handle, windowId = handle.ToInt64().ToString(), title = window.Current.Name, url = "" };
            {
                var cache = new CacheRequest();
                cache.TreeScope = TreeScope.Subtree;
                foreach (var property in new[] { AutomationElement.NameProperty, AutomationElement.HelpTextProperty, AutomationElement.ControlTypeProperty,
                    AutomationElement.AutomationIdProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
                    AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                    AutomationElement.IsKeyboardFocusableProperty, AutomationElement.IsTextPatternAvailableProperty, ValuePattern.ValueProperty }) cache.Add(property);
                Visit(window.GetUpdatedCache(cache), -1, snapshot);
            }
            snapshot.route = snapshot.pid + ":" + snapshot.windowId + ":" + snapshot.url;
            if (expected != null && snapshot.route == expected) return snapshot;
            snapshots.Add(snapshot);
        }
        if (expected != null) throw new ClientError("CLIENT_ROUTE", "当前豆包会话已改变，请切回绑定的对话，或重新绑定。");
        var chats = snapshots.Where(s => s.url.Length > 0).ToArray();
        if (chats.Length == 1) return chats[0];
        if (chats.Length > 1) throw new ClientError("CLIENT_ROUTE", "检测到多个豆包聊天窗口，请只保留一个需要绑定的窗口。");
        // Return the readable snapshot for diagnostics. The JS adapter refuses
        // to bind until a stable conversation URL is available.
        return snapshots.OrderByDescending(s => s.nodes.Count).First();
    }
    static string Normalize(string text) { return Regex.Replace(text ?? "", @"\s+", " ").Trim(); }
    static string Draft(AutomationElement element) {
        var value = Value(element).Trim();
        return value.StartsWith("发消息或按住空格说话") ? "" : value;
    }
    static bool Wait(Func<bool> condition, int milliseconds) {
        var watch = Stopwatch.StartNew();
        do { if (condition()) return true; Thread.Sleep(40); } while (watch.ElapsedMilliseconds < milliseconds);
        return false;
    }
    static void Invoke(Node node) {
        object pattern;
        if (!node.element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            throw new ClientError("CLIENT_INPUT", "豆包没有提供可用的按钮操作，请更新豆包客户端。");
        ((InvokePattern)pattern).Invoke();
    }
    static bool Focused(Snapshot snapshot, Node composer) {
        return GetForegroundWindow() == snapshot.handle && composer.element.Current.HasKeyboardFocus;
    }
    static bool Within(Node node, Node scope, Snapshot snapshot) {
        for (var parent = node.parent; parent >= 0;) {
            if (parent == scope.id) return true;
            parent = snapshot.nodes[parent].parent;
        }
        return false;
    }
    static Node SendButton(Snapshot snapshot, Node composer) {
        var current = snapshot.nodes.FirstOrDefault(n => n.key == composer.key);
        // Current Windows Doubao exposes the send arrow as an unnamed Invoke
        // button. Limit fallback to the nearest composer toolbar and require
        // exactly one candidate; never use a page-wide button index or point.
        for (int level = 0; current != null && current.parent >= 0 && level < 3; level++) {
            var scope = snapshot.nodes[current.parent];
            if (scope.kind == "Document" || scope.kind == "Window") break;
            var buttons = snapshot.nodes.Where(n => n.kind == "Button" && n.enabled && !n.offscreen && n.invoke && Within(n, scope, snapshot)).ToArray();
            if (buttons.Length > 0) {
                var named = buttons.Where(n => n.name == "发送" || n.name == "发送消息" || n.help == "发送" || n.help == "发送消息").ToArray();
                if (named.Length == 1) return named[0];
                if (named.Length > 1) return null;
                var candidates = buttons.Where(n => n.name.Length == 0 && n.focusable).ToArray();
                return candidates.Length == 1 ? candidates[0] : null;
            }
            current = scope;
        }
        return null;
    }
    static void Send(Snapshot snapshot, Node composer, string text) {
        if (String.IsNullOrWhiteSpace(text) || text.Length > 45000 || text.IndexOf('\0') >= 0)
            throw new ClientError("CLIENT_INPUT", "请输入有效的豆包消息，最多 45000 字。");
        var draft = Draft(composer.element);
        Func<bool> matches = () => Normalize(Draft(composer.element)) == Normalize(text);
        if (draft.Length > 0 && !matches()) throw new ClientError("CLIENT_DRAFT", "豆包输入框已有其他草稿，请先处理草稿。");
        Inspect(snapshot.route);
        if (draft.Length == 0) {
            object pattern;
            if (composer.element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) {
                try { ((ValuePattern)pattern).SetValue(text); } catch (InvalidOperationException) { }
            }
        }
        Node send = null;
        Func<bool> findSend = () => {
            var current = Inspect(snapshot.route);
            send = SendButton(current, composer);
            return send != null && matches();
        };
        if (!Wait(findSend, 400)) {
            try { composer.element.SetFocus(); } catch (InvalidOperationException) { }
            if (!Wait(() => Focused(snapshot, composer), 400)) {
                if (GetForegroundWindow() != snapshot.handle) SetForegroundWindow(snapshot.handle);
                composer.element.SetFocus();
                if (!Wait(() => Focused(snapshot, composer), 600))
                    throw new ClientError("CLIENT_INPUT", "Windows 未允许聚焦豆包，请把绑定的豆包对话放到前台后重试。");
            }
            Inspect(snapshot.route);
            draft = Draft(composer.element);
            if (draft.Length > 0 && !matches()) throw new ClientError("CLIENT_DRAFT", "豆包输入框已有其他草稿，请先处理草稿。");
            if (matches()) { SendKeys.SendWait("^a"); SendKeys.SendWait("{BACKSPACE}"); }
            if (!Wait(() => Focused(snapshot, composer) && Draft(composer.element).Length == 0, 500))
                throw new ClientError("CLIENT_INPUT", "无法准备豆包输入框，请检查草稿后重试。");
            var saved = Clipboard.GetDataObject();
            if (saved != null) {
                var backup = new DataObject();
                foreach (var format in saved.GetFormats(false)) {
                    var data = saved.GetData(format, false);
                    if (data != null) backup.SetData(format, data);
                }
                saved = backup;
            }
            Clipboard.SetText(text);
            var sequence = GetClipboardSequenceNumber();
            try {
                if (!Focused(snapshot, composer)) throw new ClientError("CLIENT_INPUT", "豆包输入框已失焦，请重新发送。");
                SendKeys.SendWait("^v");
                if (!Wait(findSend, 1000)) throw new ClientError("CLIENT_INPUT", "豆包没有接收到完整文字，请检查输入框。");
            } finally {
                if (GetClipboardSequenceNumber() == sequence) {
                    if (saved == null) Clipboard.Clear(); else Clipboard.SetDataObject(saved, true);
                }
            }
        }
        Inspect(snapshot.route);
        if (!matches()) throw new ClientError("CLIENT_DRAFT", "豆包草稿已变化，本次没有发送。");
        Invoke(send);
        if (!Wait(() => Draft(composer.element).Length == 0, 1200))
            throw new ClientError("CLIENT_SEND", "豆包未确认发送，请检查对话，避免重复发送。");
    }
    [STAThread] public static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var command = Json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            var op = command.ContainsKey("op") ? StringValue(command["op"]) : "";
            var expected = command.ContainsKey("route") ? StringValue(command["route"]) : null;
            var snapshot = Inspect(expected);
            if (op == "snapshot") { Console.Write(Json.Serialize(new { ok = true, data = snapshot })); return 0; }
            if (String.IsNullOrEmpty(snapshot.url) || String.IsNullOrEmpty(expected))
                throw new ClientError("CLIENT_ROUTE", "请先在豆包打开并绑定一条已有对话。");
            var key = command.ContainsKey("key") ? StringValue(command["key"]) : "";
            var node = snapshot.nodes.FirstOrDefault(n => n.key == key);
            if (node == null || !node.enabled || node.offscreen) throw new ClientError("CLIENT_INPUT", "豆包界面已变化，请重试。");
            if (op == "invoke") {
                if (node.kind != "Button" || !new[] { "朗读", "停止朗读", "暂停朗读" }.Contains(node.name))
                    throw new ClientError("CLIENT_INPUT", "无效的豆包朗读操作。");
                Invoke(node);
            } else if (op == "send" && (node.kind == "Edit" || (node.kind == "Group" && node.focusable && node.textPattern))) {
                Send(snapshot, node, command.ContainsKey("text") ? StringValue(command["text"]) : "");
            } else throw new ClientError("CLIENT_INPUT", "无效的豆包操作。");
            Console.Write(Json.Serialize(new { ok = true, data = new { } }));
        } catch (Exception error) {
            var detail = error as ClientError;
            Console.Write(Json.Serialize(new { ok = false, code = detail == null ? "CLIENT_HELPER" : detail.Code,
                message = detail == null ? "无法读取豆包的可访问性界面，请确认豆包已打开聊天，并且与 VA 使用相同的运行权限。" : detail.Message }));
        }
        return 0;
    }
}
