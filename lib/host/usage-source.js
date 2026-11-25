/**
 * 用量桥（本包自足版）。
 *
 * 原版鲸梦的「余额 / 本期花费 / 多周期额度」来自 dsh-bottom-info-bar 的账本。
 * 这里把那个账本的【核心】整段搬进 lib/host/ledger/（逐字，仅一处相对 import
 * 指向本包的 companion-usage），数据目录换成插件自己的，因此：
 *
 *   - 运行时不依赖 dsh-whale-dream（那个包已弃用）；
 *   - 账本是 node:sqlite 的磁盘文件，由 worker 线程读写，不阻塞宿主；
 *   - 读不到账本时如实返回空串，原版界面按自己的逻辑回落成「暂无用量」。
 *
 * 与鲸梦账本的关系：本插件首次启动时若发现旧的 ~/.dsh/whale-dream-info 里有
 * 记录，会复制一份过来（只复制一次，之后各走各的），这样历史用量不会丢。
 */
import { statSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLedgerClient } from './ledger/ledger-client.js';
import { resolveChannelBalance } from './balance-sources.js';

/**
 * 收起态「详情」文案的长度上限。
 *
 * 实测：21 字放得下，25 字会被原生窗口的省略号截断。取 22 留一点余量。
 */
const COLLAPSED_DETAIL_MAX = 22;

/** 账本目录：本插件自己的，位于 DSH_HOME 下。 */
export function ledgerDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'whale-live-window-info');
}

/** 旧版（鲸梦）账本目录，仅用于一次性迁移。 */
function legacyLedgerDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'whale-dream-info');
}

/**
 * 一次性迁移：把旧账本的 sqlite 文件复制过来。
 * 只在本目录还没有账本时执行，且失败不抛错（迁移失败不该阻止插件启动）。
 */
function migrateLegacyLedger(dir) {
  const target = join(dir, 'usage-ledger.sqlite');
  if (existsSync(target)) return false;
  const legacy = legacyLedgerDirectory();
  const source = join(legacy, 'usage-ledger.sqlite');
  if (!existsSync(source)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    // 连 -wal/-shm 一起搬，否则可能丢最近写入
    for (const name of readdirSync(legacy)) {
      if (!name.startsWith('usage-ledger.sqlite')) continue;
      copyFileSync(join(legacy, name), join(dir, name));
    }
    return true;
  } catch (error) {
    console.warn('[live-window] ledger migration skipped:', error && error.message);
    return false;
  }
}

/**
 * 建立账本用量源。
 *
 * @param {{ log?: (message: string) => void, ctx?: object, counters?: object }} [options]
 *   `ctx` 宿主上下文（取凭据 / 连接 / 账号服务），`counters` 请求计数器。
 * @returns 与 companion 期望的 usageSource 形状一致的桥
 */
