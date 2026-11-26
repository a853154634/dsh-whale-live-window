import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

/* 宿主下发的配置：测试可以改它来模拟不同的选择。 */
let hostConfig = { skin: 'cream', themeMode: 'follow' };

const clientSource = new URL('../lib/client/index.js', import.meta.url);
const source = await fs.readFile(clientSource, 'utf8');
let registration;

globalThis.window = {
  __ModuleLoader__: { load: (v) => { registration = v; } },
  addEventListener() {}, removeEventListener() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  fetch: async (url, options) => {
    const method = options && options.body ? JSON.parse(options.body).method : '';
    if (method === 'live-window-config-get') {
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          value: {
            config: hostConfig,
            writable: true,
            catalog: {
              skins: [
                { id: 'follow', label: { zh: '跟随 DSH', en: 'Follow DSH' }, description: { zh: '沿用 DSH 配色。', en: 'Use the DSH palette.' } },
                { id: 'cream', label: { zh: '奶油', en: 'Cream' }, description: { zh: '暖白底色。', en: 'Warm paper.' } },
              ],
              themeModes: [
                { id: 'follow', label: { zh: '跟随 DSH', en: 'Follow DSH' } },
                { id: 'light', label: { zh: '浅色', en: 'Light' } },
                { id: 'dark', label: { zh: '深色', en: 'Dark' } },
              ],
              opacity: { supported: true, min: 25, max: 100, current: 75 },
            },
          },
        }),
        body: null, arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        value: {
          supported: true, enabled: true, autoCollapse: true, reducedMotion: false,
          showDetails: true, shape: 'pill', collapsedDisplay: 'amount',
          completionSound: true, completionFlash: true, busy: false, error: '',
        },
      }),
      body: null, arrayBuffer: async () => new ArrayBuffer(0),
    };
  },
};
globalThis.document = {
  visibilityState: 'visible', hasFocus: () => true,
  addEventListener() {}, removeEventListener() {},
  head: { append() {} },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
};
globalThis.AudioContext = function () {
  return {
    decodeAudioData: async () => ({}),
    createBufferSource: () => ({ connect() {}, start() {}, set onended(v) {} }),
    destination: {}, close() {},
  };
};

new Function('window', 'document', 'navigator', 'AbortSignal', 'AudioContext', source)(
  globalThis.window, globalThis.document, { language: 'zh-CN' }, AbortSignal, globalThis.AudioContext,
);

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useId: () => 'id-' + (useIdCounter++),
};
let useIdCounter = 0;
const jsx = { jsx: (t, p) => ({ type: t, props: { ...p } }), jsxs: (t, p) => ({ type: t, props: { ...p } }), Fragment: 'fragment' };

const exports = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return jsx;
  throw new Error('unexpected require: ' + specifier);
});

const registered = [];
const ctx = {
  get: () => undefined,
  on: () => () => {},
  effect: (f) => { f(); return () => {}; },
  slots: { inject: (n, run) => run(), register: (o, c) => { registered.push({ o, c }); return () => {}; } },
  locale: { register: () => {}, bind: () => () => 'zh' },
  theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
};
exports.apply(ctx);

/* 控制器的配置是异步读的（loadConfig 是 async），所以渲染之前要等它落地，
 * 否则面板拿到的是空配置。 */
await new Promise((resolve) => setTimeout(resolve, 50));

const Panel = registered[0].c;
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error && error.message || error)); }
}

// Render the panel deeply: Panel -> DesktopCompanionSettings -> Toggle children.
function deepRender(element, depth = 0) {
  if (!element || typeof element !== 'object') return element;
  if (typeof element.type === 'function') {
    return deepRender(element.type(element.props), depth + 1);
  }
  if (Array.isArray(element.props?.children)) {
    element.props.children = element.props.children.map((child) => deepRender(child, depth + 1));
  }
  return element;
}

