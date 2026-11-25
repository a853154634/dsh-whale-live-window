# 余额与费用：按渠道分派

实况窗的「余额」和「费用」不是统一口径的东西：**余额是账户级的，费用是会话级的**，
而不同渠道的余额单位、是否免费、限流方式都不一样。所以本插件按渠道分派。

代码：`lib/host/balance-sources.js`（余额）、`lib/host/usage-tracker.js`（费用计数）。

## 余额：四类口径

| 渠道 | 显示 | 数据源 | 凭据 |
| --- | --- | --- | --- |
| **OFM 渠道包**（trae / qodercn / raccoon / minimax / lobsterai / cline / loomy / zcode / gemini） | `余额 N 积分` | 进程内 RPC → channel-pack `credits.balances` | `ctx.credentials.resolve(credentialRef)` |
| **OpenRouter** | `余额 $N.NN` | `GET /api/v1/credits` | `OPENROUTER_API_KEY` |
| **OpenRouter 免费模型** | `免费 · 今日 N/M 次` | `GET /api/v1/key` → `free_model_daily_requests` | 同上 |
| **DeepSeek 官方 API Key** | `余额 ¥N.NN` | `GET /user/balance` | `DEEPSEEK_API_KEY` |
| **DeepSeek 宿主账号** | `余额 ¥N.NN` | `ctx.deepseekAccount.getBalance()` | 宿主登录态 |
| **NVIDIA 等免费渠道** | `免费 · 本分钟 N 次 · 今日 M 次` | 本插件自己的请求计数 | `NVIDIA_API_KEY` |
| **其它免费模型** | `免费` | — | — |

**查不到就留空**，绝不显示 0 余额——0 与「没查到」是两件事。

## 怎么在宿主进程内调 channel-pack

channel-pack 把 RPC 注册在 `/api/channel-pack`（exact Fetch 路由）。宿主插件用
DSH 的**公开 API** 就能直接调它，不用 HTTP、不用 Cookie、不受 Origin/Host 围栏：

```js
const connection = ctx.get('connection')
const handler = connection.createSharedFetchHandler('/api')   // dsh-client-connection/src/rpc-host.ts:207
const peer = connection.createPeer({ principal: { kind: 'owner' } })  // exact 路由只放 owner
const response = await handler.fetch(request, peer)
```

请求体是 channel-pack 自己的信封：

```json
{ "type": "client-request", "rpcId": "...", "method": "channel-pack",
  "payload": { "method": "credits.balances", "payload": { "provider": "trae" } } }
```

响应是 `{ type: "server-response", rpcId, result: { ok, value | error } }`——
注意 `result.ok` 才是业务层的成败。

这样复用了渠道包已有的顺序查询与风控（渠道包**刻意**不并发查账号，避免触发风控），
也不需要把凭据读到自己手里。

## 费用：请求次数

宿主侧挂 `llm/stream` 钩子逐请求计数。该钩子的 options 带 `sessionId`
（`dsh-llm/src/types.ts:599`），所以能按会话归因。

计数维度：

- `route\0<provider>\0<model>`：某路由的请求数（余额栏的每分钟/每日）。
- `session\0<sessionId>\0<provider>`：某会话的请求数，**子代理的请求同时记到
  它的每一级祖先上**。

### 子代理归属

会话谱系有两条来源：

1. `subagent/start` 事件的 `parentSessionId`（权威，直接创建者）；
2. Session header 的 `parentSession`（子会话谱系）。

⚠️ **mnemon 的 `mnemon-task-v1-*` / `mnemon-review-owner-v1-*` 没有 parentSession**
（实测：header 只有 cwd/isSeeded/delegationDepth/agentPreset），因为它们由
`ctx.agents.create()` 直接创建而不是走子代理激活。所以谱系链的**末端**碰到
这两类会话时，把主会话接在链尾——mnemon 子树的消耗就会算进主对话。

主会话怎么找：这些会话与主会话**共享同一个 cwd**，且主会话不是 subagent 起源，
所以按「同 cwd + 非 subagent」定位。

实测（本机）：

```
llm/stream trae/minimax-m3.1-flash session=session-a383f248-…  root=session-a383f248-…
llm/stream trae/minimax-m3.1-flash session=mnemon-run-v1-953a…  root=session-a383f248-…
```

## 账户级消耗（方案 B）

余额栏在两次快照之间做差，得到「本期已用」。这是**账户级**数字：并发时它包含
所有对话的消耗，**无法拆分到单个对话**——会话级数字请看费用栏的请求次数。

余额上升（充值）时不算消耗。

### 快照口径：provider + model

快照的 key 是 **provider + model**，不是 provider 单��。原因：渠道包的余额是
**该 provider 所有账号之和**，同 provider 换模型时这个金额的口径就变了，
两次不同口径的余额相减得到的是噪声而不是消耗。改成 provider+model 后，
不同口径各自记账，互不污染。

### 快照什么时候更新：宿主主动刷新

余额**不是**等窗口要显示时才查。宿主在**每次请求之后**主动刷新该路由的余额
（最小间隔 30 秒，避免把渠道包的账号查询打爆），刷新后立刻让窗口丢掉旧的
60 秒缓存。

