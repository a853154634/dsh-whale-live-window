# 用量账本：整段搬运 + 去依赖

## 背景

`dsh-whale-dream` 是自制品、问题多，已弃用。本插件不再依赖它运行时。

但「用量 / 花费 / 额度」这套账本是它的子系统里唯一值得保留的东西：
它用 `node:sqlite` 落盘，有真实历史记录（本机 207 条、8 个会话）。
直接丢掉会让实况窗永远显示「暂无用量」，所以整段搬进本包。

## 搬了什么

`lib/host/ledger/`（7 个文件，逐字，唯一改动是 `ledger-store.js` 里一行相对
import 指向本包的 `../verbatim/companion-usage.js`）：

| 文件 | 作用 |
| --- | --- |
| `ledger-client.js` | worker 线程客户端，可重入启动、超时、优雅关闭 |
| `ledger-worker.js` | worker 入口，持有 sqlite |
| `ledger-store.js` | 表结构、读写、迁移、导出 |
| `ledger-summary.js` | 按天/会话汇总 |
| `accounting.js` | 计费模式、账户归类 |
| `pricing-schedule.js` | 峰谷时段计价 |
| `constants.js` | 服务商常量（33 KB） |

许可证与来源一并保留：`LICENSE.bottom-info-bar`、`SOURCE.bottom-info-bar.json`。

## 数据目录

- 本插件：`$DSH_HOME/whale-live-window-info/usage-ledger.sqlite`
- 旧鲸梦：`$DSH_HOME/whale-dream-info/usage-ledger.sqlite`

首次启动时，若本插件目录还没有账本、而旧目录存在，会把
`usage-ledger.sqlite` **连同 -wal/-shm** 复制一份过来（只复制一次）。
之后两边各走各的，不会互相写。

## 用量显示规则（沿用原版 `formatCompanionUsage`）

| 账本数据 | 显示 |
| --- | --- |
| 有完整金额 | `¥1.2345`（多币种用 · 连接） |
| 无金额、有 Token | `1.7M Token` |
| 都没有 | `暂无用量` |

实测：`session-8c3691fb…` / provider `trae` → 17 次调用、1,695,165 Token → `1.7M Token`。

## 仍然做不到的

**账户额度与余额**（`quota` / `balance`）现在**已经实现**，按渠道类型分派，
见 [BALANCE.md](BALANCE.md)。剩下的限制只有一条：**并发时无法把账户级消耗
拆分到单个对话**——那是账户级数字，本对话级数字走请求次数（见下）。

## 费用栏现在是请求次数

原版费用栏显示账本里的金额或 Token 数。本插件改成**请求次数**：

- 宿主侧挂 `llm/stream` 钩子逐请求计数（`llm/stream` 的 options 带 `sessionId`）。
- 子代理的请求按会话谱系归并到主对话，所以「本对话消耗」含子代理。
- 计数是**进程内**的，重启归零；分钟/日两个窗口都按本地时钟滚动。

## 依赖状态

- `dsh-whale-dream` 已从 profile 的 `dependencies` 移除，包目录已删除。
- 本插件运行时不 import 它；仅 `lib/host/verbatim/*` 的文件头注明代码来源。
- 二进制已自持：`bin/daozai.exe`（18,167,808 字节，sha256 `a6db8fe7d6045f6e…`），
  与旧包里的那份逐字节相同。

## 测试

```powershell
npm test                       # 客户端激活 + 宿主路由 + 账本
node scripts/ledger.mjs        # 单独跑账本
```

`scripts/ledger.mjs` 覆盖：账本目录隔离、空账本的降级、三种格式化输出、
以及在一个**全新 HOME** 里验证迁移真的把记录带过来（先用过的 HOME 会因为
已有空账本而正确跳过迁移，这个细节本身也测到了）。
