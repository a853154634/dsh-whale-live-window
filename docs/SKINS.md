# 配色皮肤

实况窗的配色参照[岛仔灵动岛](https://github.com/)的岛体配色模型：岛仔把配色做成一份
**皮肤表**，每种皮肤给出底色（paper）、文字色（ink）与强调色（accent），由绘制层统一映射
（岛仔 `src/skin_paint.rs` 的 `Palette`）。

实况窗这边，原生窗口只有一条四色通道：

```
--theme=<scheme>,<accent>,<surface>,<foreground>
```

所以这里的「皮肤」就是一组四元组：岛仔的 paper/ink/accent 分别对应
surface/foreground/accent。

## 两级配置

| 配置 | 取值 | 说明 |
| --- | --- | --- |
| `skin` | `follow` / `classic` / `cream` / `glass_light` / `glass_dark` | 配色皮肤。`follow` 表示完全用 DSH 当前主题。 |
| `themeMode` | `follow` / `light` / `dark` | 明暗模式。`follow` 表示跟 DSH 的明暗走。 |

解析规则：

- `skin=follow`：整个主题交给 DSH（明暗与三色都跟 DSH 走）。此时
  `themeMode` 不生效——配色整体来自 DSH，硬改明暗只会让「配色跟不跟 DSH」变得含糊。
- 固定皮肤：配色取皮肤本身；明暗取 `themeMode`，`themeMode=follow` 时跟 DSH 的明暗走，
  并取皮肤对应明暗的那一套配色。

## 皮肤表

配色取自岛仔的真实常量：

| 皮肤 | 浅色（surface / foreground / accent） | 深色（surface / foreground / accent） |
| --- | --- | --- |
| 经典 Classic | `#FFFFFF` / `#16161A` / `#4D6BFE` | `#000000` / `#FFFFFF` / `#4D6BFE` |
| 奶油 Cream | `#FFF3E4` / `#2E2016` / `#F08A24` | `#2E2016` / `#FFF3E4` / `#F08A24` |
| 毛玻璃·浅 Glass light | `#FFFFFF` / `#16161A` / `#0A70E6` | `#F8F8FA` / `#16161A` / `#0A70E6` |
| 毛玻璃·深 Glass dark | `#1C1C1E` / `#FFFFFF` / `#0A70E6` | `#000000` / `#FFFFFF` / `#0A70E6` |

来源：

- 奶油：岛仔 `CREAM` —— 纸 `[255,243,228]` 墨 `[46,32,22]` 强调 `[240,138,36]`。
- 毛玻璃：岛仔 `GLASS_LIGHT` / `GLASS_DARK` —— 强调 `[10,112,230]`，深色底 `[28,28,30]`。
- 经典：纯黑岛体，强调色沿用岛仔的 DeepSeek 徽标色 `#4d6bfe`。

每种皮肤都备了浅色与深色两套，所以强制明暗不会出现「深底深字」这种读不清的组合。
`scripts/skins.mjs` 里有一条断言专门盯着这件事。

## 跟随 DSH 时的取值来源

客户端从 DSH 的主题服务取当前配色。**不能只读主题快照的 `tokens`**：内置的
light / dark 主题 `tokens` 是空的（配色全在样式表里），只读快照的话实况窗永远拿到的
是硬编码的兜底色，跟 DSH 的实际配色对不上。

所以取值顺序是：

1. `getComputedStyle(document.body).getPropertyValue(token)` —— 主题服务把注册主题的
   token 覆盖写在 body 的行内样式上（见 `dsh-client-ui-layout` 的 `ThemePresenter`），
   行内样式优先级高于样式表，所以这里能拿到真实取值。
2. 主题快照的 `active.tokens`（注册了 token 覆盖的主题走这条）。
3. 兜底色。

取值本身还要从 CSS 颜色值（`rgb(15, 17, 21)`）转成原生窗口认的 `#RRGGBB`。

强调色用的是 `--dsw-alias-brand-primary-new-colorprimary-new-color`
（浅色 `rgb(65,118,230)` / 深色 `rgb(86,134,254)`），而不是 `--dsw-alias-brand-primary`
——后者在 light / dark 两套里分别是近黑与近白，直接当强调色会让实况窗没有颜色感。

## 不透明度（每个皮肤各自一个值）

原生窗口**不画 alpha**：它把 theme 的 surface 色画成实心底板，主题协议
（`--theme=scheme,accent,surface,foreground`）也只认 6 位 RGB，传 8 位带 alpha 的
hex 会被拒绝（实测回落到默认色）。

但 Windows 允许给窗口加 `WS_EX_LAYERED` 样式，再用 `SetLayeredWindowAttributes`
整窗调节不透明度 —— 实测有效：

| alpha | 胶囊内部像素（surface `#7A1FA2`，背景是 DSH 界面） |
| --- | --- |
| 255 | `77,107,254` |
| 200 | `66,90,205` |
| 150 | `57,75,160` |
| 100 | `48,59,116` |
| 60 | `40,46,80` |
| 20 | `33,34,44` |

单调变淡，背景按比例透进来。

### 实现

Node 没有内置 Win32 绑定，本插件又不引入原生依赖，所以用
`lib/host/opacity-helper.ps1`：一个常驻的 PowerShell 助手，启动时用 `Add-Type`
编译一次 Win32 互操作，之后走 stdin/stdout 的 JSON 行协议。拖动滑块时只是一次
IPC 往返，不是每次起进程。

助手做两件事：

1. 按 **pid** 找到实况窗主窗口（实况窗进程有 8 个顶层窗口：IME、GL pbuffer、
   隐藏辅助窗……，只有一个是真的）。
2. 补上 `WS_EX_LAYERED` 样式，再调 `SetLayeredWindowAttributes`。
   **必须先补样式** —— 该 API 要求窗口已带这个样式，原生窗口没有，直接调会返回
   `False`。

### 两个要记住的限制

1. **文字会跟着一起变淡**：alpha 作用于整窗。窗口变淡后纯白字在浅色背景上会
   看不清，所以 `skins.js` 的 `withOpacityCompensation` 按淡的程度调整前景色
   （深底浅字场景往底色方向压，浅底深字场景提亮）。
2. **只改模糊底板窗口没用**：实况窗另有一个 `DaozaiGlassBackdrop` 模糊底板窗口，
   但不透明底板是主窗口自己画的，所以 alpha 只能加在主窗口上。

### 配置

| 配置 | 说明 |
| --- | --- |
| `opacity` | 全局不透明度（25-100）。某套皮肤没有单独的值时用它。 |
| `skinOpacitys` | 每套皮肤各自的不透明度（`{ [skinId]: 25-100 }`）。切皮肤时用各自的那个。 |

默认值：经典与奶油 100（不透明），毛玻璃·浅与毛玻璃·深 85（天生就该透一点）。

下限是 25%：再低文字基本看不见了。

## 生效路径

```
设置面板改配色 → POST /live-window/api (live-window-config-set)
  → 宿主 configEditor 写进 profile 的 cordis.patch.yml
  → companion.refreshSkin() 重算最终配色（含文字补偿）
  → refresh() 把新 theme 写进 state 包
  → 原生窗口收到新的四元组并重绘

设置面板改不透明度 → 同一条路
  → companion.applyOpacity() → 助手 → SetLayeredWindowAttributes
```

配置字段是 volatile 的：改完**不用重启 DSH**，Loader 原地更新引用即可。
`loader/volatile-update` 事件也会触发一次重算（幂等，重复调用不会重复上色）。

## 验证

```powershell
npm test                             # 10 组测试：skins / skin-window / opacity
node scripts/skin-window-probe.mjs   # 人工联调：真窗口逐个皮肤换色
```

`skin-window-probe.mjs` 可以只跑一种皮肤并覆盖颜色，方便截图对比：

```powershell
node scripts/skin-window-probe.mjs cream surface:7A1FA2
```
