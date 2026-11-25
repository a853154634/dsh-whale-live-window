# 提取说明：这个插件是怎么来的

本文记录「鲸梦实况窗」从主题包里拆成独立插件的边界，方便日后核对与升级。

## 来源

- **主题包**：[dsh-whale-dream](https://github.com/sjnole/dsh-whale-dream)（MIT）
  实况窗的业务逻辑原本和鲸梦主题的皮肤、桌宠、设置面板打包在一起。
- **原生窗口程序**：[岛仔 Daozai](https://github.com/Renly1994/xiaotang-daozai)（MIT）
  实况窗的窗口本身由这个 Rust 程序绘制，插件负责拉起进程并与之通信。

两个上游都是 MIT，所以本插件同样是 MIT。

## 原则：整段搬运，不重写

实况窗的协议、状态机、卡片渲染、审批与草稿流程都**逐段原样搬运**，
只做「让它能独立运行」的最小改动。理由是这套逻辑依赖很多宿主内部细节
（会话谱系、配额唤醒、账本口径），重写等于重新踩一遍原作者踩过的坑。

## 搬运 vs 改写

| 位置 | 性质 | 说明 |
| --- | --- | --- |
| `lib/host/verbatim/` | **整段搬运** | 4 个宿主模块，与上游逐行一致，仅改动少量与「本插件拥有自己的数据文件与程序路径」有关的行 |
| `lib/host/ledger/` | **整段搬运** | `node:sqlite` 账本子系统，仅路径不同 |
| `lib/client/vendor/*.part.txt` | **整段搬运** | 从上游 client bundle 里截出来的三段：`DesktopCompanionSettings` + CSS、`liveInteractionText` / `liveInteractionDefinition` / `liveQuestionAnswers`、`createDesktopCompanionController` |
| `lib/client/index.js` | **薄适配层** | 把上面三段按原顺序拼回去，只补它们原来依赖的模块作用域变量（React、jsx runtime、`appearance`） |
| `lib/index.js` | **薄适配层** | 宿主入口：挂路由 + 信任围栏 + 生命周期 |
| `lib/host/balance-sources.js` | **新增** | 余额按渠道类型分派 |
| `lib/host/usage-tracker.js` | **新增** | 费用按请求次数统计，含子代理（按会话谱系归并） |
| `lib/host/usage-source.js` | **新增** | 把上面两者接到 companion |

## 本插件相对上游做的实际改动

1. **服务惰性读取**：原版在创建控制器时一次性取 `uiWorkspace` / `layout` / `modelDirectories`，
   此时服务尚未就绪就取到 `undefined`，且永远不会再取，事件流建不起来。
   改为每次使用时重新取。
2. **选中的会话不再强依赖 `retainedBy.mainView`**：任务结束或主窗口切走后会话后，
   该条件不再成立，会话栏会整条空掉。回退顺序改为
   主窗口保留的 → 最近更新的 → 任意一个。
3. **审批卡片不再由 `session/prompt` 的可用性把关**：审批恰恰发生在回合运行期间，
   此时 `session/prompt` 可能被判为不可用，导致「有提示却无法完成审批」。
   真正的权限判断交给提交路径去拒绝。

这三点在代码里有 `【本插件改动】` 注释标记。

## 升级到新版上游

1. 从新版 `dsh-whale-dream` 的 `lib/client.js` 重新截出三段，覆盖
   `lib/client/vendor/*.part.txt`（顺序：`settings` → `helpers` → `controller`）。
2. 适配层 `lib/client/index.js` 通常不用动，除非新版新增了外部变量。
3. 从新版 `lib/desktop-companion.js` 重新拷贝到 `lib/host/verbatim/desktop-companion.js`，
   再重做与路径相关的几处替换。

## 与弃用的 dsh-whale-dream 的关系

**运行时不依赖它。** 主题包已从 profile 移除，本插件的代码是当时从它整段搬出来的，
之后各走各的；文件头保留来源注释，仅用于追溯与升级比对本。

## 二进制要求

实况窗需要带 `--whale-live-window` 模式的 `daozai.exe`，上游官方构建没有这个模式。
详见 [BINARY-REQUIREMENT.md](BINARY-REQUIREMENT.md)。
