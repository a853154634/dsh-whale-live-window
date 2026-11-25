/**
 * 余额与费用链路测试。
 *
 * 覆盖用户要求的四类显示：
 *   1. 渠道包账号积分余额（进程内 RPC → channel-pack）；
 *   2. OpenRouter 货币余额；
 *   3. DeepSeek 宿主账号余额；
 *   4. 免费模型显示「免费」；NVIDIA 显示每分钟请求数。
 * 以及费用栏：请求次数按会话聚合，子代理的请求归并到主对话。
 */
import assert from 'node:assert/strict';

const { isFreeModel, resolveChannelBalance, callChannelPack } = await import(
  new URL('../lib/host/balance-sources.js', import.meta.url));
const { createRequestCounter, createLineageResolver } = await import(
  new URL('../lib/host/usage-tracker.js', import.meta.url));
const { createLedgerUsageSource } = await import(
  new URL('../lib/host/usage-source.js', import.meta.url));
const { formatCompanionUsage } = await import(
  new URL('../lib/host/verbatim/companion-usage.js', import.meta.url));

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + (e && e.message || e)); }
}

/** 造一个假的宿主 Context：只提供测试要的服务。 */
function fakeCtx(services = {}) {
  return { get: (name) => services[name] };
}

await check('free models are detected by the :free suffix and the free lane id', () => {
  assert.equal(isFreeModel('openrouter', 'deepseek/deepseek-r1:free'), true);
  assert.equal(isFreeModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free'), true);
  assert.equal(isFreeModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b:free'), true);
  assert.equal(isFreeModel('openrouter', 'openrouter/free'), true);
  assert.equal(isFreeModel('openrouter', 'anthropic/claude-sonnet-4'), false);
  assert.equal(isFreeModel('trae', 'deepseek-v4.1-flash'), false);
});

await check('a free model reports 免费 instead of a zero balance', async () => {
  const resolved = await resolveChannelBalance(fakeCtx(), { provider: 'trae', model: 'x-free' });
  assert.equal(resolved.kind, 'free');
  assert.equal(resolved.label, '免费');
});

await check('nvidia reports its per-minute request count and refreshes with the minute', async () => {
  const counters = createRequestCounter();
  counters.record('nvidia', 'nvidia/nemotron-3-ultra:free', 's1', 's1');
  counters.record('nvidia', 'nvidia/nemotron-3-ultra:free', 's1', 's1');
  const resolved = await resolveChannelBalance(fakeCtx(), {
    provider: 'nvidia', model: 'nvidia/nemotron-3-ultra:free',
  }, counters);
  assert.equal(resolved.kind, 'rate');
  assert.match(resolved.label, /免费/);
  assert.match(resolved.label, /本分钟 2 次/);
  assert.equal(counters.perMinute('nvidia', 'nvidia/nemotron-3-ultra:free'), 2);
  assert.equal(counters.perDay('nvidia', 'nvidia/nemotron-3-ultra:free'), 2);
});

await check('channel-pack balances are read through the in-process fetch handler', async () => {
  const calls = [];
  const connection = {
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api');
      return {
        async fetch(request, peer) {
          calls.push({ body: await request.json(), peer });
          return new Response(JSON.stringify({
            type: 'server-response',
            rpcId: 'x',
            result: { ok: true, value: { accounts: [
              { accountId: 'a', balance: { total: 1200, packages: [{ name: '签到奖励', remaining: 200, unit: 'credits' }] } },
              { accountId: 'b', balance: { total: 800, packages: [] } },
            ] } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      };
    },
    createPeer(options) {
      assert.equal(options.principal.kind, 'owner');
      return { dispose() {} };
    },
  };
  const ctx = fakeCtx({ connection });
  const resolved = await resolveChannelBalance(ctx, { provider: 'trae', model: 'deepseek-v4.1-flash' });
  assert.equal(resolved.kind, 'credits');
  assert.equal(resolved.detail.credits, 2000);
  assert.match(resolved.label, /2,000 积分/);
  // 请求体必须是 channel-pack 期望的信封形状。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, 'client-request');
  assert.equal(calls[0].body.method, 'channel-pack');
  assert.equal(calls[0].body.payload.method, 'credits.balances');
  assert.equal(calls[0].body.payload.payload.provider, 'trae');
});

await check('a missing channel-pack degrades to no balance instead of zero', async () => {
  const connection = {
    createSharedFetchHandler() {
      return { async fetch() { return new Response('not found', { status: 404 }); } };
    },
    createPeer() { return { dispose() {} }; },
  };
  const resolved = await resolveChannelBalance(fakeCtx({ connection }), { provider: 'trae', model: 'm' });
  assert.equal(resolved.kind, 'none');
  assert.equal(resolved.label, '');
});

await check('the DeepSeek account balance comes from the host account service', async () => {
  const ctx = fakeCtx({
    deepseekAccount: {
      async getBalance(client) {
        // 客户端身份必须是 { version, locale, timezoneOffsetSeconds }。
        assert.equal(typeof client.version, 'string');
        assert.equal(client.locale, 'zh-CN');
        assert.equal(typeof client.timezoneOffsetSeconds, 'number');
        return { status: 'ready', value: [{ currency: 'CNY', balance: '12.5' }], bonusWallets: [{ currency: 'CNY', balance: '3' }] };
      },
    },
  });
  const resolved = await resolveChannelBalance(ctx, { provider: 'deepseek-account', model: 'deepseek-chat' });
  assert.equal(resolved.kind, 'money');
  assert.equal(resolved.detail.total, 12.5);
  assert.equal(resolved.detail.granted, 3);
});

await check('the OpenRouter balance comes from the key endpoint', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ data: {
      limit_remaining: 42.5,
      usage_daily: 7.5,
      free_model_daily_requests: { used: 12, limit: 1000 },
    } }), { status: 200 });
  };
  try {
    const ctx = fakeCtx({ credentials: { async resolve() { return { value: 'test-key', source: 'file' }; } } });
    const resolved = await resolveChannelBalance(ctx, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
    assert.equal(resolved.kind, 'money');
    assert.equal(resolved.detail.total, 42.5);
  } finally {
    globalThis.fetch = original;
  }
});

await check('an OpenRouter free model reports its daily request count', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {
    limit_remaining: 10,
    free_model_daily_requests: { used: 137, limit: 1000 },
  } }), { status: 200 });
  try {
    const ctx = fakeCtx({ credentials: { async resolve() { return { value: 'k', source: 'file' }; } } });
    const resolved = await resolveChannelBalance(ctx, { provider: 'openrouter', model: 'x/y:free' });
    assert.equal(resolved.kind, 'free');
    assert.match(resolved.label, /137\/1000 次/);
  } finally {
    globalThis.fetch = original;
  }
});