export function createLedgerUsageSource(options = {}) {
  const dir = ledgerDirectory();
  migrateLegacyLedger(dir);
  const client = createLedgerClient({ dir, log: options.log });
  const ctx = options.ctx;
  const counters = options.counters;
  const accountSpend = options.accountSpend;

  return {
    /**
     * companion 用它按 (sessionId, provider) 取一行用量。
     *
     * 本插件改动：费用栏按用户需求显示**请求次数**，而不是账本里的 Token 数。
     * 返回的行形状与账本一致（calls/tokens/costs/unpricedCalls），所以原版
     * `formatCompanionUsage` 会把它渲染成「N 次请求」。
     *
     * 账本本身仍保留（含迁移过来的历史记录），供导出与诊断使用。
     */
    async read(pairs) {
      if (!Array.isArray(pairs) || !pairs.length) return [];
      if (counters === undefined) {
        try {
          return await client.companionUsage(pairs);
        } catch (error) {
          if (options.log) options.log('usage: ' + (error && error.message));
          return [];
        }
      }
      return pairs.map(pair => {
        const sessionId = typeof pair?.sessionId === 'string' ? pair.sessionId : '';
        const provider = typeof pair?.provider === 'string' ? pair.provider : '';
        return {
          sessionId,
          provider,
          calls: counters.sessionPerDay(sessionId, provider),
          tokens: 0,
          costs: [],
          unpricedCalls: 0,
        };
      });
    },
    /**
     * 记账节拍：读一次余额并**推进**快照。
     *
     * 这是唯一推进账户消耗的地方，由宿主在每次请求后调用（见 lib/index.js）。
     * 界面读取（quota / collapsedBalance / balance）都只读不推，这样：
     *   - 同一份状态包反复渲染时数字稳定，不会「读一次就变 0」；
     *   - 收起态与展开态读到的是同一个值，不会互相抢差值。
     *
     * @param {{ provider?: string, model?: string }} [selection]
     * @returns {Promise<void>}
     */
    async advance(selection) {
      if (ctx === undefined) return;
      try {
        const resolved = await resolveChannelBalance(ctx, selection ?? {}, counters);
        if (resolved.kind === 'none') return;
        const amount = resolved.kind === 'credits'
          ? resolved.detail?.credits
          : resolved.detail?.total;
        const currency = resolved.kind === 'credits' ? 'credits' : (resolved.detail?.currency ?? 'CNY');
        if (!Number.isFinite(amount)) return;
        const key = `${selection?.provider ?? ''}\0${selection?.model ?? ''}`;
        accountSpend?.snapshot?.(key, amount, currency);
      } catch (error) {
        if (options.log) options.log('advance: ' + (error && error.message));
      }
    },
    /**
     * 账户额度（展开态用，带「本期已用」）。
     *
     * 这个标签给**展开态**的会话额度栏用（宽度够）。
     * 收起态的胶囊用 {@link collapsedBalance}。
     *
     * @param {{ sessionId?: string, provider?: string, model?: string }} [selection]
     */
    async quota(selection) {
      if (ctx === undefined) return '';
      try {
        const resolved = await resolveChannelBalance(ctx, selection ?? {}, counters);
        if (resolved.kind === 'none') {
          options.log?.('quota ' + (selection?.provider ?? '?') + '/' + (selection?.model ?? '?') + ' -> none (empty)');
          return '';
        }
        /* 只读上一次记账节拍算出的消耗，不推进快照。 */
        const key = `${selection?.provider ?? ''}\0${selection?.model ?? ''}`;
        const spend = accountSpend?.lastSpent?.(key);
        let label = resolved.label;
        if (spend !== undefined) {
          const used = formatSpend(spend);
          // 差值为 0 也照实显示：0 积分是「确实没花」，与「查不到」是两件事。
          if (used !== '') label = `${resolved.label} · 本期已用 ${used}`;
        }
        // 记的是**最终标签**（含「本期已用」），这样诊断里能直接看出窗口会显示什么。
        options.log?.('quota ' + (selection?.provider ?? '?') + '/' + (selection?.model ?? '?')
          + ' -> ' + resolved.kind + ' ' + (label || '(empty)'));
        return label;
      } catch (error) {
        if (options.log) options.log('quota: ' + (error && error.message));
        return '';
      }
    },
    /**
     * 收起态标签（按 `collapsedDisplay` 选内容）。
     *
     * 实测原生窗口的行为（用真实串口喂状态包、截图核对）：
     *   - `status`  → 只画状态（思考中/新回复/探索未至之境），**忽略** idleBalance；
     *   - 其余三种  → 空闲时画「探索未至之境 | idleBalance」，
     *                 有新回复时画「状态 + 会话标题」。
     *
     * 也就是说：**能由宿主决定内容的只有 idleBalance**，而它只在空闲时可见。
     * 三种非 status 模式的差别只能靠给 idleBalance 换文案来做出来。
     *
     * 因此这里按模式给不同的文案：
     *
     * | collapsedDisplay | 收起态文案 |
     * | --- | --- |
     * | `status` | 空串（原生只画状态） |
     * | `title`  | `余额 776.7 积分` |
     * | `detail` | `余额 776.7 积分 · 已用 3.6` |
     * | `amount` | `余额 776.7 积分`（自动） |
     *
     * 「已用」的写法是刻意的：收起态胶囊宽度有限，`本期已用 3.6 积分` 那版
     * 实测会被省略号截断，缩短成 `已用 3.6` 才放得下。
     *
     * ⚠️ 这里**不推进快照**（读 {@link createAccountSpendTracker.lastSpent}），
     * 否则它会吃掉差值，展开态随后就显示「本期已用 0」。
     *
     * @param {{ sessionId?: string, provider?: string, model?: string }} [selection]
     * @param {'status'|'title'|'detail'|'amount'} [mode] 收起态模式。
     * @returns {Promise<string>} 收起态要显示的文案；空串表示交给原生只画状态。
     */
    async collapsedBalance(selection, mode) {
      if (ctx === undefined) return '';
      // status 模式由原生自己画状态，宿主不要塞文案。
      if (mode === 'status') return '';
      try {
        const resolved = await resolveChannelBalance(ctx, selection ?? {}, counters);
        if (resolved.kind === 'none') return '';
        // 只有「详情」模式带消耗；标题/自动只给余额。
        let label = resolved.label;
        if (mode === 'detail') {
          const key = `${selection?.provider ?? ''}\0${selection?.model ?? ''}`;
          const spend = accountSpend?.lastSpent?.(key);
          const amount = resolved.kind === 'credits'
            ? resolved.detail?.credits
            : resolved.detail?.total;
          if (spend !== undefined && spend.spent > 0 && Number.isFinite(amount)) {
            const currency = resolved.kind === 'credits' ? 'credits' : (resolved.detail?.currency ?? 'CNY');
            label = buildCollapsedDetail(amount, currency, spend.spent);
          }
        }
        // 记下收起态实际会显示什么，方便事后核对（含模式与长度）。
        options.log?.('collapsed ' + (mode ?? '?') + ' ' + (selection?.provider ?? '?') + '/' + (selection?.model ?? '?')
          + ' -> ' + (label || '(empty)') + ' (len ' + label.length + ')');
        return label;
      } catch (error) {
        if (options.log) options.log('collapsedBalance: ' + (error && error.message));
        return '';
      }
    },
    /**
     * 余额（短标签，不带消耗）。
     *
     * @param {{ sessionId?: string, provider?: string, model?: string }} [selection]
     */
    async balance(selection) {
      if (ctx === undefined) return '';
      try {
        const resolved = await resolveChannelBalance(ctx, selection ?? {}, counters);
        if (resolved.kind === 'none') return '';
        return resolved.label;
      } catch (error) {
        if (options.log) options.log('balance: ' + (error && error.message));
        return '';
      }
    },
    /**
     * 本对话消耗（含子代理）的请求次数。
     *
     * @param {{ sessionId?: string, provider?: string, model?: string }} [selection]
     */
    async sessionUsage(selection) {
      if (counters === undefined) return '';
      const sessionId = typeof selection?.sessionId === 'string' ? selection.sessionId : '';
      if (!sessionId) return '';
      const provider = typeof selection?.provider === 'string' ? selection.provider : '';
      const perDay = counters.sessionPerDay(sessionId, provider);
      const perMinute = counters.sessionPerMinute(sessionId, provider);
      if (perDay === 0) return '';
      return perMinute > 0 ? `${perDay} 次请求 · 本分钟 ${perMinute} 次` : `${perDay} 次请求`;
    },
    /** 账本记录总数（设置页/诊断可以用）。 */
    async count() {
      try { return await client.count(); } catch { return 0; }
    },
    async close() {
      try { await client.close(); } catch { /* 已关闭 */ }
    },
  };
}

