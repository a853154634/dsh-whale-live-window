# 实况窗透明度助手（Windows 专用）。
#
# 实况窗的原生程序不画 alpha：它把 theme 的 surface 色画成实心底板，主题协议
# （--theme=scheme,accent,surface,foreground）也只认 6 位 RGB。
#
# Windows 允许给窗口加 WS_EX_LAYERED，再用 SetLayeredWindowAttributes 整窗调
# 不透明度。Node 没有内置 Win32 绑定，本插件又不引入原生依赖，所以用这个助手：
#
#   - 启动时用 Add-Type 编译一次 Win32 互操作；
#   - 之后常驻，从 stdin 读一行 JSON、发一行 JSON。
#
# 于是「拖动透明度滑块」只是一次 IPC 往返（毫秒级），而不是每次起一个进程。
#
# 协议：
#   请求  {"op":"setAlpha","pid":1234,"alpha":128,"id":7}
#   响应  {"ok":true,"id":7} 或 {"ok":false,"error":"...","id":7}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WhaleWindowAlpha {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtrW(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint crKey, byte bAlpha, uint dwFlags);

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_LAYERED = 0x80000;
    private const uint LWA_ALPHA = 0x2;

    /// Find the live window's main window.
    ///
    /// Filtering by pid matters — the process owns several helper windows (IME,
    /// GL pbuffers, hidden helpers) and only one of them is the real window.
    ///
    /// The title is matched when the caller supplies one, but that title is
    /// Chinese and the JSON travels through a console pipe, which mangles it
    /// (measured: the title arrives as mojibake and the JSON stops parsing).
    /// So the caller normally sends an empty title: the window is then picked
    /// by class + visibility + having a title, which identifies it just as
    /// reliably and keeps the protocol pure ASCII.
    public static IntPtr Find(uint pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p != pid) return true;
            var sb = new StringBuilder(256);
            GetWindowTextW(h, sb, 256);
            if (title != null && title.Length > 0) {
                if (sb.ToString() != title) return true;
            } else {
                if (sb.Length == 0) return true;
                if (!IsWindowVisible(h)) return true;
                var cn = new StringBuilder(256);
                GetClassNameW(h, cn, 256);
                if (cn.ToString() != "Window Class") return true;
            }
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    /// Set the whole-window opacity.
    ///
    /// SetLayeredWindowAttributes only works on a window that already carries
    /// WS_EX_LAYERED. The native window does not, so add the style first.
    public static bool SetAlpha(IntPtr h, byte alpha) {
        if (h == IntPtr.Zero) return false;
        long ex = (long)GetWindowLongW(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) == 0) {
            SetWindowLongPtrW(h, GWL_EXSTYLE, (IntPtr)(ex | WS_EX_LAYERED));
        }
        return SetLayeredWindowAttributes(h, 0, alpha, LWA_ALPHA);
    }
}
'@

$out = [Console]::Out
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = $null
    $ok = $false
    $failure = ''

    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id

        if ($req.op -eq 'ping') {
            $ok = $true
        } elseif ($req.op -eq 'setAlpha') {
            # The title is optional: a Chinese title gets mangled on the way
            # through the console pipe, so the host sends none and the helper
            # picks the main window by class + visibility + having a title.
            $title = ''
            if (($req.PSObject.Properties.Name -contains 'title') -and $req.title) {
                $title = [string]$req.title
            }
            $h = [WhaleWindowAlpha]::Find([uint32]$req.pid, $title)
            if ($h -eq [IntPtr]::Zero) {
                $failure = 'window not found'
            } else {
                $ok = [WhaleWindowAlpha]::SetAlpha($h, [byte]$req.alpha)
                if (-not $ok) { $failure = 'SetLayeredWindowAttributes failed' }
            }
        } else {
            $failure = 'unknown op'
        }
    } catch {
        $ok = $false
        $failure = $_.Exception.Message
    }

    # Build the reply by hand: assigning into a hashtable after the fact is
    # fine, but an `if` used as an expression unrolls the hashtable into an
    # array, which loses the id.
    $reply = New-Object System.Collections.Specialized.OrderedDictionary
    $reply['ok'] = $ok
    if ($failure -ne '') { $reply['error'] = $failure }
    if ($null -ne $id) { $reply['id'] = $id }
    $out.WriteLine(($reply | ConvertTo-Json -Compress))
    $out.Flush()
}
