/**
 * 宿主路由测试：用真实 HTTP 跑 companion-* 协议。
 *
 * 之前失败的地方正是这条链路根本没接通（客户端没激活 → 没人问；
 * 路由前缀不对 → 问了也 404）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'lw-host-'));
process.env.DSH_HOME = home;

const { apply } = await import(new URL('../lib/index.js', import.meta.url));

const routes = [];
const disposers = [];
const ctx = {
  webServer: { register(o) { routes.push(o); return () => {}; } },
  effect(f) { const d = f(); disposers.push(d); return () => {}; },
  get() { return undefined; },
};

apply(ctx, {});
assert.equal(routes.length, 1, 'one route registered');
const route = routes[0];
assert.equal(route.path, '/live-window/api');

const server = createServer((req, res) => {
  if (!req.url.startsWith('/live-window/api')) { res.writeHead(404); res.end(); return; }
  void route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port + '/live-window/api';

async function call(method, extra) {
  const body = JSON.stringify({ method, ...(extra || {}) });
  const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  let json = null;
  try { json = await response.json(); } catch {}
  return { status: response.status, json };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + (e && e.message || e)); }
}

await check('companion-get returns a settings document', async () => {
  const { status, json } = await call('companion-get');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  const v = json.value;
  assert.equal(typeof v.supported, 'boolean');
  assert.equal(typeof v.enabled, 'boolean');
  assert.ok('shape' in v && 'collapsedDisplay' in v);
  assert.ok('completionSound' in v && 'showDetails' in v);
});

await check('plain node is not the desktop host, so writes are refused', async () => {
  /* 原版契约：只有跑在 DSH 桌面宿主里（process.connected + desktop-host argv）
   * 才认为可用。本测试是普通 node 进程，supported 必然 false，写入被拒。
   * 这条断言把「不可用要如实上报」钉住，禁止为了变绿而放宽插件。 */
  const get = await call('companion-get');
  assert.equal(get.json.value.supported, false, 'plain node must not claim support');
  assert.equal((await call('companion-set', { shape: 'notch' })).status, 409);
});

await check('unknown method is 404 (not silently ok)', async () => {
  assert.equal((await call('not-a-real-method')).status, 404);
});

await check('the config endpoint reports the current values', async () => {
  const { status, json } = await call('live-window-config-get');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  const c = json.value.config;
  assert.equal(typeof c.debug, 'boolean');
  assert.equal(typeof c.autoStart, 'boolean');
  assert.equal(typeof c.showBalance, 'boolean');
  assert.equal(typeof c.executable, 'string');
  /* 【本插件新增】配色皮肤与明暗模式 */
  assert.equal(typeof c.skin, 'string');
  assert.equal(typeof c.themeMode, 'string');
  assert.equal(c.skin, 'follow', 'the default skin follows DSH');
  assert.equal(c.themeMode, 'follow', 'the default mode follows DSH');
});

await check('the config endpoint ships the skin catalog for the settings panel', async () => {
  const { json } = await call('live-window-config-get');
  const catalog = json.value.catalog;
  assert.ok(catalog, 'no catalog in the response');
  assert.ok(Array.isArray(catalog.skins) && catalog.skins.length > 0, 'no skins in the catalog');
  assert.ok(Array.isArray(catalog.themeModes) && catalog.themeModes.length > 0, 'no theme modes in the catalog');
  for (const skin of catalog.skins) {
    assert.ok(skin.id, 'a skin has no id');
    assert.ok(skin.label?.zh && skin.label?.en, 'skin ' + skin.id + ' is not bilingual');
    assert.ok(skin.description?.zh && skin.description?.en, 'skin ' + skin.id + ' has no bilingual description');
  }
  for (const mode of catalog.themeModes) {
    assert.ok(mode.id && mode.label?.zh && mode.label?.en, 'theme mode is not bilingual');
  }
});

await check('a config write without a config editor is refused, not faked', async () => {
  /* 这个进程里没有 configEditor 服务，也没有 fiber entry —— 写不进去，
   * 必须如实报失败，不能假装成功。 */
  const { status, json } = await call('live-window-config-set', { config: { autoStart: true } });
  assert.equal(status, 409);
  assert.equal(json.ok, false);
});

await check('client plugin requires only seeded externals', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/client/index.js', import.meta.url), 'utf8');
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const name of required) {
    assert.ok(['react', 'react/jsx-runtime'].includes(name), 'unexpected require: ' + name);
  }
});

server.close();
for (const d of disposers) if (typeof d === 'function') await d();
await rm(home, { recursive: true, force: true });
if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall host route checks passed');