/** 找到某个 aria-label 的分段控件（role=group）里的按钮。 */
function findGroup(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.role === 'group' && node.props?.['aria-label'] === label) {
    const buttons = [];
    const collect = (child) => {
      if (!child || typeof child !== 'object') return;
      if (child.type === 'button') { buttons.push(child); return; }
      const children = child.props?.children;
      if (Array.isArray(children)) children.forEach(collect);
      else if (children && typeof children === 'object') collect(children);
    };
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(collect);
    else collect(children);
    return buttons;
  }
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findGroup(child, label);
      if (found) return found;
    }
  } else if (children && typeof children === 'object') {
    return findGroup(children, label);
  }
  return null;
}

await check('settings panel renders without ReferenceError', () => {
  const element = Panel({});
  const rendered = deepRender(element);
  if (!rendered) throw new Error('panel produced no tree');
});

await check('panel contains the expected controls', () => {
  const rendered = deepRender(Panel({}));
  const labels = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props?.['aria-label']) labels.push(node.props['aria-label']);
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else if (children && typeof children === 'object') visit(children);
  };
  visit(rendered);
  const text = JSON.stringify(rendered);
  for (const needle of ['显示实况窗', '自动收起', '完成提示音', '启动 DSH 时自动打开', '显示余额与费用', '调试模式']) {
    if (!text.includes(needle)) throw new Error('missing control: ' + needle);
  }
  for (const label of ['自动收起', '完成提示音', '显示会话详情']) {
    if (!labels.includes(label)) throw new Error('missing switch aria-label: ' + label);
  }
});

await check('stylesheet uses DSH theme tokens, not --wd-* variables', async () => {
  const css = await fs.readFile(clientSource, 'utf8');
  const match = css.match(/var companionSettingsCss = `([\s\S]*?)`;/);
  if (!match) throw new Error('css block not found');
  if (match[1].includes('--wd-')) throw new Error('stylesheet still uses --wd-* variables');
  if (!match[1].includes('--dsw-alias-label-primary')) throw new Error('stylesheet does not use DSH theme tokens');
});

await check('the panel renders the skin and light/dark controls', async () => {
  const rendered = deepRender(Panel({}));
  const text = JSON.stringify(rendered);
  for (const needle of ['配色皮肤', '明暗模式', '配色']) {
    if (!text.includes(needle)) throw new Error('missing control: ' + needle);
  }
  const groups = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props?.role === 'group' && node.props?.['aria-label']) groups.push(node.props['aria-label']);
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else if (children && typeof children === 'object') visit(children);
  };
  visit(rendered);
  for (const label of ['配色皮肤', '明暗模式']) {
    if (!groups.includes(label)) throw new Error('missing segmented control: ' + label);
  }
});

await check('the skin control offers every skin from the host catalog', async () => {
  const rendered = deepRender(Panel({}));
  const buttons = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && node.props?.children !== undefined) {
      buttons.push(node.props.children);
    }
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else if (children && typeof children === 'object') visit(children);
  };
  visit(rendered);
  /* 宿主给的清单是「跟随 DSH / 奶油」两个皮肤与三个明暗模式，
   * 面板必须把它们都渲染出来，而不是自己抄一份。 */
  for (const needle of ['跟随 DSH', '奶油', '浅色', '深色']) {
    if (!buttons.includes(needle)) throw new Error('skin control is missing an option: ' + needle);
  }
});

await check('the skin control stays usable without the desktop host', async () => {
  /* 配色是宿主级设置（写 profile 配置），跟「窗口能不能开」无关，
   * 所以在 Web 版里也必须可点。 */
  const rendered = deepRender(Panel({}));
  let allDisabled = true;
  let seen = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && typeof node.props?.children === 'string'
        && ['跟随 DSH', '奶油'].includes(node.props.children)) {
      seen++;
      if (node.props.disabled !== true) allDisabled = false;
    }
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else if (children && typeof children === 'object') visit(children);
  };
  visit(rendered);
  if (seen < 2) throw new Error('the skin buttons were not found');
  if (allDisabled) throw new Error('the skin buttons are disabled without the desktop host');
});

