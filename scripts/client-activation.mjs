/**
 * 客户端激活测试 —— 回答「插件到底有没有跑起来」。
 *
 * 第一版就是在这一点上无声地坏掉的：exports.inject 列了宿主不提供的服务，
 * cordis 让插件永久 pending，apply 一次都没执行，窗口永远停在「探索未至之境」。
 * 这个测试把那种情况直接变成红色。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../lib/client/index.js', import.meta.url), 'utf8');

let registration;
const React = {
  createElement: () => null,
  useSyncExternalStore: () => ({}),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};
const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'fragment' };
const fetched = [];

globalThis.window = {
  __ModuleLoader__: { load: (value) => { registration = value; } },
  addEventListener() {}, removeEventListener() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  fetch: async (url, options) => {
    fetched.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }), body: null, arrayBuffer: async () => new ArrayBuffer(0) };
  },
};
globalThis.document = {
  visibilityState: 'visible', hasFocus: () => true,
  addEventListener() {}, removeEventListener() {},
  head: { append() {} },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
};
globalThis.AudioContext = function () {
  return { decodeAudioData: async () => ({}), createBufferSource: () => ({ connect() {}, start() {}, set onended(v) {} }), destination: {}, close() {} };
};

new Function('window', 'document', 'navigator', 'AbortSignal', 'AudioContext', source)(
  globalThis.window, globalThis.document, { language: 'zh-CN' }, AbortSignal, globalThis.AudioContext,
);
const exports = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return jsx;
  throw new Error('unexpected require: ' + specifier);
});

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error && error.message || error)); }
}

await check('inject only names services the host always provides', () => {
  const allowed = new Set(['slots', 'locale', 'theme', 'uiSession']);
  for (const name of exports.inject) assert.ok(allowed.has(name), 'unexpected inject: ' + name);
});

await check('apply runs and registers the settings section', () => {
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
  assert.equal(registered.length, 1, 'exactly one settings section');
  assert.equal(registered[0].o.id, 'whale-live-window');
  assert.equal(registered[0].o.name, 'settings.section');
  assert.equal(typeof registered[0].c, 'function', 'section renders a component');
});

await check('controller talks to /live-window/api, never /whale-dream/api', () => {
  const registered = [];
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {}, ids: [] }), subscribe: () => () => {} } };
      if (name === 'uiSession') return { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } };
      return undefined;
    },
    on: () => () => {},
    effect: (f) => { f(); return () => {}; },
    slots: { inject: (n, run) => run(), register: (o, c) => { registered.push({ o, c }); return () => {}; } },
    locale: { register: () => () => {}, bind: () => () => 'zh' },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
  };
  exports.apply(ctx);
  assert.ok(registered.length, 'section registered');
  for (const call of fetched) {
    assert.ok(!String(call.url).includes('/whale-dream/api'), 'stale endpoint: ' + call.url);
  }
  const methods = fetched.map((c) => c.body && c.body.method).filter(Boolean);
  assert.ok(methods.includes('companion-get'), 'must ask host for settings; got: ' + JSON.stringify(methods.slice(0, 5)));
});

await check('source contains no leftover whale-dream endpoint', () => {
  assert.ok(!source.includes('/whale-dream/api'), 'client still points at the old route');
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall client activation checks passed');