await check('subagent requests are folded into the root conversation', async () => {
  const counters = createRequestCounter();
  const lineage = createLineageResolver(fakeCtx());
  lineage.learn('child-1', 'root-1');
  lineage.learn('grandchild-1', 'child-1');
  assert.deepEqual(lineage.chainOf('grandchild-1'), ['grandchild-1', 'child-1', 'root-1']);
  assert.equal(lineage.rootOf('grandchild-1'), 'root-1');

  counters.record('trae', 'm', 'root-1', lineage.chainOf('root-1'));
  counters.record('trae', 'm', 'child-1', lineage.chainOf('child-1'));
  counters.record('trae', 'm', 'grandchild-1', lineage.chainOf('grandchild-1'));
  // 主对话：自己 1 次 + child 1 次 + grandchild 1 次 = 3 次。
  assert.equal(counters.sessionPerDay('root-1', 'trae'), 3);
  // 中间层 child：自己 1 次 + grandchild 1 次 = 2 次。
  assert.equal(counters.sessionPerDay('child-1', 'trae'), 2);
  // 叶子：只有自己 1 次。
  assert.equal(counters.sessionPerDay('grandchild-1', 'trae'), 1);
  // 路由维度：3 次请求都在 trae 上。
  assert.equal(counters.perDay('trae', 'm'), 3);
});

await check('mnemon subtrees without lineage fall back to the main conversation', () => {
  const lineage = createLineageResolver(fakeCtx());
  const task = 'mnemon-task-v1-11111111-2222-3333-4444-555555555555';
  const owner = 'mnemon-review-owner-v1-11111111-2222-3333-4444-555555555555';
  const run = 'mnemon-run-v1-11111111-2222-3333-4444-555555555555';
  // 子树根本身没有 parentSession：它要接上主会话。
  assert.deepEqual(lineage.chainOf(task, 'main-1'), [task, 'main-1']);
  assert.deepEqual(lineage.chainOf(owner, 'main-1'), [owner, 'main-1']);
  // 子会话有 parentSession 指向子树根，链要一路走到主会话。
  lineage.learn(run, task);
  assert.deepEqual(lineage.chainOf(run, 'main-1'), [run, task, 'main-1']);
  assert.equal(lineage.rootOf(run, 'main-1'), 'main-1');
  // 普通会话不受影响。
  assert.deepEqual(lineage.chainOf('ordinary-session', 'main-1'), ['ordinary-session']);
});

await check('the usage row renders as a request count', async () => {
  const counters = createRequestCounter();
  counters.record('trae', 'm', 's1', ['s1']);
  counters.record('trae', 'm', 's1', ['s1']);
  const source = createLedgerUsageSource({ ctx: fakeCtx(), counters });
  const rows = await source.read([{ sessionId: 's1', provider: 'trae' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 2);
  // 原版格式化函数把 calls>0 且无金额的行渲染成「N 次请求」。
  assert.equal(formatCompanionUsage(rows[0]), '2 次请求');
  await source.close();
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall usage-tracking checks passed');
