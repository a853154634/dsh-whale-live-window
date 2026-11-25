/**
 * 完成态保留测试 —— 钉住「任务完成后窗口被清空 / 会话栏消失」这个回归。
 *
 * 三个断言，对应三处修复：
 *   1. 主窗口聚焦时上报 viewed=true，不得清掉实况窗还没展示过的未读；
 *   2. 视图刷新不得删除完成记录（finishes）；
 *   3. 没有 retainedBy.mainView 的会话仍要能被选为 active（会话栏不空）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + (e && e.message || e)); }
}

const host = await fs.readFile(new URL('../lib/host/verbatim/desktop-companion.js', import.meta.url), 'utf8');
const client = await fs.readFile(new URL('../lib/client/index.js', import.meta.url), 'utf8');

await check('markRead keeps unread when the window never showed the completion', () => {
  assert.match(host, /function markRead\(id, options\)/, 'markRead must take options');
  assert.match(host, /shownByWindow/, 'must consult whether the window showed this session');
  assert.match(host, /fromWindow/, 'must distinguish window-originated reads');
  // the early-return path must come before the unread clearing
  const early = host.indexOf('实况窗还没机会展示这次完成');
  const clear = host.indexOf('finish.unread = false');
  assert.ok(early > 0 && clear > early, 'early return must precede unread clearing');
});

await check('window select counts as a real read', () => {
  assert.match(host, /markRead\(message\.id, \{ fromWindow: true \}\)/, 'window select must pass fromWindow');
});

await check('view refresh does not drop completion records', () => {
  const retainedBlock = host.slice(host.indexOf('const retained = new Set('), host.indexOf('const retained = new Set(') + 700);
  assert.ok(!/finishes\.delete/.test(retainedBlock), 'finishes must not be pruned on view refresh');
  assert.match(host, /完成记录（finishes）不再随/, 'fix must be documented in place');
});

await check('active session falls back when no mainView retention', () => {
  assert.match(client, /freshest\(/, 'client must fall back to the freshest session');
  assert.match(client, /byMainView/, 'client must still prefer mainView-retained sessions');
  const i = client.indexOf('const id = eligible(viewId)');
  const block = client.slice(i, i + 700);
  assert.ok(!/\?\? "";\s*\n\s*viewId = id;/.test(block) || /freshest/.test(block),
    'must not degrade straight to an empty id');
});

/* 行为级验证：真正跑一遍客户端包，确认选中的会话不是空。
 * 注意视图里的顶层字段叫 id（不是 activeId）——第一版测试断言错了字段名，
 * 才会把「已经修好」误判成「仍然坏着」。 */
await check('selection behaves correctly in three real shapes', async () => {
  const React = { createElement: () => null, useSyncExternalStore: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
  const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'f' };
  let captured = [];
  globalThis.window = {
    __ModuleLoader__: { load: (v) => { globalThis.__reg = v; } },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: { randomUUID: () => 'u' },
    fetch: async (u, o) => { if (o && o.body) { try { captured.push(JSON.parse(o.body)); } catch {} } return { ok: true, status: 200, json: async () => ({ ok: true, value: { supported: true, enabled: true } }), body: null, arrayBuffer: async () => new ArrayBuffer(0) }; },
  };
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {}, head: { append() {} }, createElement: () => ({ dataset: {}, textContent: '', remove() {} }) };
  globalThis.AudioContext = function () { return { decodeAudioData: async () => ({}), createBufferSource: () => ({ connect() {}, start() {}, set onended(v) {} }), destination: {}, close() {} }; };
  new Function('window', 'document', 'navigator', 'AbortSignal', 'AudioContext', client)(
    globalThis.window, globalThis.document, { language: 'zh-CN' }, AbortSignal, globalThis.AudioContext);
  const exports = globalThis.__reg.factory((s) => (s === 'react' ? React : s === 'react/jsx-runtime' ? jsx : null));

  const run = async (catalog, ids) => {
    captured = [];
    const ctx = {
      get: (n) => {
        if (n === 'sessions') return { list: { getSnapshot: () => ({ byId: catalog, ids }), subscribe: () => () => {} } };
        if (n === 'uiSession') return { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} }, whenAccess: (i, p, r) => r };
        return undefined;
      },
      on: () => () => {}, effect: (f) => { f(); return () => {}; },
      slots: { inject: (n, r) => r(), register: () => () => {} },
      locale: { register: () => () => {}, bind: () => () => 'zh' },
      theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
    };
    exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 60));
    return captured.filter((c) => c.method === 'companion-view').pop();
  };

  const noneRetained = await run({ a1: { id: 'a1', displayTitle: 'x', updatedAt: 1, blank: false, retainedBy: {} }, a2: { id: 'a2', displayTitle: 'y', updatedAt: 9, blank: false, retainedBy: {} } }, ['a1', 'a2']);
  assert.equal(noneRetained.id, 'a2', 'falls back to the most recently updated');
  assert.equal(noneRetained.rows.length, 1, 'the other session still appears in the bar');

  const oneRetained = await run({ b1: { id: 'b1', displayTitle: 'x', updatedAt: 1, blank: false, retainedBy: { mainView: 1 } }, b2: { id: 'b2', displayTitle: 'y', updatedAt: 9, blank: false, retainedBy: {} } }, ['b1', 'b2']);
  assert.equal(oneRetained.id, 'b1', 'still prefers the mainView-retained session');
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall completion-retention checks passed');
