/**
 * 抓取真实控制器在「会话完成后」推给宿主的 payload。
 *
 * 这是回应「任务完成后窗口清空、会话栏消失」的取证工具：
 * 判断问题出在客户端算错了 view，还是宿主/窗口渲染。
 */
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../lib/client/index.js', import.meta.url), 'utf8');

const React = {
  createElement: () => null, useSyncExternalStore: () => ({}),
  useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
};
const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'f' };
const captured = [];

globalThis.window = {
  __ModuleLoader__: { load: (v) => { globalThis.__reg = v; } },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: { randomUUID: () => 'uuid' },
  fetch: async (url, options) => {
    if (options && options.body) {
      try { captured.push(JSON.parse(options.body)); } catch {}
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { supported: true, enabled: true } }), body: null, arrayBuffer: async () => new ArrayBuffer(0) };
  },
};
globalThis.document = {
  visibilityState: 'visible', hasFocus: () => true,
  addEventListener() {}, removeEventListener() {},
  head: { append() {} }, createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
};
globalThis.AudioContext = function () { return { decodeAudioData: async () => ({}), createBufferSource: () => ({ connect() {}, start() {}, set onended(v) {} }), destination: {}, close() {} }; };

new Function('window', 'document', 'navigator', 'AbortSignal', 'AudioContext', source)(
  globalThis.window, globalThis.document, { language: 'zh-CN' }, AbortSignal, globalThis.AudioContext,
);
const exports = globalThis.__reg.factory((s) => (s === 'react' ? React : s === 'react/jsx-runtime' ? jsx : null));

const SESSION = 'session-demo-1';
const listeners = [];
const statusMap = new Map();
const listSnapshot = {
  byId: { [SESSION]: { id: SESSION, displayTitle: '鲸梦实况窗提取为独立插件', retainedBy: { mainView: 1 }, updatedAt: Date.now(), blank: false } },
  ids: [SESSION],
};
const list = {
  getSnapshot: () => listSnapshot,
  subscribe: (fn) => { listeners.push(fn); return () => {}; },
};
const statuses = {
  getSnapshot: () => statusMap,
  subscribe: (fn) => { return () => {}; },
};
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { list };
    if (name === 'uiSession') return { sessionStatus: statuses, whenAccess: (id, perm, run) => run };
    return undefined;
  },
  on: () => () => {},
  effect: (f) => { f(); return () => {}; },
  slots: { inject: (n, run) => run(), register: () => () => {} },
  locale: { register: () => () => {}, bind: () => () => 'zh' },
  theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
};

exports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));

function viewCalls() { return captured.filter((c) => c.method === 'companion-view'); }
function lastView() { const v = viewCalls(); return v.length ? v[v.length - 1] : null; }

console.log('=== after apply (idle session)');
let v = lastView();
console.log(JSON.stringify(v && { id: v.id, status: v.status, rows: v.rows && v.rows.length, completionUnread: v.completionUnread }, null, 1));

// simulate running
statusMap.set(SESSION, { running: true, pendingInteraction: null, completionUnread: false });
listeners.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 250));
console.log('=== while running');
v = lastView();
console.log(JSON.stringify(v && { id: v.id, status: v.status, running: v.running, completionUnread: v.completionUnread }, null, 1));

// simulate completion: not running, completionUnread true
statusMap.set(SESSION, { running: false, pendingInteraction: null, completionUnread: true });
listeners.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 250));
console.log('=== after completion (completionUnread=true)');
v = lastView();
console.log(JSON.stringify(v && { id: v.id, status: v.status, running: v.running, completionUnread: v.completionUnread, replyPreview: v.replyPreview, rows: v.rows && v.rows.length }, null, 1));

console.log('\nTotal view calls:', viewCalls().length);
