# 与原版的三处刻意差异（全部围绕「完成后不要清空」）

复刻原版时发现：任务一结束，实况窗就退回「探索未至之境」，会话栏也空了。
逐层取证后确认这是**原版自身的行为**，不是搬运出错。本插件在三处做了修正。

## 原版为什么会清空

链路是这样的：

1. 会话跑完 → `turn/end` 带 `reason=completed` → 宿主记下 `finishes[id]`（含 `unread`）。
2. 同一时刻，DSH 主窗口可见且聚焦在该会话 → 客户端上报 `viewed: true`。
3. 宿主 `companion-view` 收到 `viewed: true` → 立刻 `markRead(active.id)` 把 `unread` 清成 false。
4. `activity(id)` 于是返回 `{waiting:false, thinking:false, unread:false}`，tier 掉到 3。
5. `status` 变成 `idle` → 窗口认为「全都闲着」→ 显示「探索未至之境」。

会话栏消失是另一条：客户端只挑 `retainedBy.mainView > 0` 的会话当 `active`；
主窗口切走后该条件不成立，`id` 退化成 `""`，`active` 和 `rows` 同时没内容。

## 三处改动

### 1. `markRead(id, options)` — 窗口没展示过就不算已读

只有当实况窗**确实展示过**这次完成（窗口 ready 且该会话在最近状态包里）才清除未读。
窗口自己发起的 `select` 走 `{ fromWindow: true }`，那条路径照旧清除。

### 2. `companion-view` 刷新时不再删除 `finishes`

原版把它与 `retained` 求交，会话一旦不再是 active/running/可见行，完成时间就被丢弃。
完成记录本身就是实况窗要展示的总结，因此保留；只有会话被归档/移除时才清。

### 3. `readView` 的 active 选择加了回退

`retainedBy.mainView > 0` 优先；没有再退到**最近更新**的会话，最后退到任意一个。
实况窗因此始终至少有一个可展示、可切换的会话。

## 效果（用探针窗口实测）

| 状态 | 原版 | 现在 |
| --- | --- | --- |
| 有会话刚完成 | 清空 →「探索未至之境」 | **「新回复 会话标题」**，保留 summary 与预览 |
| 全部空闲且无完成记录 | 「探索未至之境」+ 余额 | 不变（这是合理的空闲外观） |
| 主窗口切走会话 | 会话栏消失 | 仍显示，可切换 |

原生窗口一侧不需要改：我直接给它推 `status: "completed"` 的会话，它就会画出
「新回复」+ 标题 + 预览，并一直留着。

## 回归测试

```powershell
node scripts/completion-retention.mjs
```

四条断言分别钉住：`markRead` 的早退路径、窗口 select 的 `fromWindow`、
`finishes` 不被剪枝、active 的回退链。