这样「本期已用」回答的是一个稳定的问题：**上一次刷新到现在，这段时间这个
账户花了多少**。它不再取决于窗口何时显示余额。

代价：第一次刷新只有余额、没有「本期已用」（还没有差值可算）；余额查询失败
时该次不更新快照。两者都如实显示，不补零。

### 消耗口径：本期累计，不是单次差值

「已用」是**本期累计消耗** = 本期基线余额 − 当前余额。基线是该账户（provider+model）
在本进程里第一次被观测到的余额；余额上升（充值）时基线抬到新余额，本期从 0 重新累计。

早先的实现用「相邻两次快照相减」，结果只在 30 秒的记账窗口内有效：实测 minimax
余额从 3,361.9 掉到 2,582.1，界面却一直停在「已用 5.2」；余额没变化时干脆不显示。
改成基线累计后，只要余额在降，「已用」就单调增长。

局限：基线在进程内，DSH 重启后从当前余额重新开始；并发时这个数字包含**所有**对话
的消耗，无法拆分到单个对话（会话级请看费用栏的请求次数）。

### 收起态与展开态显示不同的内容

原生窗口的**收起态胶囊宽度有限**。实测上限：**22 字放得下，24 字被省略号截断**。

### 四种「收起时显示」实测差别

用真实原生窗口逐项喂状态包、截图核对（`pill` 形状、空闲与「新回复」两种会话状态）：

| 收起时显示 | 空闲时 | 有新回复时 |
| --- | --- | --- |
| 自动 `amount` | `探索未至之境 \| 余额 …` | `新回复 会话标题` |
| 状态 `status` | `探索未至之境` | `新回复` |
| 标题 `title` | `探索未至之境 \| 余额 …` | `新回复 会话标题` |
| 详情 `detail` | `探索未至之境 \| 余额 …` | `新回复 会话标题` |

**原生窗口只区分「status」与「其它」**：status 模式只画状态、忽略 `idleBalance`；
其余三种空闲时都画 `idleBalance`，有新回复时都画「状态 + 会话标题」。

所以三种非 status 模式的差别只能由宿主**换 `idleBalance` 的文案**做出来：

| 收起时显示 | 宿主编的文案 |
| --- | --- |
| 状态 | 空串（交给原生只画状态） |
| 标题 | `余额 2,582.1 积分` |
| 详情 | `余额 2,582.1 积分 · 已用 780.3` |
| 自动 | `余额 2,582.1 积分` |

### 详情文案的宽度降级

「详情」要同时放余额和已用，容易超 22 字。按「从完整到最简」逐级降级，取第一个放得下的：

1. `余额 2,582.1 积分 · 已用 780.3`（24 字 → 超限）
2. `余额 1.8k 积分 · 已用 780.3`（大数改 K 缩写，保留一位小数）
3. `余额 1.8k · 已用 780.3`（连「积分」也去掉）

K 缩写规则：`≥ 1000` 才缩，保留一位小数（`2,582.1` → `2.6k`，`122,222.2` → `122.2k`）。

已知限制：**有新回复时**，三种非 status 模式显示相同（状态 + 会话标题），
详情模式在那时不会显示「已用」——那个位置的文案由会话标题占用，宿主不该篡改它。

### 记账节拍与界面读取分离

账户消耗只在**一个地方**推进：宿主在每次请求后调用 `advance()`
（最小间隔 30 秒）。界面的所有读取——`quota()`（展开态）、`collapsedBalance()`
（收起态）、`balance()`——都**只读不推**。

这样同一份状态包反复渲染时数字稳定，不会「读一次就变 0」；收起态与展开态读到
的也是同一个值，不会互相抢差值。

## 诊断

桌面端宿主日志不一定落盘，所以本插件把关键信息写进自己的数据目录：

```
$DSH_HOME/whale-live-window-info/diagnostics.log
```

每行形如：

```
2026-11-24T08:14:19.879Z quota trae/minimax-m3.1-flash -> credits 余额 1,502.7 积分
2026-11-24T08:17:07.570Z llm/stream trae/minimax-m3.1-flash session=… root=…
```

诊断行里的 `quota` 记的是**余额本身**（不含「本期已用」——那是拼接后的结果）。
`apply() loaded` 行里的 `balance-sources=` 标记跑的是哪一版代码（v2 起改为
按 provider+model 口径记账 + 主动刷新）。

改这组功能后要同步更新 `lib/index.js` 里的 `BALANCE_SOURCES_VERSION`，
否则分不清跑的是哪份代码。

## 已知限制

- **NVIDIA 没有上游余额接口**：NVIDIA 已取消积分制，改按每账号请求速率限制
  （默认 40 RPM），且 429 响应不带 `X-RateLimit` 头。所以只能显示**本插件自己
  计的**每分钟请求数，不是上游的剩余配额。
- **OpenRouter 免费模型的每日次数**来自上游 `free_model_daily_requests`，
  含其它客户端的消耗；本机的部分单独显示。
- **计数不跨重启**：进程内状态，重启归零。余额是上游查的，重启后照常显示。
- **积分不等于钱**：渠道包的余额单位是积分，`formatCompanionQuota` 的货币渲染
  会把 8000 积分显示成「¥8000.00」，所以本插件自己拼文案，不走那条路径。
