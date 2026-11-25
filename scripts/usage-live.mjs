/**
 * 真机链路验证：模拟宿主里 companion 的 quota 读取路径。
 *
 * companion 的 `readQuota(id, provider, model)` 最终走
 * `usageSource.quota({sessionId, provider, model})` → usage-source 的 quota()
 * → resolveChannelBalance()。这里用**真的** usage-source 与**真的**
 * balance-sources，只把「宿主服务」换成可控的替身，验证整条链路能出数。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'lw-live-'));
process.env.DSH_HOME = home;

const { createLedgerUsageSource } = await import(new URL('../lib/host/usage-source.js', import.meta.url));
const { createRequestCounter, createLineageResolver } = await import(
  new URL('../lib/host/usage-tracker.js', import.meta.url));

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + (e && e.message || e)); }
}

/** channel-pack 的真实响应形状（本机账号 trae-b1b6844b 的结构）。 */
function channelPackContext(balance) {
  /* balance 可以是数字，也可以是 { value } 引用——后者让测试能改变余额。 */
  const amount = () => (balance && typeof balance === 'object' ? balance.value : balance);
  const connection = {
    createSharedFetchHandler() {
      return {
        async fetch(request) {
          const body = await request.json();
          assert.equal(body.payload.method, 'credits.balances');
          const total = amount();
          return new Response(JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value: { accounts: [{
              accountId: 'trae-b1b6844b',
              nickname: '156******21',
              balance: { total, packages: [{ name: '每月登录赠送', remaining: total, unit: 'credits' }] },
            }] } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      };
    },
    createPeer() { return { dispose() {} }; },
  };
  return { get: (name) => (name === 'connection' ? connection : undefined) };
}

await check('the quota path returns a real trae credit balance end to end', async () => {
  const ctx = channelPackContext(3210);
  const source = createLedgerUsageSource({ ctx, counters: createRequestCounter() });
  const label = await source.quota({ sessionId: 's1', provider: 'trae', model: 'deepseek-v4.1-flash' });
  console.log('     label =', JSON.stringify(label));
  assert.match(label, /积分/);
  assert.match(label, /3,210/);
  await source.close();
});

await check('the balance path returns the same label as quota', async () => {
  const ctx = channelPackContext(800);
  const source = createLedgerUsageSource({ ctx, counters: createRequestCounter() });
  const label = await source.balance({ sessionId: 's1', provider: 'trae', model: 'deepseek-v4.1-flash' });
  assert.match(label, /800 积分/);
  await source.close();
});

await check('a missing channel-pack yields an empty label, not a fake zero', async () => {
  const source = createLedgerUsageSource({ ctx: { get: () => undefined }, counters: createRequestCounter() });
  const label = await source.quota({ sessionId: 's1', provider: 'trae', model: 'm' });
  assert.equal(label, '');
  await source.close();
});

await check('the account spend accumulates within a period and resets on a top-up', async () => {
  /* 之前是「相邻两次快照相减」，只在 30 秒的记账窗口内有效——实测 minimax
   * 余额从 3,361.9 掉到 2,582.1，界面却冻在「已用 5.2」。现在按基线累计。 */
  const { createAccountSpendTracker } = await import(new URL('../lib/host/balance-sources.js', import.meta.url));
  const tracker = createAccountSpendTracker();
  assert.equal(tracker.snapshot('trae', 1000, 'credits'), null, 'the first snapshot only sets the baseline');
  assert.equal(tracker.snapshot('trae', 900, 'credits').spent, 100);
  // 关键：再掉一次要累计，不是只算最后一段。
  assert.equal(tracker.snapshot('trae', 850, 'credits').spent, 150, 'the spend accumulates');
  // 余额没变时也不该被吃掉。
  assert.equal(tracker.snapshot('trae', 850, 'credits').spent, 150, 'an unchanged balance keeps the total');
  // 充值：新的一期，从 0 重新记。
  assert.equal(tracker.snapshot('trae', 1200, 'credits').spent, 0, 'a top-up starts a new period');
  assert.equal(tracker.snapshot('trae', 1150, 'credits').spent, 50, 'counting resumes after the top-up');
  assert.equal(tracker.lastSpent('trae').spent, 50);
});

await check('the account spend follows the provider AND the model', async () => {
  /* 【本插件修正】快照的 key 必须与余额的查询口径一致。
   * 余额金额是该 provider 所有账号之和；同 provider 换模型时口径就变了，
   * 两次不同口径的余额相减得到的是噪声。 */
  const { createAccountSpendTracker } = await import(new URL('../lib/host/balance-sources.js', import.meta.url));
  const tracker = createAccountSpendTracker();
  const key = (provider, model) => `${provider}\0${model}`;
  tracker.snapshot(key('trae', 'm1'), 1000, 'credits');
  // 换模型 = 换口径 → 第一次取数只立基线，不该显示成消耗。
  assert.equal(tracker.snapshot(key('trae', 'm2'), 900, 'credits'), null,
    'a different model is a different balance scope');
  // 同一口径累计。
  const delta = tracker.snapshot(key('trae', 'm1'), 950, 'credits');
  assert.equal(delta.spent, 50);
  // 换 provider 同样不污染原口径。
  assert.equal(tracker.snapshot(key('qodercn', 'm1'), 500, 'credits'), null);
  const back = tracker.snapshot(key('trae', 'm1'), 940, 'credits');
  assert.equal(back.spent, 60, 'the original scope keeps accumulating from its own baseline');
});

await check('the quota label carries the spend once a tick exists', async () => {
  const { createAccountSpendTracker } = await import(new URL('../lib/host/balance-sources.js', import.meta.url));
  const balanceRef = { value: 1000 };
  const source = createLedgerUsageSource({
    ctx: channelPackContext(balanceRef),
    counters: createRequestCounter(),
    accountSpend: createAccountSpendTracker(),
  });
  const sel = { sessionId: 's1', provider: 'trae', model: 'deepseek-v4.1-flash' };
  // 还没有记账节拍 → 只有余额，没有「本期已用」。
  const first = await source.quota(sel);
  assert.match(first, /余额/, 'the first read has a balance');
  assert.doesNotMatch(first, /本期已用/, 'no tick yet, so no spend to show');
  // 一次记账节拍建立基线，再一次拿到差值。
  await source.advance(sel);
  balanceRef.value = 940;
  await source.advance(sel);
  const second = await source.quota(sel);
  assert.match(second, /本期已用/, 'the expanded label reports the spend');
  assert.match(second, /60 积分/, 'the spend is the balance difference');
  // 读操作不推进快照：连续读数必须稳定，不能第二次就变 0。
  const third = await source.quota(sel);
  assert.equal(third, second, 'repeated reads stay stable');
  await source.close();
});

await check('each collapsed mode gets its own label', async () => {
  /* 实测原生窗口：status 模式只画状态（忽略 idleBalance），
   * 其余三种空闲时都画 idleBalance。所以差别只能靠宿主换文案做出来。 */
  const { createAccountSpendTracker } = await import(new URL('../lib/host/balance-sources.js', import.meta.url));
  const balanceRef = { value: 1000 };
  const source = createLedgerUsageSource({
    ctx: channelPackContext(balanceRef),
    counters: createRequestCounter(),
    accountSpend: createAccountSpendTracker(),
  });
  const sel = { sessionId: 's1', provider: 'trae', model: 'deepseek-v4.1-flash' };
  await source.advance(sel);
  balanceRef.value = 996.4;
  await source.advance(sel);

  // 状态：交给原生自己画，宿主不塞文案。
  assert.equal(await source.collapsedBalance(sel, 'status'), '',
    'status mode lets the native window draw the status alone');

  // 标题：只给余额。
  const title = await source.collapsedBalance(sel, 'title');
  assert.match(title, /余额 996\.4 积分/, 'title mode shows the balance');
  assert.doesNotMatch(title, /已用/, 'title mode carries no spend');

  // 详情：余额 + 已用。用「已用」而不是「本期已用 3.6 积分」——
  // 收起态胶囊宽度有限，长的会被省略号截断。
  const detail = await source.collapsedBalance(sel, 'detail');
  assert.match(detail, /余额 996\.4 积分/, 'detail mode keeps the balance');
  assert.match(detail, /已用 3\.6/, 'detail mode carries the spend');
  assert.ok(detail.length <= 22, 'the detail label must stay short enough for the pill: ' + detail);

  // 自动（amount）：与标题一样，只给余额。
  const auto = await source.collapsedBalance(sel, 'amount');
  assert.equal(auto, title, 'auto mode matches title mode');

  // 收起态的读不推进快照：展开态仍拿到同一个值。
  const expanded = await source.quota(sel);
  assert.match(expanded, /本期已用 3\.6 积分/, 'collapsed reads must not eat the delta');
  await source.close();
});

await check('a long detail label degrades to the k form instead of truncating', async () => {
  /* 实测胶囊上限：22 字放得下，24 字被截成「…已用 7…」。
   * 大数改动 K 缩写（保留一位小数），例如 2,582.1 → 2.6k。 */
  const { createAccountSpendTracker } = await import(new URL('../lib/host/balance-sources.js', import.meta.url));
  const balanceRef = { value: 2582.1 };
  const source = createLedgerUsageSource({
    ctx: channelPackContext(balanceRef),
    counters: createRequestCounter(),
    accountSpend: createAccountSpendTracker(),
  });
  const sel = { sessionId: 's1', provider: 'trae', model: 'deepseek-v4.1-flash' };
  await source.advance(sel);
  // 累计用掉 780.3：`余额 1,801.8 积分 · 已用 780.3` 有 24 字，必须降级。
  balanceRef.value = 1801.8;
  await source.advance(sel);
  const detail = await source.collapsedBalance(sel, 'detail');
  console.log('     detail =', JSON.stringify(detail), '(len ' + detail.length + ')');
  assert.match(detail, /1\.8k/, 'the balance degrades to the k form');
  assert.match(detail, /780\.3/, 'the spend keeps one decimal place');
  assert.ok(detail.length <= 22, 'the label must fit the pill: ' + detail);
  await source.close();
});

await check('a full request round trip reports the conversation request count', async () => {
  const counters = createRequestCounter();
  const lineage = createLineageResolver({ get: () => undefined });
  lineage.learn('child', 'root');
  const source = createLedgerUsageSource({
    ctx: channelPackContext(500),
    counters,
  });
  counters.record('trae', 'deepseek-v4.1-flash', 'root', ['root']);
  counters.record('trae', 'deepseek-v4.1-flash', 'child', lineage.chainOf('child'));
  const rows = await source.read([{ sessionId: 'root', provider: 'trae' }]);
  assert.equal(rows[0].calls, 2, 'the root conversation counts its own and its subagent request');
  const usage = await source.sessionUsage({ sessionId: 'root', provider: 'trae' });
  console.log('     sessionUsage =', JSON.stringify(usage));
  assert.match(usage, /2 次请求/);
  await source.close();
});

await rm(home, { recursive: true, force: true });
if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall live-chain checks passed');
