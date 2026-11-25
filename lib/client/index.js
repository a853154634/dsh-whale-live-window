/* 鲸梦实况窗 · 浏览器侧。
 *
 * 这一份是从 dsh-whale-dream 1.0.0 的 client bundle 里【整段拆出来】的原版代码，
 * 不是重写：
 *   vendor/settings.part.txt    ← DesktopCompanionSettings + companionSettingsCss
 *   vendor/helpers.part.txt     ← liveInteractionText / liveInteractionDefinition / liveQuestionAnswers
 *   vendor/controller.part.txt  ← createDesktopCompanionController
 * 三段顺序与原 bundle 一致；本文件只补它们原来依赖的模块作用域变量。
 *
 * 想升级：从新版 dsh-whale-dream/lib/client.js 重新截那三段覆盖 vendor/*.txt 即可，
 * 适配层不用动（除非新版加了新的外部变量，见下方 shims）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-live-window',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');

    // 原 bundle 用 esbuild 的变量名引用这两个运行时；此处用同名变量转接。
    const import_react12 = React;
    const import_jsx_runtime12 = jsxRuntime;

    const API = '/live-window/api';

    /* 原版控制器只有一个外部依赖：appearance（DSH 的配色快照，用来给窗口首帧上色）。
     * 这个包里由 ctx.theme 提供——两者都是「当前生效的主题快照」。 */
    let appearance = { getSnapshot: () => undefined, subscribe: () => () => {} };
    function bindAppearance(ctx) {
      const read = () => {
        try {
          const snapshot = ctx.theme && ctx.theme.getTheme();
          const active = snapshot && snapshot.active;
          if (!active) return undefined;
          const tokens = active.tokens || {};
          const pick = (name, fallback) => {
            const value = tokens[name];
            const picked = value && typeof value === 'object' ? value[active.colorScheme] : value;
            const match = typeof picked === 'string' ? picked.match(/^#([0-9a-fA-F]{6})$/) : null;
            return match ? match[1].toUpperCase() : fallback;
          };
          const scheme = active.colorScheme === 'light' ? 'light' : 'dark';
          return {
            ready: true,
            colorScheme: scheme,
            effectivePalette: {
              accent: '#' + pick('--dsw-alias-brand-primary', '8DA6FF'),
              composer: '#' + pick('--dsw-alias-bg-layer-1', scheme === 'light' ? 'FFFFFF' : '202A43'),
              text: '#' + pick('--dsw-alias-label-primary', scheme === 'light' ? '1B1B1F' : 'EDF2FF'),
            },
          };
        } catch (error) { return undefined; }
      };
      appearance = {
        getSnapshot: read,
        subscribe: (listener) => {
          try { return ctx.on('theme/change', listener) || (() => {}); }
          catch (error) { return () => {}; }
        },
      };
    }
/* 【本插件补回】原版 bundle 里的 Toggle 控件。
 *
 * 搬运时只截了三段（settings / helpers / controller），Toggle 住在
 * `src/settings/Controls.tsx` 里、不在这三段中，于是设置面板一渲染就抛
 * `ReferenceError: Toggle is not defined`——整个实况窗设置分区是空的。
 *
 * 这里按原版逐字补回（只换掉 esbuild 的变量名为本包已有的 import_react12 /
 * import_jsx_runtime12），行为与原版一致。
 */
function Toggle({ label, checked, onChange, hint, disabled = false }) {
  const id = (0, import_react12.useId)();
  return (0, import_jsx_runtime12.jsxs)("label", { className: "wl-toggle-row", children: [
    (0, import_jsx_runtime12.jsxs)("span", { children: [
      (0, import_jsx_runtime12.jsx)("span", { className: "wl-label", children: label }),
      hint && (0, import_jsx_runtime12.jsx)("span", { className: "wl-hint", id, children: hint }),
    ] }),
    (0, import_jsx_runtime12.jsx)("input", {
      type: "checkbox", role: "switch", "aria-label": label,
      "aria-describedby": hint ? id : void 0, checked, disabled,
      onChange: (event) => onChange(event.target.checked),
    }),
  ] });
}
function DesktopCompanionSettings({ controller, state, tr }) {
  const disabled = state.supported !== true || state.busy;
  const chime = (0, import_react12.useRef)(null);
  const [soundPreviewFailed, setSoundPreviewFailed] = (0, import_react12.useState)(false);
  function stopSoundPreview() {
    const active = chime.current;
    if (!active) return;
    chime.current = null;
    active.request.abort();
    void active.context.close().catch(() => {});
  }
  (0, import_react12.useEffect)(() => stopSoundPreview, []);
  async function previewCompletionSound() {
    if (chime.current) return;
    setSoundPreviewFailed(false);
    try {
      const context = new AudioContext();
      const request = new AbortController();
      chime.current = { context, request };
      const [response] = await Promise.all([fetch("/live-window/api", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "companion-sample" }), signal: request.signal,
      }), context.resume()]);
      if (!response.ok) throw Error("Completion sound unavailable");
      const sample = await context.decodeAudioData(await response.arrayBuffer());
      if (request.signal.aborted) return;
      const source = context.createBufferSource();
      source.buffer = sample;
      source.connect(context.destination);
      source.onended = stopSoundPreview;
      source.start();
    } catch (error) {
      if (error.name !== "AbortError") setSoundPreviewFailed(true);
      stopSoundPreview();
    }
  }
  const motionLabel = tr("动效强度", "Motion");
  const shapeLabel = tr("外观形状", "Window shape");
  const collapsedLabel = tr("收起时显示", "Collapsed display");
  const choices = (key, label, options, inactive = disabled) => (0, import_jsx_runtime12.jsx)("div", {
    className: "wl-segment", role: "group", "aria-label": label,
    children: options.map(([value, text]) => (0, import_jsx_runtime12.jsx)("button", {
      type: "button", "aria-pressed": state[key] === value, disabled: inactive,
      onClick: () => void controller.setPreference(key, value), children: text,
    }, value)),
  });
  /* 【本插件新增】宿主级配置项（Config schema 派生，改动原地生效）。 */
  const config = state.config ?? {};
  const configItems = [
    { key: "autoStart", label: tr("启动 DSH 时自动打开", "Open automatically at startup"),
      hint: tr("打开后，每次启动 DSH 都会自动拉起实况窗。", "When on, the Live Window opens every time DSH starts.") },
    { key: "showBalance", label: tr("显示余额与费用", "Show balance and cost"),
      hint: tr("关闭后实况窗不再查询和显示余额、额度与请求次数。", "When off, the Live Window stops querying and showing balance, quota and request counts.") },
    { key: "debug", label: tr("调试模式", "Debug mode"),
      hint: tr("把最后一次状态包写到插件数据目录，便于排查窗口与宿主的通信。", "Writes the last state packet into the plugin data directory to troubleshoot host/window communication.") },
  ];
  const configRow = (item) => (0, import_jsx_runtime12.jsx)(Toggle, {
    key: item.key,
    label: item.label,
    hint: item.hint,
    checked: config[item.key] === true,
    disabled: disabled || state.configWritable !== true,
    onChange: (value) => void controller.setConfig(item.key, value),
  });
  return (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-settings", "data-testid": "desktop-companion-settings", children: [
    (0, import_jsx_runtime12.jsx)("div", { className: "wl-companion-overview", children:
      (0, import_jsx_runtime12.jsx)(Toggle, {
        label: tr("显示实况窗", "Show Live Window"),
        hint: tr("沿屏幕顶部左右拖动，也可移到其他显示器。悬停查看会话。", "Drag Live Window left or right along the top of the screen, or move it to another display. Hover to see conversations."),
        checked: state.enabled,
        disabled,
        onChange: (enabled) => void controller.setPreference("enabled", enabled),
      })
    }),
    (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-options", children: [
      (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-motion", children: [
        (0, import_jsx_runtime12.jsx)("span", { className: "wl-label", children: shapeLabel }),
        choices("shape", shapeLabel, [["pill", tr("胶囊", "Capsule")], ["notch", tr("刘海", "Notch")], ["minimal", tr("极简刘海", "Minimal notch")]]),
      ] }),
      (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-motion", children: [
        (0, import_jsx_runtime12.jsxs)("span", { children: [
          (0, import_jsx_runtime12.jsx)("span", { className: "wl-label", children: collapsedLabel }),
          (0, import_jsx_runtime12.jsx)("span", { className: "wl-hint", children: state.shape === "minimal"
            ? tr("极简刘海收起时用细线颜色提示状态。", "The minimal notch shows status using the line color when collapsed.")
            : tr("自动：空闲看余额，有新回复看会话标题。状态：只显示状态。标题：显示余额。详情：显示余额与已用。", "Auto: balance when idle, conversation title on a new reply. Status: the status alone. Title: the balance. Details: balance plus spend.") }),
        ] }),
        choices("collapsedDisplay", collapsedLabel, [["amount", tr("自动", "Auto")], ["status", tr("状态", "Status")], ["title", tr("标题", "Title")], ["detail", tr("详情", "Details")]], disabled || state.shape === "minimal" || !state.showDetails),
      ] }),
      (0, import_jsx_runtime12.jsx)(Toggle, {
        label: tr("自动收起", "Auto-collapse"),
        hint: tr("鼠标移出后收起实况窗。", "Collapse Live Window when the pointer leaves."),
        checked: state.autoCollapse,
        disabled,
        onChange: (enabled) => void controller.setPreference("autoCollapse", enabled),
      }),
      (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-motion", children: [
        (0, import_jsx_runtime12.jsxs)("span", { children: [
          (0, import_jsx_runtime12.jsx)("span", { className: "wl-label", children: motionLabel }),
          (0, import_jsx_runtime12.jsx)("span", { className: "wl-hint", children: tr("精简模式减少展开与流光动效。", "Reduced motion limits expansion and flowing light effects.") }),
        ] }),
        (0, import_jsx_runtime12.jsx)("div", { className: "wl-segment", role: "group", "aria-label": motionLabel, children: [
          (0, import_jsx_runtime12.jsx)("button", {
            type: "button", "aria-pressed": !state.reducedMotion, disabled,
            onClick: () => void controller.setPreference("reducedMotion", false), children: tr("标准", "Standard"),
          }),
          (0, import_jsx_runtime12.jsx)("button", {
            type: "button", "aria-pressed": state.reducedMotion, disabled,
            onClick: () => void controller.setPreference("reducedMotion", true), children: tr("精简", "Reduced"),
          }),
        ] }),
      ] }),
      (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-audio", children: [
        (0, import_jsx_runtime12.jsx)(Toggle, {
          label: tr("完成提示音", "Completion sound"),
          hint: tr("未查看的会话完成时响一声。", "Play one chime when an unseen conversation finishes."),
          checked: state.completionSound,
          disabled,
          onChange: (enabled) => void controller.setPreference("completionSound", enabled),
        }),
        (0, import_jsx_runtime12.jsx)("button", { type: "button", className: "wl-button", disabled: state.supported !== true, onClick: previewCompletionSound,
          children: tr("试听", "Play sample") }),
        soundPreviewFailed && (0, import_jsx_runtime12.jsx)("span", { className: "wl-hint", role: "status",
          children: tr("试听未能播放。", "Could not play the sample.") }),
      ] }),
      (0, import_jsx_runtime12.jsx)(Toggle, {
        label: tr("完成闪烁提醒", "Flash on completion"),
        hint: tr("完成后轻闪提示，查看对应会话后停止。", "Gently flash after completion until you view the conversation."),
        checked: state.completionFlash,
        disabled,
        onChange: (enabled) => void controller.setPreference("completionFlash", enabled),
      }),
      (0, import_jsx_runtime12.jsx)(Toggle, {
        label: tr("显示会话详情", "Show conversation details"),
        hint: tr("关闭后隐藏回复预览、标题、模型和用量。", "Turn off to hide the reply preview, titles, models and usage."),
        checked: state.showDetails,
        disabled,
        onChange: (enabled) => void controller.setPreference("showDetails", enabled),
      }),
    ] }),
    (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-options", children: [
      (0, import_jsx_runtime12.jsxs)("div", { className: "wl-companion-heading", children: [
        (0, import_jsx_runtime12.jsx)("span", { className: "wl-label", children: tr("宿主设置", "Host settings") }),
        (0, import_jsx_runtime12.jsx)("span", { className: "wl-hint", children: tr("这些选项写在 profile 配置里，改动立即生效，不必重启 DSH。", "These options live in the profile configuration and take effect immediately, without restarting DSH.") }),
      ] }),
      ...configItems.map(configRow),
    ] }),
    state.error && (0, import_jsx_runtime12.jsxs)("p", { className: "wl-companion-warning", role: "status", children: [
      state.error === "load"
        ? tr("暂时无法读取实况窗设置。", "Could not load Live Window settings.")
        : state.error === "launch"
          ? tr("实况窗启动失败。请关闭开关后重新开启。", "Live Window could not start. Turn it off, then turn it on again.")
          : tr("实况窗设置未生效，请重试。", "Could not update Live Window settings. Please retry."),
      state.error === "load" && (0, import_jsx_runtime12.jsx)("button", {
        type: "button", className: "wl-button", disabled: state.busy,
        onClick: () => void controller.load(), children: tr("重试", "Retry"),
      }),
    ] }),
  ] });
}
var companionSettingsCss = `
.wl-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:18px;cursor:pointer;min-height:24px}
.wl-toggle-row>span{min-width:0}
.wl-label{display:block;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.wl-hint{display:block;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-weight:400}
.wl-toggle-row input[role=switch]{appearance:none;-webkit-appearance:none;flex:none;width:34px;height:20px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border:1px solid var(--dsw-alias-border-l2);position:relative;margin:0;cursor:pointer;transition:background .15s}
.wl-toggle-row input[role=switch]::after{content:"";position:absolute;width:14px;height:14px;left:2px;top:2px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 3px #0003;transition:transform .15s}
.wl-toggle-row input[role=switch]:checked{background:var(--dsw-alias-brand-primary);border-color:transparent}
.wl-toggle-row input[role=switch]:checked::after{transform:translateX(14px)}
.wl-segment{display:flex;flex-wrap:wrap;gap:3px;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 7%,transparent)}
.wl-segment button{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;font-size:11px;padding:5px 12px;min-height:29px;cursor:pointer}
.wl-segment button[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 2px #0000000a}
.wl-segment button:hover:not([aria-pressed=true]){color:var(--dsw-alias-label-primary)}
.wl-button{font-size:11px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;justify-self:start;cursor:pointer}
.wl-button:hover{border-color:var(--dsw-alias-brand-primary)}
.wl-companion-settings{display:grid;gap:14px;container:wl-companion/inline-size}
.wl-companion-overview,.wl-companion-options{border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
.wl-companion-overview{padding:18px 16px;min-width:0;background:radial-gradient(ellipse at 92% 0%,color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent),transparent 74%),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent)}
.wl-companion-overview>.wl-toggle-row{gap:14px;min-width:0}
.wl-companion-overview .wl-label{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary)}
.wl-companion-options{display:grid;min-width:0}
.wl-companion-options>.wl-toggle-row,.wl-companion-motion{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;min-height:57px}
.wl-companion-heading{display:flex;flex-direction:column;gap:2px;padding:14px 16px 10px}
.wl-companion-heading .wl-label{font-size:13px;font-weight:650}
.wl-companion-audio{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 16px;min-width:0}
.wl-companion-audio>.wl-toggle-row{flex:1 1 185px;min-width:0;gap:12px}
.wl-companion-audio>.wl-hint{flex-basis:100%}
.wl-companion-options>*+*{border-top:1px solid var(--dsw-alias-border-l2)}
.wl-companion-settings .wl-hint{display:block;margin-top:3px;max-width:32ch}
.wl-companion-overview .wl-hint{max-width:none}
.wl-companion-settings :is(input,button):disabled{cursor:default;opacity:.65}
.wl-companion-settings :is(input,button):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wl-companion-motion .wl-segment{flex:none}
.wl-companion-warning{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.65;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px}
.wl-companion-warning button{margin-top:0}
@container wl-companion (max-width:380px){.wl-companion-motion{flex-wrap:wrap}.wl-companion-motion .wl-segment{flex:0 1 auto;max-width:100%}}
`;

