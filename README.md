# 鲸梦实况窗（dsh-whale-live-window）

把 [鲸梦主题](https://github.com/sjnole/dsh-whale-dream) 里的**实况窗**拆出来的独立插件。
业务逻辑是**原版代码整段搬运**，不是重写——逐行比对见 [docs/EXTRACTION.md](docs/EXTRACTION.md)。

![实况窗与设置面板](docs/preview.svg)

## 先读这条：原生程序版本

实况窗需要**带 `--whale-live-window` 模式**的 `daozai.exe`。
官方上游 0.6.64 没有这个模式，用它会得到一个空窗口（只有「探索未至之境」）。

自检：

```powershell
node scripts/window-probe.mjs
```

- `probe passed: ready handshake + state accepted` → 程序正确
- `probe failed: no ready handshake` → 版本不匹配，见 [docs/BINARY-REQUIREMENT.md](docs/BINARY-REQUIREMENT.md)

本包 `bin/daozai.exe` 已放入**可用版本**（来自鲸梦主题包的 native 目录）。

## 它做什么

- 在 DSH 桌面版里以独立进程拉起原生窗口（Windows `daozai.exe` / macOS `whale-live-window`）。
- 把会话进展、最近回复、待审批请求、草稿推给窗口。
- 把窗口的动作（切换/打开会话、发回复、处理审批）转回 DSH 执行。
- 记住形状、收起内容、自动收起、精简动效、提示音、顶部位置与所在显示器。
- 按渠道分派显示余额，费用栏按**请求次数**统计本对话（含子代理）的消耗。
- **配色皮肤**：参照[岛仔灵动岛](https://github.com/)的配色模型，可跟随 DSH 主题，
  也可固定成经典 / 奶油 / 毛玻璃·浅 / 毛玻璃·深；明暗也能单独固定。

## 设置

设置在 **设置 → 实况窗**（插件自己注册的分区，与鲸梦主题无关）。

**窗口偏好**（存在插件自己的偏好文件里，改动立即生效）：

| 选项 | 说明 |
| --- | --- |
| 显示实况窗 | 打开/关闭窗口。窗口自己被关掉时也会同步关掉这个开关。 |
| 外观形状 | 胶囊 / 刘海 / 极简刘海。 |
| 收起时显示 | 自动 / 状态 / 标题 / 详情（极简刘海只支持状态）。 |
| 自动收起 | 鼠标移出后收起窗口。 |
| 动效强度 | 标准 / 精简（精简减少展开与流光动效）。 |
| 完成提示音 | 未查看的会话完成时响一声，可试听。 |
| 完成闪烁提醒 | 完成后轻闪，查看会话后停止。 |
| 显示会话详情 | 关掉后隐藏回复预览、标题、模型和用量。 |

**配色**（写在 profile 配置里，改完不用重启 DSH，窗口立刻换色）：

| 选项 | 说明 |
| --- | --- |
| 配色皮肤 | 跟随 DSH / 经典 / 奶油 / 毛玻璃·浅 / 毛玻璃·深。 |
| 明暗模式 | 跟随 DSH / 浅色 / 深色。选了「跟随 DSH」皮肤时这项不可改（配色整体来自 DSH）。 |

皮肤配色取自岛仔灵动岛的真实常量（奶油纸 `#FFF3E4` 墨 `#2E2016` 强调 `#F08A24`，
毛玻璃强调 `#0A70E6` 等），每种皮肤都备了浅色与深色两套，所以强制明暗不会出现
「深底深字」。原生窗口只有一条四色通道（`--theme=scheme,accent,surface,foreground`），
所以皮肤最终就是这四个值。

**宿主设置**（写进 profile 的 `cordis.patch.yml`，改完不用重启 DSH）：

| 选项 | 说明 |
| --- | --- |
| 启动 DSH 时自动打开 | 每次启动自动拉起实况窗。用户手动关过窗口后不会强行再开。 |
| 显示余额与费用 | 关掉后实况窗不再查询和显示余额、额度与请求次数。 |
| 调试模式 | 把最后一次状态包写到插件数据目录，便于排查窗口与宿主的通信。 |

宿主设置也可以直接改 profile 配置：

```yaml
- id: whale-live-window
  name: dsh-whale-live-window
  config:
    debug: false
    executable: ''      # 留空 = 用本包 bin/ 里自带的那个
    autoStart: false
    showBalance: true
    skin: follow        # follow | classic | cream | glass_light | glass_dark
    themeMode: follow   # follow | light | dark
```

## 安装

### 方式一：DSH 插件市场（推荐）

在 DSH 桌面版或 Web 版里打开 **插件 → 发现（Discover）**，搜索
`dsh-whale-live-window` 或「鲸梦实况窗」，点击安装即可。

也可以直接用命令行：

```powershell
dsh plugin --profile web add dsh-whale-live-window
```

### 方式二：从 GitHub 源码安装

```powershell
dsh plugin --profile web add github:<owner>/dsh-whale-live-window
```

### 手动安装（开发用）

```jsonc
// <DSH_HOME>/profiles/desktop/package.json
{
  "dependencies": { "dsh-whale-live-window": "file:<本地路径>" },
  "dsh": { "profile": { "bundles": [ ..., "dsh-whale-live-window" ] } }
}
```

然后在 profile 的 `cordis.patch.yml` 里加一条：

```yaml
- id: whale-live-window
  name: dsh-whale-live-window
  config:
    debug: false
```

重启 DSH。改源码后：客户端刷新页面即可，宿主侧需重启。

### 兼容性

- DSH：`^0.1.0-rc.7` 及以上（需要 `dsh-client-ui-renderer`、`dsh-api-session-controller` 等注入点）
- Node.js：`>=22.13.0`
- 平台：Windows x64（随包附带 `bin/daozai.exe`）；macOS arm64 需自备对应原生程序

## 与鲸梦主题的关系

- **不依赖**：主题可以单独卸载，实况窗照常工作；反之亦然。
- **会抢窗口**：主题自带的实况窗也用同一个 `daozai.exe`，两者只能开一个。
  建议关掉主题那个（设置 → 鲸梦主题 → 实况窗），用本插件。

## 目录

```
lib/index.js                  宿主入口：挂路由 + 信任围栏 + 生命周期（唯一的适配层）
lib/host/verbatim/            原版的 4 个宿主模块（逐字，仅少量路径改动）
lib/host/balance-sources.js   余额：按渠道分派
lib/host/usage-tracker.js     费用：请求计数 + 会话谱系
lib/host/usage-source.js      用量桥：把上面两者接到 companion
lib/host/ledger/              账本子系统（整段搬运，node:sqlite + worker）
lib/client/index.js           客户端包（三段原版代码 + 头尾适配）
lib/client/vendor/*.part.txt  从原 bundle 截出来的三段，便于 diff / 升级
bin/                          原生程序（自持，不依赖任何别的包）
assets/                       提示音与图标（窗口程序也要读提示音）
locale/                       插件在「插件」页显示的标题与介绍
scripts/                      测试与诊断
docs/                         提取说明、二进制要求、余额口径
```

## 开发

```powershell
npm test        # 客户端激活 + 宿主路由 + 账本 + 用量
npm run probe   # 真拉起窗口走一遍 ready → state → close
npm run check   # 语法 + 上面几项
```

## 用量、余额与费用

余额按**渠道类型**分派，费用按**请求次数**显示：

| 渠道 | 余额栏 | 数据源 |
| --- | --- | --- |
| OFM 渠道包（trae 等） | `余额 N 积分` | 进程内 RPC → channel-pack `credits.balances` |
| OpenRouter | `余额 $N.NN` | `GET /api/v1/credits` |
| OpenRouter 免费模型 | `免费 · 今日 N/M 次` | `GET /api/v1/key` |
| DeepSeek（官方 Key / 宿主账号） | `余额 ¥N.NN` | `GET /user/balance` / `ctx.deepseekAccount.getBalance()` |
| NVIDIA 等免费渠道 | `免费 · 本分钟 N 次` | 本插件自己的请求计数 |

**费用栏 = 请求次数**，本对话的消耗**含子代理**（按会话谱系归并）。

账本（`lib/host/ledger/`）仍是从鲸梦整段搬来的 `node:sqlite` 子系统，**本包自足**：
数据在 `$DSH_HOME/whale-live-window-info/`，首次启动会把旧鲸梦账本一次性迁过来。

细节、口径与已知限制见 [docs/BALANCE.md](docs/BALANCE.md)；
诊断日志在 `$DSH_HOME/whale-live-window-info/diagnostics.log`。

## 与弃用的 dsh-whale-dream 的关系

**运行时不依赖它。** 该包已从 profile 移除。本插件的代码是当时从它整段搬出来的，
之后各走各的；文件头保留来源注释，仅用于追溯与升级比对本。

## 许可

MIT。原生程序来自 [岛仔 Daozai](https://github.com/Renly1994/xiaotang-daozai)（MIT，
许可证见 `bin/LICENSE.daozai`）；实况窗逻辑来自 dsh-whale-dream（MIT）。详见 [LICENSE](LICENSE)。