await check('following the DSH skin pins the light/dark control to "follow"', async () => {
  /* 「跟随 DSH」皮肤时明暗由 DSH 决定，这一组应显示为「跟随 DSH」选中且禁用。
   * 控制器在 apply() 时就把配置读进自己的 state 了，所以这里要另起一个
   * 控制器，用 follow 配置重新跑一遍。 */
  hostConfig = { skin: 'follow', themeMode: 'follow' };
  const fresh = [];
  const freshCtx = {
    get: () => undefined,
    on: () => () => {},
    effect: (f) => { f(); return () => {}; },
    slots: { inject: (n, run) => run(), register: (o, c) => { fresh.push({ o, c }); return () => {}; } },
    locale: { register: () => {}, bind: () => () => 'zh' },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
  };
  exports.apply(freshCtx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rendered = deepRender(fresh[0].c({}));
  /* 只看「明暗模式」那一组：「跟随 DSH」在「配色皮肤」那一组里也有一个，
   * 那个是**可点**的（跟随 DSH 本身就是一个可选皮肤）。 */
  const modeGroup = findGroup(rendered, '明暗模式');
  if (!modeGroup || !modeGroup.length) throw new Error('the mode group is missing');
  const modes = modeGroup.map((button) => ({
    t: button.props.children,
    pressed: button.props['aria-pressed'],
    disabled: button.props.disabled,
  }));
  const follow = modes.find((m) => m.t === '跟随 DSH');
  if (!follow) throw new Error('the follow option is missing');
  if (follow.pressed !== true) throw new Error('the follow option must be the selected one');
  if (follow.disabled !== true) throw new Error('the mode control must be disabled while following DSH');
  hostConfig = { skin: 'cream', themeMode: 'follow' };
});

await check('the panel renders the opacity slider', async () => {
  const rendered = deepRender(Panel({}));
  const sliders = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'input' && node.props?.type === 'range') sliders.push(node.props);
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else if (children && typeof children === 'object') visit(children);
  };
  visit(rendered);
  if (!sliders.length) throw new Error('the opacity slider is missing');
  const slider = sliders[0];
  assert.equal(slider.min, 25, 'the slider honours the host range');
  assert.equal(slider.max, 100);
  assert.equal(slider.step, 5);
  assert.equal(typeof slider.value, 'number', 'the slider shows the current value');
  assert.equal(slider['aria-label'], '不透明度', 'the slider needs an accessible name');
});

await check('the opacity slider is hidden when the platform cannot do it', async () => {
  /* 透明度是 Win32 分层窗口的特性，别的平台没有 —— 面板不能给一个
   * 按了没反应的滑块。 */
  const fresh = [];
  const freshCtx = {
    get: () => undefined,
    on: () => () => {},
    effect: (f) => { f(); return () => {}; },
    slots: { inject: (n, run) => run(), register: (o, c) => { fresh.push({ o, c }); return () => {}; } },
    locale: { register: () => {}, bind: () => () => 'zh' },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
  };
  /* 让宿主这次说「不支持」。 */
  const originalFetch = globalThis.window.fetch;
  globalThis.window.fetch = async (url, options) => {
    const method = options && options.body ? JSON.parse(options.body).method : '';
    if (method === 'live-window-config-get') {
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          value: {
            config: hostConfig, writable: true,
            catalog: { skins: [], themeModes: [], opacity: { supported: false, min: 25, max: 100, current: 100 } },
          },
        }),
        body: null, arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return originalFetch(url, options);
  };
  try {
    exports.apply(freshCtx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rendered = deepRender(fresh[0].c({}));
    let found = false;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'input' && node.props?.type === 'range') found = true;
      const children = node.props?.children;
      if (Array.isArray(children)) children.forEach(visit);
      else if (children && typeof children === 'object') visit(children);
    };
    visit(rendered);
    if (found) throw new Error('the opacity slider must be hidden when unsupported');
  } finally {
    globalThis.window.fetch = originalFetch;
  }
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall settings panel checks passed');