function liveInteractionText(text) {
  return typeof text === "string" ? text : "";
}

function liveInteractionDefinition(pending) {
  if (!pending || typeof pending.key !== "string" || typeof pending.answer !== "function") return null;
  if (pending.kind === "approval") {
    if (pending.answerable !== true || !pending.toolName) return null;
    const detail = liveInteractionText(pending.displayReason?.[document.documentElement.lang] ?? pending.displayReason?.zh ?? pending.reason ?? pending.displayReason?.en);
    // A request without a correlated operation needs the original reason to be reviewable here.
    if (!pending.callId && !detail.trim()) return null;
    return { card: { key: pending.key, kind: "approval", title: `工具审批 · ${pending.toolName}`, detail,
      questions: [], callId: pending.callId, toolName: pending.toolName }, settle: decision => pending.answer(decision === "allow" ? "allowed-once" : "rejected") };
  }
  if (pending.kind !== "question" && pending.kind !== "plan-review") return null;
  const snapshot = pending.snapshot?.();
  if (!snapshot || snapshot.closed || !["waterfall", "rpc"].includes(snapshot.channel) || pending.review !== undefined ||
    !Array.isArray(pending.questions) || pending.questions.length < 1 || pending.questions.length > 8) return null;
  const items = pending.questions;
  if (items.some(item => !item || typeof item.id !== "string" || typeof item.question !== "string" ||
    (item.options && (!Array.isArray(item.options) || item.options.length > 12)))) return null;
  const fixed = items[0];
  const intent = fixed.intent;
  const optionView = option => ({ label: liveInteractionText(option?.label), detail: liveInteractionText(option?.description) });
  if (items.length === 1 && (pending.kind === "plan-review" || intent?.kind === "approval")) {
    const kind = pending.kind === "plan-review" ? "plan" : "approval";
    const allow = fixed.options?.find(item => item.label === intent?.approve);
    const planSkip = kind === "plan" ? fixed.options?.find(item => item !== allow && /^(?:skip|跳过)$/i.test(liveInteractionText(item?.label).trim())) : null;
    const revise = kind === "plan" && typeof pending.dismiss === "function" && pending.dismissal === "cancel" && snapshot.channel === "waterfall";
    const reject = fixed.options?.find(item => kind === "plan" ? item !== allow && item !== planSkip : item.label === intent?.reject);
    if (!allow || (kind === "approval" && !reject) || fixed.multiSelect) return null;
    const detail = liveInteractionText(fixed.detail ?? intent?.display?.detail?.zh ?? intent?.display?.detail?.en);
    if (kind === "plan" && !detail.trim()) return null;
    const title = liveInteractionText(intent?.display?.question?.zh ?? fixed.question);
    const choices = [allow, reject].filter(Boolean).map(optionView);
    const skip = kind === "approval" ? "approvalQuestion" : planSkip ? "planChoice" : revise ? "revise" : undefined;
    return {
      card: { key: pending.key, kind, title, detail, skip, questions: [{ id: fixed.id, title, detail: "", multiple: false, custom: false, options: choices }] },
      settle(decision) {
        if (decision === "skip" && skip === "approvalQuestion") return pending.answer({ answers: [{ id: fixed.id, selected: [] }] });
        if (decision === "revise" && skip === "revise") return pending.dismiss();
        const option = decision === "allow" ? allow : decision === "reject" ? reject : decision === "skip" ? planSkip : null;
        if (!option) throw new Error("Unavailable decision");
        return pending.answer({ answers: [{ id: fixed.id, selected: [option.label] }] });
      },
    };
  }
  if (items.some(item => item.intent?.kind === "approval" || item.intent?.kind === "plan-review")) return null;
  const questions = items.map(item => ({ id: item.id, title: item.question, detail: liveInteractionText(item.detail),
    multiple: item.multiSelect === true, custom: true, options: (item.options ?? []).map(optionView) }));
  return { card: { key: pending.key, kind: "question", title: "待回答的问题", detail: "", questions }, settle: answers => pending.answer({ answers }) };
}

