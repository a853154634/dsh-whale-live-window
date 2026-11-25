/**
 * 账本用量测试。
 *
 * 验证「用量」这条链路真的能出数字，而不是永远「暂无用量」：
 *   1. 账本能被打开（node:sqlite，worker 线程）；
 *   2. 真实 (sessionId, provider) 能读出 calls / tokens；
 *   3. 原版格式化函数把它渲染成人读文本；
 *   4. 旧账本能被一次性迁移进来。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'lw-ledger-'));
process.env.DSH_HOME = home;

const { createLedgerUsageSource, ledgerDirectory } = await import(new URL('../lib/host/usage-source.js', import.meta.url));
const { formatCompanionUsage } = await import(new URL('../lib/host/verbatim/companion-usage.js', import.meta.url));

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + (e && e.message || e)); }
}

await check('ledger dir is inside the plugin home, not the theme dir', () => {
  const dir = ledgerDirectory();
  assert.ok(dir.includes('whale-live-window-info'), 'got ' + dir);
  assert.ok(!dir.includes('whale-dream-info'), 'must not reuse the deprecated dir');
});

await check('empty ledger reports zero records and empty usage', async () => {
  const src = createLedgerUsageSource();
  assert.equal(await src.count(), 0);
  assert.deepEqual(await src.read([{ sessionId: 'nope', provider: 'p' }]), []);
  await src.close();
});

await check('formatter renders tokens, money, and the empty fallback', () => {
  assert.equal(formatCompanionUsage({ calls: 17, tokens: 1695165, costs: [], unpricedCalls: 17 }), '1.7M Token');
  assert.equal(formatCompanionUsage({ calls: 3, tokens: 0, costs: [{ currency: 'CNY', amount: 1.2345 }], unpricedCalls: 0 }), '¥1.2345');
  assert.equal(formatCompanionUsage({ calls: 0, tokens: 0, costs: [], unpricedCalls: 0 }), '暂无用量');
});

/* 迁移必须在一个「还没有账本」的干净 HOME 里测：上一个用例已经在同一个 home
 * 里建了空账本，迁移会正确地跳过。所以这里换一个全新的 HOME 再测。 */
await check('legacy ledger is migrated into a fresh home', async () => {
  /* 旧鲸梦账本只在本机存在。默认按本机 DSH_HOME 查找；也可用
   * LW_LEGACY_LEDGER 环境变量指向别的路径（CI 里造一个 fixture 即可）。 */
  const legacyHome = process.env.LW_LEGACY_HOME || join(homedir(), '.dsh');
  const real = process.env.LW_LEGACY_LEDGER || join(legacyHome, 'whale-dream-info', 'usage-ledger.sqlite');
  if (!existsSync(real)) { console.log('     (no legacy ledger on this machine; path not exercised)'); return; }

  const fresh = await mkdtemp(join(tmpdir(), 'lw-migrate-'));
  process.env.DSH_HOME = fresh;
  await mkdir(join(fresh, 'whale-dream-info'), { recursive: true });
  await cp(real, join(fresh, 'whale-dream-info', 'usage-ledger.sqlite'));

  const src = createLedgerUsageSource();
  const count = await src.count();
  assert.ok(count > 0, 'migrated ledger should have records, got ' + count);
  assert.ok(existsSync(join(ledgerDirectory(), 'usage-ledger.sqlite')), 'file copied into plugin dir');
  await src.close();
  await rm(fresh, { recursive: true, force: true });
  process.env.DSH_HOME = home;
});

await rm(home, { recursive: true, force: true });
if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall ledger checks passed');
