# 为什么窗口是空的：原生程序版本不匹配

## 现象

窗口能启动，但只有「探索未至之境」：没有会话、没有回复、没有审批。

## 实测证据

1. **窗口进程起来了，也显示出来了**，但 **stdout 一个字节都没有**。
   `$DSH_HOME/whale-live-window/diagnostics/last-startup.log` 记录：
   ```
   岛仔 0.6.64
   进程：24188
   启动阶段：目标屏幕物理坐标定位完成，已请求显示
   ```
   说明它按「普通主窗口」启动了，而不是按实况窗模式。

2. **该二进制不认 `--whale-live-window` 这个参数。**
   对照实验（同一个 exe）：
   - `daozai.exe --whale-live-window` → 进程存活、无 stdout
   - `daozai.exe`（无参数） → 不启动

   两者都不输出版协议需要的 `{"type":"ready"}`。

3. **上游源码里根本没有这个模式。**
   在 `xiaotang-daozai-main` 源码树里 grep `whale-live-window` / `whale_live_window` / `LiveWindow` —— **0 命中**。
   而 `src/main.rs:129-130` 里实际支持的参数是 `--settings` 与 `--calendar`。

## 结论

上游构建出的 `daozai.exe`（19,669,504 字节，0.6.64）是**官方上游版本**，
不含实况窗模式。之前能用的 19,956,224 字节那个版本（由鲸梦主题自带、
位于 `dsh-whale-dream/native/windows-x64/daozai.exe`）才带 `--whale-live-window`。

**这不是插件代码的问题**：插件按原版协议写 `--whale-live-window`、
等 `ready` 行，而程序不进入该模式、不回 `ready`，所以状态包一个都发不出去。

## 两个修好的办法

### 办法 A（推荐，立刻可用）：用带实况窗模式的那个二进制

```powershell
# 鲸梦主题包里自带的那个才支持实况窗（19,956,224 字节）
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-whale-dream\native\windows-x64\daozai.exe" `
          '.\bin\daozai.exe' -Force
```

然后重启 DSH。插件其它部分不用动。

### 办法 B：给上游补上实况窗模式

在 `xiaotang-daozai-main` 里实现 `--whale-live-window`：
行分隔 JSON 走 stdin/stdout（协议见下），窗口按顶部胶囊形态绘制。
这是上游工作量，不是本插件能替它做的。

## 协议（插件已在等待，供办法 B 参考）

宿主 → 窗口（stdin，每行一个 JSON）：
- `{type:"state", activeId, thinkingCount, waitingCount, idleBalance, completionSequence, sessions[], prefs, theme, draft?}`
- `{type:"watch-interaction", id}` / `{type:"watch-draft", id, lease}`
- `{type:"reply-result"|"interaction-result"|"draft-result", requestId, ok, error}`

窗口 → 宿主（stdout，每行一个 JSON）：
- `{type:"ready"}` ← **缺了这个，插件永远不推状态**
- `{type:"position", offset, topDisplay?}`
- `{type:"focus"|"select"|"open", id}` / `{type:"new"}`
- `{type:"reply", id, text, requestId}`
- `{type:"interaction", id, key, requestId, decision, answers?}`
- `{type:"draft", id, requestId, lease, action, revision, ...}`
- `{type:"close"}`

## 如何自行确认版本是否正确

```powershell
node scripts/window-probe.mjs
```

- 输出 `probe passed: ready handshake + state accepted` → 二进制正确
- 输出 `probe failed: no ready handshake` → 就是本文描述的版本不匹配