function liveQuestionAnswers(cards, input) {
  if (!Array.isArray(input) || input.length !== cards.length) return null;
  const seen = new Set();
  const answers = [];
  for (const item of input) {
    const question = cards.find(card => card.id === item?.id);
    if (!question || seen.has(question.id) || !Array.isArray(item.selected) || item.selected.length > question.options.length) return null;
    seen.add(question.id);
    if (item.custom != null && typeof item.custom !== "string") return null;
    const custom = typeof item.custom === "string" ? item.custom.trim() : "";
    if (custom.length > 4000 || (custom && !question.custom)) return null;
    const indices = new Set(item.selected);
    if (indices.size !== item.selected.length || [...indices].some(index => !Number.isInteger(index) || index < 0 || index >= question.options.length)) return null;
    if (item.skipped === true) {
      if (indices.size || custom) return null;
      answers.push({ id: question.id, selected: [] });
      continue;
    }
    if ((!indices.size && !custom) || (!question.multiple && indices.size + Number(!!custom) > 1)) return null;
    answers.push({ id: question.id, selected: [...indices].map(index => question.options[index].label), ...(custom ? { custom } : {}) });
  }
  return answers;
}


function createDesktopCompanionController(ctx) {
  /* 【本插件改动】服务改为惰性读取。
   *
   * 原版在创建控制器时一次性 ctx.get() 取服务：此时若 uiWorkspace / layout /
   * modelDirectories 尚未就绪，取到的就是 undefined，而且永远不会再取。
   * receiveCommands() 的前置条件是 `!workspace`，于是事件流永远建不起来，
   * 宿主广播 watch-interaction 时没有任何客户端接收，审批卡片也就送不到实况窗。
   * 惰性读取让服务就绪后自然可用。 */
  const sessions = ctx.get("sessions");
  const list = sessions?.list;
  const workspaces = ctx.get("workspaces")?.list;
  const uiSession = ctx.get("uiSession");
  // 惰性 getter：每次使用时重新取，服务就绪后即可用。
  const getWorkspace = () => ctx.get("uiWorkspace");
  const getMainPanel = () => ctx.get("layout")?.panelInfo;
  const getModelCatalog = () => ctx.get("modelDirectories")?.catalog?.store;
  const workspace = { get openSession() { return getWorkspace()?.openSession?.bind(getWorkspace()) }, get startSession() { return getWorkspace()?.startSession?.bind(getWorkspace()) } };
  const listeners = new Set();
  const pendingReplies = new Set();
  const consumedReplies = new Set();
  const activeInteractions = new Set();
  const openedNavigation = new Map();
  const lifetime = new AbortController();
  const clientId = window.crypto.randomUUID?.() ?? Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const maxCommandLine = 32 * 1024;
  const maxReply = 4000;
  const composerDrafts = new Map();
  let draftFocus = "";
  let draftLease = "";
  let draftGeneration = 0;
  let state = {
    supported: null, enabled: false, autoCollapse: true, reducedMotion: false, showDetails: true,
    shape: "pill", collapsedDisplay: "amount", completionSound: false, completionFlash: true, busy: false, error: "",
    /* 【本插件新增】宿主级配置项（由 Config schema 派生）。 */
    config: {}, configWritable: false,
  };
  let enabledLifetime = null;
  let releaseList, releaseWorkspaces, releasePanel, releaseModel, releaseCatalog, releaseTheme, releaseConnectionReset;
  let modelStore, viewId = "";
  let namedGroups;
  const modelNames = new Map();
  let viewTimer = 0, retryTimer = 0, retryCount = 0;
  let viewInFlight = false, viewDirty = false, lastView = "", nextViewAt = 0;
  let themeTimer = 0, themeInFlight = false, themeDirty = false, lastTheme = "";
  let stream = null;
  let pendingSession = null;
  let interactionFocus = "", interactionKey = "", interactionRevision = 0;
  let releaseInteractions, releaseCarrier;
  let watchedCarrier;

  function publish(update) {
    if (lifetime.signal.aborted) return;
    state = { ...state, ...update };
    for (const listener of listeners) listener();
  }

  function request(method, payload, signal) {
    return window.fetch("/live-window/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, ...payload }),
      signal,
    });
  }

  function bindModel(id) {
    let store;
    if (id) {
      try {
        store = models?.directoryFor(id)?.store;
      } catch {
        // The session can be removed between reading the catalog and resolving its store.
      }
    }
    if (modelStore === store) return;
    releaseModel?.();
    modelStore = store;
    releaseModel = store?.subscribe(queueView);
  }

  function indexModelNames(groups) {
    if (groups === namedGroups) return;
    namedGroups = groups;
    modelNames.clear();
    for (const group of groups ?? []) {
      modelNames.set(group.id, new Map(group.models.map(model => [model.id, model.name])));
    }
  }

  function exactModelRoute(candidate) {
    const exactId = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max &&
      value === value.trim() && value === value.toWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
    return exactId(candidate?.provider, 200) && exactId(candidate?.model, 512) ? candidate : undefined;
  }

  function readView() {
    const snapshot = list?.getSnapshot();
    const catalog = snapshot?.byId ?? {};
    const statuses = uiSession?.sessionStatus?.getSnapshot();
    const workspaceSnapshot = workspaces?.getSnapshot();
    const archivedIds = workspaceSnapshot?.archivedSessionIds ?? [];
    const archived = new Set(archivedIds);
    const pinned = new Set(workspaceSnapshot?.pinnedSessionIds ?? []);
    const eligible = (id) => Object.hasOwn(catalog, id) && catalog[id].origin !== "subagent" && !archived.has(id);
    const ids = (snapshot?.ids ?? Object.keys(catalog)).filter(eligible);
    /* 【本插件改动】选中的会话不再强依赖 retainedBy.mainView。
     *
     * 原版只挑「主窗口还保留着」的会话。任务结束、或主窗口切到别的会话后，
     * 这个条件对刚才那个会话不再成立，id 退化成 ""——实况窗于是既没有 active，
     * 也把它从 rows 里漏掉，表现就是「任务完成后会话栏消失」。
     *
     * 回退顺序：主窗口保留的 → 最近更新的 → 任意一个。这样实况窗始终至少有一个
     * 可展示/可切换的会话，而不是整条栏空掉。
     */
    const byMainView = (key) => (catalog[key]?.retainedBy?.mainView ?? 0) > 0;
    const freshest = (keys) => keys.slice().sort((a, b) =>
      (catalog[b]?.updatedAt ?? 0) - (catalog[a]?.updatedAt ?? 0))[0] ?? "";
    const id = eligible(viewId) && byMainView(viewId) ? viewId
      : ids.find(byMainView) ?? freshest(ids.filter(eligible)) ?? ids.find(eligible) ?? "";
    viewId = id;
    bindModel(state.showDetails ? id : "");
    const directory = modelStore?.getSnapshot();
    const modelCatalogValue = state.showDetails ? getModelCatalog()?.getSnapshot()?.value : undefined;
    // The selector matches provider and model IDs in this catalog, then shows the model's name.
    indexModelNames(modelCatalogValue?.groups ?? directory?.groups);
    function describe(key, currentSelection) {
      const row = catalog[key];
      const status = statuses?.get(key);
      const updatedAt = Number.isFinite(row?.updatedAt) && row.updatedAt > 0 ? row.updatedAt : 0;
      const attributes = {
        id: key, updatedAt, pinned: pinned.has(key), running: (status?.running ?? row?.running) === true,
        waiting: Boolean(status?.pendingInteraction), completionUnread: status?.completionUnread === true,
      };
      if (!state.showDetails) return { ...attributes, title: "", model: "", provider: "" };
      const projection = snapshot?.projectionsBySession?.[key]?.values?.modelSelection ?? row?.projectionValues?.modelSelection;
      // The DSH picker chooses the projected next route or the configured default;
      // a last-used route is only a fallback while that selector is unresolved.
      const selection = exactModelRoute(currentSelection) ?? exactModelRoute(projection?.next) ??
        exactModelRoute(modelCatalogValue?.default) ?? exactModelRoute(projection?.lastUsed);
      const modelLabel = modelNames.get(selection?.provider)?.get(selection?.model);
      return {
        ...attributes,
        title: typeof row?.displayTitle === "string" ? row.displayTitle.slice(0, 120) : "",
        model: selection?.model ?? "",
        modelLabel: typeof modelLabel === "string" ? modelLabel.slice(0, 120) : "",
        provider: selection?.provider ?? "",
      };
    }
    const active = describe(id, directory?.current);
    const rows = ids.filter((key) => key !== id).map((key) => describe(key))
      .filter((row) => !catalog[row.id].blank || row.running || row.waiting || row.completionUnread || row.pinned)
      .sort((a, b) => Number(b.completionUnread) - Number(a.completionUnread) || Number(b.waiting) - Number(a.waiting) ||
        Number(b.running) - Number(a.running) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, 100);
    const viewed = document.visibilityState === "visible" && document.hasFocus() && getMainPanel()?.getSnapshot()?.activePanelId == null;
    return { ...active, rows, viewed, clientId, archivedIds };
  }

  function queueView() {
    if (!enabledLifetime) return;
    viewDirty = true;
    if (viewTimer || viewInFlight) return;
    viewTimer = window.setTimeout(() => void sendView(), Math.max(0, nextViewAt - Date.now()));
  }

  async function sendView() {
    viewTimer = 0;
    const current = enabledLifetime;
    if (!current) return;
    viewDirty = false;
    nextViewAt = Date.now() + 100;
    const view = readView();
    const key = JSON.stringify(view);
    if (key === lastView) return;
    viewInFlight = true;
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
      const response = await request("companion-view", view, signal);
      if (response.ok && current === enabledLifetime) lastView = key;
    } catch {
      // A later catalog change, refocus or reconnect will re-submit the current view.
    } finally {
      if (current === enabledLifetime) {
        viewInFlight = false;
        if (viewDirty) queueView();
      }
    }
  }

  function queueTheme() {
    if (!enabledLifetime) return;
    themeDirty = true;
    if (themeInFlight || themeTimer) return;
    themeTimer = window.setTimeout(() => void sendTheme(), 80);
  }

  async function sendTheme() {
    themeTimer = 0;
    const current = enabledLifetime;
    if (!current) return;
    themeDirty = false;
    const resolved = appearance.getSnapshot();
    const palette = resolved?.effectivePalette;
    if (!resolved?.ready || !palette) return;
    const scheme = resolved.colorScheme === "light" ? "light" : "dark";
    const colors = [palette.accent, palette.composer, palette.text];
    if (colors.some((value) => !/^#[a-f0-9]{6}$/i.test(value))) return;
    const [accent, surface, foreground] = colors.map((color) => color.slice(1).toLowerCase());
    const key = `${scheme}:${accent}:${surface}:${foreground}`;
    if (key === lastTheme) return;
    themeInFlight = true;
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
      const response = await request("companion-theme", { scheme, accent, surface, foreground }, signal);
      if (response.ok && current === enabledLifetime) lastTheme = key;
    } catch {
      // Theme changes or refocus can resume a temporarily unavailable connection.
    } finally {
      if (current === enabledLifetime) {
        themeInFlight = false;
        if (themeDirty) queueTheme();
      }
    }
  }

  function eligibleSession(id) {
    const catalog = list?.getSnapshot()?.byId ?? {};
    if (!Object.hasOwn(catalog, id) || catalog[id].origin === "subagent" || workspaces?.getSnapshot()?.archivedSessionIds?.includes(id)) return null;
    return catalog[id];
  }

  function interactionAccess(id) {
    if (!eligibleSession(id) || !uiSession?.whenAccess) return false;
    let allowed = false;
    try {
      uiSession.whenAccess(id, "session/prompt", () => { allowed = true; return () => {}; })();
    } catch { return false; }
    return allowed;
  }

  function composerDraft(entry) {
    const input = entry.input;
    if (!input || !eligibleSession(entry.id) || !interactionAccess(entry.id)) return null;
    const snapshot = input.state.getSnapshot();
    const uploads = entry.conversation.fileUploads.getSnapshot();
    const key = JSON.stringify([snapshot.draftRev, snapshot.attachmentIds]);
    if (key !== entry.key) {
      entry.key = key;
      entry.revision++;
    }
    const text = snapshot.draft;
    const attachments = entry.conversation.resolveDraftAttachments(snapshot.attachmentIds.slice(0, 12)).map(item => ({
      id: item.id, kind: item.kind,
      name: (item.file.name || (item.kind === "image" ? "图片" : "附件")).slice(0, 180).toWellFormed(),
      status: uploads[item.id]?.status ?? "ready",
      size: item.file.size,
    }));
    const session = entry.reference.binding.session.getSnapshot();
    const editable = snapshot.phase === "plain" && !session.removed && session.subagent === null &&
      !entry.block?.getSnapshot() && text.length <= maxReply && snapshot.attachmentIds.length <= 12 &&
      !snapshot.occurrences.length && !input.draftSnapshot?.quotes?.length;
    return {
      id: entry.id, revision: clientId + ":" + entry.generation + ":" + entry.revision,
      text: text.slice(0, maxReply).toWellFormed(), editable, attachments,
    };
  }

  function releaseComposerDraft(entry) {
    if (composerDrafts.get(entry.id) !== entry) return;
    composerDrafts.delete(entry.id);
    window.clearTimeout(entry.timer);
    entry.releases.forEach(drop => drop());
    entry.reference.release();
  }

  function pruneComposerDrafts() {
    for (const entry of composerDrafts.values()) {
      const draft = entry.input?.state.getSnapshot();
      if (!eligibleSession(entry.id) || (entry.id !== draftFocus && !entry.busy && !draft?.draft && !draft?.attachmentIds.length)) {
        releaseComposerDraft(entry);
      }
    }
  }

  function publishComposerDraft(entry) {
    if (entry.id !== draftFocus || !enabledLifetime || entry.timer) return;
    entry.timer = window.setTimeout(() => {
      entry.timer = 0;
      if (entry.id !== draftFocus || !enabledLifetime || composerDrafts.get(entry.id) !== entry) return;
      const draft = composerDraft(entry);
      if (!draft) return;
      const key = JSON.stringify(draft);
      if (key === entry.posted) return;
      entry.posted = key;
      const signal = AbortSignal.any([enabledLifetime.signal, AbortSignal.timeout(4000)]);
      void request("companion-draft-state", {
        id: entry.id, clientId, lease: draftLease, draft: { ...draft, sequence: ++entry.sent },
      }, signal).then(response => {
        if (!response.ok && entry.posted === key) entry.posted = "";
      }).catch(() => { if (entry.posted === key) entry.posted = ""; });
    }, 24);
  }

  function watchComposerDraft(id, lease) {
    draftFocus = typeof id === "string" && id.length <= 256 ? id : "";
    draftLease = typeof lease === "string" ? lease : "";
    pruneComposerDrafts();
    if (!draftFocus || !draftLease || !enabledLifetime || !eligibleSession(draftFocus) || !interactionAccess(draftFocus)) return;
    const existing = composerDrafts.get(draftFocus);
    if (existing) {
      existing.posted = "";
      publishComposerDraft(existing);
      return;
    }
    if (!sessions?.retain || composerDrafts.size >= 8) return;
    const conversation = ctx.get("conversation");
    if (!conversation?.input?.for || !conversation?.createDrafts || !conversation?.resolveDraftAttachments ||
        !conversation?.releaseDraftAttachment || !conversation?.fileUploads?.subscribe) return;
    let reference;
    try {
      reference = sessions.retain(draftFocus, { source: "whaleLiveWindow" });
    } catch { return; }
    const entry = {
      id: draftFocus, reference, conversation, input: undefined, releases: [], timer: 0,
      generation: ++draftGeneration, revision: 0, sent: 0, key: "", posted: "", busy: false,
    };
    composerDrafts.set(entry.id, entry);
    void reference.ready.then(binding => {
      if (composerDrafts.get(entry.id) !== entry || !enabledLifetime || !eligibleSession(entry.id)) return;
      entry.input = conversation.input.for(binding.ctx);
      entry.block = conversation.blocks?.storeFor(entry.id);
      const changed = () => {
        if (entry.id === draftFocus) publishComposerDraft(entry);
        else pruneComposerDrafts();
      };
      entry.releases.push(entry.input.state.subscribe(changed), conversation.fileUploads.subscribe(changed));
      if (entry.block) entry.releases.push(entry.block.subscribe(changed));
      publishComposerDraft(entry);
    }).catch(() => releaseComposerDraft(entry));
  }

  async function fetchComposerFiles(files, signal) {
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
    const output = [];
    for (const file of files) {
      const response = await request("companion-draft-file", { clientId, key: file.key }, signal);
      if (!response.ok) throw Error("附件不可读，请重新选择文件。");
      // A Blob lets Chromium use its backing store instead of copying bytes through a JS ArrayBuffer.
      const data = await response.blob();
      const extension = file.name.split(".").at(-1).toLowerCase();
      output.push(new File([data], file.name, { type: Object.hasOwn(mime, extension) ? mime[extension] : "application/octet-stream" }));
    }
    return output;
  }

  function submitComposerDraft(entry, signal) {
    const input = entry.input;
    const original = input.state.getSnapshot();
    return new Promise(resolve => {
      let timer;
      let release;
      const finish = success => {
        release?.();
        window.clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        resolve(success);
      };
      const aborted = () => finish(false);
      const check = () => {
        const now = input.state.getSnapshot();
        if (now.phase !== "plain" && now.phase !== "claimed") return;
        if (now === original) return;
        finish(!now.draft && !now.attachmentIds.length);
      };
      release = input.state.subscribe(check);
      signal.addEventListener("abort", aborted, { once: true });
      timer = window.setTimeout(aborted, 18000);
      try {
        input.submit("queue", "click");
        if (input.state.getSnapshot() === original) finish(false);
      } catch { finish(false); }
    });
  }

  async function changeComposerDraft(command, current) {
    const { id, requestId, lease, action, revision, text, attachmentId, files } = command;
    if (typeof requestId !== "string" || requestId.length > 128 || consumedReplies.has(requestId)) return;
    consumedReplies.add(requestId);
    if (consumedReplies.size > 256) consumedReplies.delete(consumedReplies.values().next().value);
    const entry = composerDrafts.get(id);
    const before = entry && composerDraft(entry);
    let error = "";
    let ownsEntry = false;
    const changeText = action === "text" || action === "submit";
    try {
      if (!entry || entry.busy || id !== draftFocus || lease !== draftLease || !before?.editable || changeText && revision !== before.revision) {
        throw Error("草稿已更新或需在主界面处理。");
      }
      if (changeText && text !== undefined && (typeof text !== "string" || text.length > maxReply)) throw Error("草稿内容太长。");
      entry.busy = true;
      ownsEntry = true;
      const { conversation, input } = entry;
      const signal = action === "add" ? current.signal : AbortSignal.any([current.signal, AbortSignal.timeout(20000)]);
      if (action === "add") {
        if (!Array.isArray(files) || !files.length || files.length > 8) throw Error("附件内容无效。");
        const next = await fetchComposerFiles(files, signal);
        const live = composerDraft(entry);
        if (signal.aborted || !live?.editable || id !== draftFocus || lease !== draftLease || live.attachments.length + next.length > 12) {
          throw Error("会话已切换或附件已满。");
        }
        const staged = conversation.createDrafts(id, next, true);
        if (!input.addAttachments(staged.map(item => item.id))) {
          for (const item of staged) conversation.releaseDraftAttachment(item.id);
          throw Error("会话暂时无法添加附件。");
        }
      } else if (action === "remove") {
        if (!input.removeAttachment(attachmentId)) throw Error("附件已移除或正在发送。");
        conversation.releaseDraftAttachment(attachmentId);
      } else if (changeText) {
        if (action === "submit") {
          const session = entry.reference.binding.session.getSnapshot();
          if (session.running || session.awaitingFirstTurn || session.pendingSubmissions?.length ||
              before.attachments.some(item => item.status !== "ready")) throw Error("请等当前回复和附件上传完成。");
        }
        if (text !== undefined && text !== before.text) input.setDraft(text);
        if (action === "submit") {
          const next = input.state.getSnapshot();
          if ((!next.draft.trim() && !next.attachmentIds.length) || !await submitComposerDraft(entry, signal)) {
            throw Error("未能发送，草稿仍可在主界面查看。");
          }
        }
      } else throw Error("草稿操作无效。");
    } catch (err) {
      error = err instanceof Error ? err.message : "草稿操作未完成。";
    } finally {
      if (ownsEntry) entry.busy = false;
    }
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
      const draft = entry && composerDraft(entry);
      await request("companion-draft-result", {
        id, clientId, requestId, lease, ok: !error, error, draft: draft && { ...draft, sequence: ++entry.sent },
      }, signal);
    } catch { /* The original operation is not safe to replay. */ }
    if (entry) publishComposerDraft(entry);
    pruneComposerDrafts();
  }

  function currentInteraction(id) {
    const interaction = eligibleSession(id) ? uiSession?.sessionStatus?.getSnapshot()?.get(id)?.pendingInteraction : null;
    return interaction?.sessionId === id ? interaction : null;
  }

  function refreshInteraction() {
    const current = enabledLifetime;
    const id = interactionFocus;
    if (!current || !id) return;
    const carrier = currentInteraction(id);
    if (watchedCarrier !== carrier) {
      releaseCarrier?.();
      watchedCarrier = carrier;
      releaseCarrier = carrier?.subscribe?.(refreshInteraction);
    }
    const definition = liveInteractionDefinition(carrier);
    /* 【本插件改动】审批卡片不再由 session/prompt 的可用性把关。
     * 审批恰恰发生在回合运行期间，此时 session/prompt 可能被判为不可用，
     * 原逻辑会在这里把 interaction 置成 null，窗口于是永远收不到卡片
     * ——「有提示却无法完成审批」的另一半原因。没有作答权限时自然也不可能
     * 提交成功，这层判断交给真正的提交路径去拒绝。 */
    const permitted = carrier?.kind === "approval" ? true : interactionAccess(id);
    const interaction = definition && permitted ? definition.card : null;
    const key = JSON.stringify(interaction);
    if (interactionKey === key) return;
    interactionKey = key;
    const revision = ++interactionRevision;
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(5000)]);
    void request("companion-interaction", { id, clientId, revision, interaction }, signal).then(response => {
      if (!response.ok && interactionFocus === id && interactionRevision === revision) interactionKey = "";
    }).catch(() => { if (interactionFocus === id && interactionRevision === revision) interactionKey = ""; });
  }

  function watchInteraction(id) {
    releaseCarrier?.();
    releaseCarrier = undefined;
    watchedCarrier = undefined;
    interactionFocus = typeof id === "string" && id.length <= 256 ? id : "";
    interactionKey = "";
    refreshInteraction();
  }

  async function submitInteraction({ id, key, requestId, decision, answers }, current) {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || consumedReplies.has(requestId)) return;
    consumedReplies.add(requestId);
    if (consumedReplies.size > 256) consumedReplies.delete(consumedReplies.values().next().value);
    let error = "请求已失效，或无权限处理。";
    const carrier = id === interactionFocus && currentInteraction(id);
    /* 【本插件改动】与 refreshInteraction 保持一致：审批不以 session/prompt 可用性为前提。 */
    const permitted = carrier?.kind === "approval" ? true : interactionAccess(id);
    if (!current.signal.aborted && carrier && carrier.key === key && !activeInteractions.has(carrier) && permitted) {
      const definition = liveInteractionDefinition(carrier);
      if (definition) {
        const isQuestion = definition.card.kind === "question";
        const skip = definition.card.skip;
        const supportedDecision = decision === "allow" || decision === "reject" ||
          (decision === "skip" && ["approvalQuestion", "planChoice"].includes(skip)) ||
          (decision === "revise" && skip === "revise");
        const value = isQuestion ? liveQuestionAnswers(definition.card.questions, answers) : supportedDecision ? decision : null;
        if (value === null) error = "请填写完整的答案或选择操作。";
        else {
          activeInteractions.add(carrier);
          try {
            await definition.settle(value);
            error = "";
          } catch {
            error = "DSH 未接受该操作，请查看请求是否仍待处理。";
          } finally { activeInteractions.delete(carrier); }
        }
      }
    }
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
      await request("companion-interaction-result", { clientId, requestId, ok: !error, error }, signal);
    } catch { /* A lost receipt never retries the human's decision. */ }
    refreshInteraction();
  }

  function openPendingSession() {
    if (!pendingSession) return;
    if (pendingSession.expires <= Date.now()) {
      pendingSession = null;
      return;
    }
    const { id, requestId } = pendingSession;
    if (!eligibleSession(id)) return;
    pendingSession = null;
    try {
      workspace.openSession(id);
    } catch {
      // The session can be removed while the desktop window is being restored.
      return;
    }
    openedNavigation.set(requestId, id);
    if (openedNavigation.size > 32) openedNavigation.delete(openedNavigation.keys().next().value);
    acknowledgeNavigation(id, requestId);
  }

  function acknowledgeNavigation(id, requestId) {
    const current = enabledLifetime;
    if (!current) return;
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
    void request("companion-navigation-result", { clientId, id, requestId }, signal).catch(() => {});
  }

  function receiveNavigation(command) {
    const { id, requestId, expires } = command;
    if (typeof id !== "string" || !id || id.length > 256 || typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(requestId) || !Number.isFinite(expires) || expires <= Date.now()) return;
    const opened = openedNavigation.get(requestId);
    if (opened) {
      if (opened === id) acknowledgeNavigation(id, requestId);
      return;
    }
    pendingSession = { id, requestId, expires };
    openPendingSession();
  }

  async function submitReply({ id, text, requestId }, current) {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || consumedReplies.has(requestId)) return;
    consumedReplies.add(requestId);
    if (consumedReplies.size > 256) consumedReplies.delete(consumedReplies.values().next().value);
    let error = "";
    const validId = typeof id === "string" && id.length > 0 && id.length <= 256;
    if (!validId || typeof text !== "string" || !text.trim() || text.length > maxReply) {
      error = "请输入 1 至 4000 个字符。";
    } else if (pendingReplies.has(id)) {
      error = "上一条回复正在发送。";
    } else {
      pendingReplies.add(id);
      try {
        const initial = eligibleSession(id);
        if (!initial) {
          error = "该会话已归档或无法访问。";
        } else if (initial.running) {
          error = "该会话正在思考，请稍后回复。";
        } else if (!sessions?.using || !uiSession?.whenAccess) {
          error = "当前 DSH 会话服务无法发送。";
        } else {
          await sessions.using(id, { source: "whaleLiveWindow", signal: current.signal }, (reference) => {
            const row = eligibleSession(id);
            const { ctx: scope, session } = reference.binding;
            const snapshot = session.getSnapshot();
            if (!row || snapshot.removed || snapshot.subagent || current.signal.aborted) {
              error = "该会话已归档或无法访问。";
              return;
            }
            if (row.running || snapshot.running || snapshot.awaitingFirstTurn || snapshot.pendingSubmissions?.length) {
              error = "该会话正在思考或发送，请稍后回复。";
              return;
            }
            if (snapshot.openState !== "open" || (row.blank && !workspaces?.getSnapshot()?.items?.some((item) => item.sessionIds?.includes(id)))) {
              error = "请先在 DSH 主界面打开会话并选择工作区。";
              return;
            }
            let allowed = false;
            uiSession.whenAccess(id, "session/prompt", () => {
              allowed = true;
              return () => {};
            })();
            const conversation = scope.get("conversation");
            if (!allowed || !conversation?.send) {
              error = "当前会话没有发送权限。";
              return;
            }
            if (conversation.blocks.storeFor(id).getSnapshot()) {
              error = "请先在主界面处理当前会话的输入提示。";
              return;
            }
            return conversation.send(text);
          });
        }
      } catch {
        error = "发送状态未确认，请先到 DSH 查看。";
      } finally {
        pendingReplies.delete(id);
      }
    }
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(4000)]);
      await request("companion-result", { clientId, requestId, ok: !error, error }, signal);
    } catch {
      // A lost receipt must not cause a second submission.
    }
    queueView();
  }

  async function receiveCommands() {
    if (!enabledLifetime || stream) return;
  // uiWorkspace 可能尚未就绪；此时不放弃，稍后由 onActivate/重试再次尝试。
  if (!getWorkspace()) return;
    const connection = new AbortController();
    stream = connection;
    const initialTimeout = window.setTimeout(() => connection.abort(), 4000);
    try {
      const response = await request("companion-events", { clientId }, connection.signal);
      window.clearTimeout(initialTimeout);
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!connection.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || connection.signal.aborted) break;
          pending += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line || line.length > maxCommandLine) continue;
            try {
              const command = JSON.parse(line);
              if (command?.enabled === false) {
                configure(false);
                publish({ enabled: false, error: "" });
                break;
              }
              if (command?.error === "launch") publish({ error: "launch" });
              if (command?.type === "reply" && enabledLifetime) {
                void submitReply(command, enabledLifetime);
              } else if (command?.type === "interaction" && enabledLifetime) {
                void submitInteraction(command, enabledLifetime);
              } else if (command?.type === "watch-interaction") {
                watchInteraction(command.id);
              } else if (command?.type === "watch-draft") {
                watchComposerDraft(command.id, command.lease);
              } else if (command?.type === "draft" && enabledLifetime) {
                void changeComposerDraft(command, enabledLifetime);
              } else if (command?.type === "new") {
                pendingSession = null;
                workspace.startSession();
              } else if (command?.type === "open") {
                retryCount = 0;
                receiveNavigation(command);
              }
            } catch {
              // Ignore stale or malformed commands without affecting other client UI.
            }
          }
          if (pending.length > maxCommandLine) break;
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      // Reconnect after brief transport interruptions without periodic polling.
    } finally {
      window.clearTimeout(initialTimeout);
      if (stream === connection) {
        stream = null;
        if (enabledLifetime && retryCount < 2) {
          retryTimer = window.setTimeout(() => {
            retryTimer = 0;
            void receiveCommands();
          }, ++retryCount * 1000);
        }
      }
    }
  }

  function onActivate() {
    queueView();
    if (document.visibilityState === "hidden") return;
    openPendingSession();
    queueTheme();
    if (!stream && !retryTimer) {
      retryCount = 0;
      void receiveCommands();
    }
  }

  function onConnectionReset() {
    if (!enabledLifetime) return;
    stream?.abort();
    stream = null;
    window.clearTimeout(retryTimer);
    retryTimer = retryCount = 0;
    void receiveCommands();
  }

  function configure(enabled) {
    if (enabled === Boolean(enabledLifetime)) return;
    if (!enabled) {
      enabledLifetime.abort();
      enabledLifetime = null;
      stream?.abort();
      stream = null;
      window.clearTimeout(viewTimer);
      window.clearTimeout(retryTimer);
      window.clearTimeout(themeTimer);
      window.removeEventListener("focus", onActivate);
      window.removeEventListener("blur", onActivate);
      document.removeEventListener("visibilitychange", onActivate);
      viewTimer = retryTimer = retryCount = nextViewAt = 0;
      releaseList?.();
      releaseList = undefined;
      releaseWorkspaces?.();
      releaseWorkspaces = undefined;
      releasePanel?.();
      releasePanel = undefined;
      releaseCatalog?.();
      releaseCatalog = undefined;
      indexModelNames();
      releaseTheme?.();
      releaseTheme = undefined;
      releaseConnectionReset?.();
      releaseConnectionReset = undefined;
      releaseInteractions?.();
      releaseInteractions = undefined;
      watchInteraction("");
      draftFocus = "";
      draftLease = "";
      for (const entry of composerDrafts.values()) releaseComposerDraft(entry);
      bindModel("");
      viewId = lastView = "";
      pendingSession = null;
      openedNavigation.clear();
      viewInFlight = viewDirty = false;
      themeInFlight = themeDirty = false;
      themeTimer = 0;
      lastTheme = "";
      return;
    }
    enabledLifetime = new AbortController();
    releaseList = list?.subscribe(() => {
      openPendingSession();
      queueView();
      refreshInteraction();
      pruneComposerDrafts();
    });
    releaseWorkspaces = workspaces?.subscribe(() => {
      openPendingSession();
      queueView();
      refreshInteraction();
      pruneComposerDrafts();
    });
    releasePanel = getMainPanel()?.subscribe(queueView);
    releaseCatalog = getModelCatalog()?.subscribe(queueView);
    releaseTheme = appearance.subscribe(queueTheme);
    releaseInteractions = uiSession?.sessionStatus?.subscribe(() => {
      refreshInteraction();
      queueView();
    });
    releaseConnectionReset = ctx.on?.("connection/reset", onConnectionReset);
    window.addEventListener("focus", onActivate);
    window.addEventListener("blur", onActivate);
    document.addEventListener("visibilitychange", onActivate);
    queueView();
    queueTheme();
    void receiveCommands();
    /* 【本插件改动】uiWorkspace 等服务可能晚于本控制器创建才就绪。
     * 原版只在 configure() 里建流一次，服务没就绪就永远连不上宿主，
     * 审批卡片因此送不到实况窗。这里补一段有上限的重试。 */
    if (!getWorkspace()) {
      let attempts = 0;
      const retry = window.setInterval(() => {
        attempts += 1;
        if (!enabledLifetime || stream || getWorkspace()) {
          window.clearInterval(retry);
          if (enabledLifetime && !stream) void receiveCommands();
          return;
        }
        if (attempts >= 20) window.clearInterval(retry);
      }, 500);
    }
  }

  async function updateFromHost(method, payload, error) {
    if (state.busy || lifetime.signal.aborted) return;
    publish({ busy: true, error: "" });
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]);
      const response = await request(method, payload, signal);
      if (!response.ok) throw new Error("Live Window settings unavailable");
      const result = await response.json();
      if (result?.ok !== true || typeof result.value?.supported !== "boolean" || typeof result.value.enabled !== "boolean") {
        throw new Error("Invalid Live Window settings");
      }
      if (lifetime.signal.aborted) return;
      const { supported, enabled } = result.value;
      configure(supported && enabled);
      publish({
        supported, enabled: supported && enabled,
        autoCollapse: result.value.autoCollapse !== false,
        reducedMotion: result.value.reducedMotion === true,
        showDetails: result.value.showDetails !== false,
        shape: ["pill", "notch", "minimal"].includes(result.value.shape) ? result.value.shape : "pill",
        collapsedDisplay: ["amount", "status", "title", "detail"].includes(result.value.collapsedDisplay) ? result.value.collapsedDisplay : "amount",
        completionSound: result.value.completionSound === true,
        completionFlash: result.value.completionFlash !== false,
        busy: false, error: supported && enabled && result.value.error ? "launch" : "",
      });
      queueView();
    } catch {
      publish({ error, busy: false });
    }
  }

  /* 【本插件新增】宿主级配置（autoStart / showBalance / debug / executable）。
   *
   * 与「显示实况窗」这类窗口偏好不同：这些写在 profile 的 patch 里，由宿主
   * 的 configEditor 写回。失败时保留旧值并提示用户，不吞掉错误。 */
  async function loadConfig() {
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]);
      const response = await request("live-window-config-get", {}, signal);
      if (!response.ok) return;
      const result = await response.json();
      if (result?.ok !== true || lifetime.signal.aborted) return;
      publish({
        config: result.value?.config ?? {},
        configWritable: result.value?.writable === true,
      });
    } catch { /* 配置读不到时保留默认值，不影响窗口本身 */ }
  }

  async function setConfig(key, value) {
    if (state.configWritable !== true) return;
    publish({ busy: true, error: "" });
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]);
      const response = await request("live-window-config-set", { config: { [key]: value } }, signal);
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error("Configuration was not saved");
      if (lifetime.signal.aborted) return;
      publish({ config: result.value?.config ?? state.config, busy: false, error: "" });
    } catch {
      publish({ busy: false, error: "save" });
      await loadConfig();
    }
  }

  const load = () => updateFromHost("companion-get", {}, "load");
  void load();
  void loadConfig();
  return {
    load,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPreference: (key, value) => state[key] === value ? Promise.resolve() : updateFromHost("companion-set", { [key]: value }, "save"),
    setConfig: (key, value) => setConfig(key, value),
    dispose() {
      configure(false);
      lifetime.abort();
      listeners.clear();
    },
  };
}

    // ── 组装 ─────────────────────────────────────────────────────────────

    /* 原版把这三段放在同一模块作用域，由 OceanSettings 通过 renderSlot 渲染进
     * 「鲸梦主题」分区。拆出来后本插件是独立分区，所以这里自己注册 settings.section。 */
    function createSettingsSection(ctx) {
      const controller = createDesktopCompanionController(ctx);
      const style = document.createElement('style');
      style.dataset.whaleLiveWindow = '';
      style.textContent = companionSettingsCss;
      document.head.append(style);
      const tr = (zh, en) => (currentLanguage(ctx) === 'en' ? en : zh);

      function Panel() {
        const state = import_react12.useSyncExternalStore(
          controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        return import_jsx_runtime12.jsx(DesktopCompanionSettings, {
          controller: controller, state: state, tr: tr,
        });
      }

      let release;
      try {
        release = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'whale-live-window',
          order: 60,
          label: () => tr('实况窗', 'Live Window'),
        }, Panel));
      } catch (error) {
        console.warn('[live-window] settings section unavailable:', error && error.message);
      }

      return {
        dispose() {
          try { release?.(); } catch { /* 已释放 */ }
          try { controller.dispose(); } catch { /* 已释放 */ }
          style.remove();
        },
      };
    }

    /** 当前语言：优先跟随 DSH，其次浏览器。 */
    function currentLanguage(ctx) {
      try {
        const value = ctx.locale.bind('whale-live-window')('language');
        if (value === 'en' || value === 'zh') return value;
      } catch { /* 语言服务缺失 */ }
      return String((typeof navigator !== 'undefined' && navigator.language) || 'zh')
        .toLowerCase().startsWith('en') ? 'en' : 'zh';
    }

    /* inject 只放一定存在的服务。原版的 sessions / modelDirectories / workspaces /
     * uiWorkspace / conversation 都在控制器里用 ctx.get() 惰性读取——保持一致。
     * 硬塞进 inject 会让插件永久 pending，apply 一次都不跑（第一版就是这么坏的）。 */
    exports.inject = ['slots', 'locale', 'theme', 'uiSession'];

    exports.apply = function apply(ctx) {
      try { ctx.locale.register('whale-live-window', { zh: { language: 'zh' }, en: { language: 'en' } }); }
      catch { /* 语言服务缺失 */ }
      bindAppearance(ctx);
      const section = createSettingsSection(ctx);
      ctx.effect(() => () => section.dispose(), 'whale-live-window: live window settings');
    };

    return module.exports;
  },
});