/**
 * 收起态「详情」文案：`余额 2,582.1 积分 · 已用 780.3`。
 *
 * 收起态胶囊宽度有限。实测（真实原生窗口截图）：
 *   - 22 字 `余额 2,582.1 积分 · 已用 5.2` 放得下；
 *   - 24 字 `余额 2,582.1 积分 · 已用 780.3` 被截成 `…已用 7…`。
 *
 * 所以按「从完整到最简」逐级降级，取第一个放得下的：
 *
 *   1. `余额 2,582.1 积分 · 已用 780.3`
 *   2. `余额 2.6k 积分 · 已用 780.3`    ← 大数改成 K 缩写，保留一位小数
 *   3. `余额 2.6k · 已用 780.3`          ← 连「积分」也去掉
 *
 * @param {number} amount 当前余额。
 * @param {string} currency 币种（`credits` 或 CNY/USD）。
 * @param {number} spent 本期累计消耗。
 * @returns {string} 放得下的详情文案。
 */
function buildCollapsedDetail(amount, currency, spent) {
  const money = currency === 'CNY' || currency === 'USD';
  const sign = currency === 'USD' ? '$' : '¥';
  const plain = (v) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(v);
  // K 缩写：保留一位小数，例如 2,582.1 → 2.6k（小于 1000 就不缩）。
  const kilo = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : plain(v));

  const candidates = money
    ? [
      `余额 ${sign}${amount.toFixed(2)} · 已用 ${sign}${spent.toFixed(2)}`,
      `余额 ${sign}${kilo(amount)} · 已用 ${sign}${kilo(spent)}`,
    ]
    : [
      `余额 ${plain(amount)} 积分 · 已用 ${plain(spent)}`,
      `余额 ${kilo(amount)} 积分 · 已用 ${kilo(spent)}`,
      `余额 ${kilo(amount)} · 已用 ${kilo(spent)}`,
    ];

  return candidates.find((text) => text.length <= COLLAPSED_DETAIL_MAX)
    ?? candidates[candidates.length - 1];
}

/**
 * 把账户级消耗渲染成人读文本。
 *
 * 积分与货币的量级差很多：积分是整数（几百到几万），货币是小数（几分钱）。
 *
 * @param {{ spent: number, currency: string }} spend 消耗。
 * @param {{ compact?: boolean }} [options] `compact` 去掉积分单位——收起态
 *   胶囊宽度有限，「已用 3.6 积分」比「已用 3.6」更容易被截断。
 */
function formatSpend(spend, options = {}) {
  const value = spend?.spent;
  if (!Number.isFinite(value)) return '';
  if (spend.currency === 'CNY' || spend.currency === 'USD') {
    const sign = spend.currency === 'USD' ? '$' : '¥';
    if (value > 0 && value < 0.01) return `<${sign}0.01`;
    return `${sign}${value.toFixed(2)}`;
  }
  const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
  return options.compact === true ? amount : `${amount} 积分`;
}