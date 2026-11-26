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

## 生效路径

```
设置面板改配色 → POST /live-window/api (live-window-config-set)
  → 宿主 configEditor 写进 profile 的 cordis.patch.yml
  → companion.refreshSkin() 重算最终配色
  → refresh() 把新 theme 写进 state 包
  → 原生窗口收到新的四元组并重绘
```

配置字段是 volatile 的：改完**不用重启 DSH**，Loader 原地更新引用即可。
`loader/volatile-update` 事件也会触发一次重算（幂等，重复调用不会重复上色）。

## 验证

```powershell
npm test                      # 9 组测试：skins.mjs（纯逻辑）+ skin-window.mjs（接线）
node scripts/skin-window-probe.mjs   # 人工联调：真窗口逐个皮肤换色
```

`skin-window-probe.mjs` 可以只跑一种皮肤并覆盖颜色，方便截图对比：

```powershell
node scripts/skin-window-probe.mjs cream surface:7A1FA2
```
