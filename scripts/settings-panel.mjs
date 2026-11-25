import fs from 'node:fs/promises';

const clientSource = new URL('../lib/client/index.js', import.meta.url);
const source = await fs.readFile(clientSource, 'utf8');
let registration;

globalThis.window = {
  __ModuleLoader__: { load: (v) => { registration = v; } },
  addEventListener() {}, removeEventListener() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  fetch: async () => ({
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
  }),
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
  locale: { register: () => () => {}, bind: () => () => 'zh' },
  theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
};
exports.apply(ctx);

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

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall settings panel checks passed');
