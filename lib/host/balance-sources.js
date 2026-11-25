/**
 * 余额来源（本插件新增）。
 *
 * 原版鲸梦把「余额 / 额度 / 费用」都放在信息栏的账本里，但那套代码要联网查各服务商
 * 并读写凭据。本插件不搬那 263 KB，而是按**渠道类型**分派到四个已存在的能力：
 *
 *   1. 渠道包（channel-pack）—— OFM 插件内置的账号渠道（trae / qodercn / raccoon /
 *      minimax / lobsterai / cline / loomy / zcode / gemini）。余额单位是**积分**。
 *      走进程内 RPC（见 fetchChannelCredits），复用渠道包已实现的顺序查询与风控。
 *   2. OpenRouter —— 货币（USD）。`GET /api/v1/credits` 给总额与已用。
 *      免费模型另有每日请求数上限（`GET /api/v1/key` → free_model_daily_requests）。
 *   3. DeepSeek —— 货币（CNY）。官方 API Key 走 `GET /user/balance`；
 *      宿主登录账号走 `ctx.deepseekAccount.getBalance()`（充值钱包 + 赠金分列）。
 *   4. 免费渠道模型（NVIDIA 等）—— **没有余额概念**，显示「免费」。
 *
 * 失败一律如实返回空串，绝不编造数字：窗口界面会自己回落成「暂无用量」。
 */
import { randomUUID } from 'node:crypto';

const CHANNEL_PACK_PATH = '/api/channel-pack';
const CHANNEL_PACK_ENDPOINT = 'channel-pack';
/** 客户端身份里上报的插件版本（宿主据此派生 Platform 请求头）。 */
const PLUGIN_VERSION = '1.0.0';
/** channel-pack 的账号渠道 id；不在表里的 provider 没有渠道包余额。 */
const CHANNEL_PACK_PROVIDERS = new Set([
  'trae', 'qodercn', 'qoder', 'qodercn-cn', 'raccoon', 'minimax', 'lobsterai',
  'cline', 'loomy', 'zcode', 'gemini', 'opencode',
]);

/** 货币余额接口（凭据 + HTTP）。凭据名沿用鲸梦信息栏的 PROVIDERS 表。 */
const HTTP_BALANCE_PROVIDERS = {
  openrouter: {
    credential: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/credits',
    parse(body) {
      const data = body && body.data;
      const purchased = number(data?.total_credits);
      const used = number(data?.total_usage);
      if (purchased === null || used === null) return null;
      return { currency: 'USD', total: Math.max(0, purchased - used) };
    },
  },
  deepseek: {
    credential: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/user/balance',
    parse(body) {
      const list = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
      const record = list.find(item => item && item.currency === 'CNY' && number(item.total_balance) !== null)
        ?? list.find(item => item && number(item.total_balance) !== null);
      const total = record ? number(record.total_balance) : null;
      if (record === undefined || total === null) return null;
      return {
        currency: record.currency === 'USD' ? 'USD' : 'CNY',
        total,
        granted: number(record.granted_balance) ?? 0,
        toppedUp: number(record.topped_up_balance) ?? 0,
      };
    },
  },
};

/** 宿主登录账号（DeepSeek Platform）：无凭据，靠宿主账号服务。 */
const PLATFORM_ACCOUNT_PROVIDERS = new Set(['deepseek-account', 'deepseek-official']);

/**
 * 免费模型判定。
 *
 * 优先级从高到低：
 *   1. provider + model 显式带 `:free` / `-free` 后缀（OpenRouter 与渠道包的惯例）；
 *   2. 模型 id 以 `:free` 结尾（OpenRouter 官方写法，如 `deepseek/deepseek-r1:free`）；
 *   3. 渠道包的免费车道模型 id（`openrouter/free` 这类）。
 *
 * ⚠️ 判定为「免费」只影响**余额栏**的文案，不影响费用记账：免费模型照样消耗
 * 请求次数，只是不消耗余额。
 */
export function isFreeModel(provider, model) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return false;
  const pid = typeof provider === 'string' ? provider.trim() : '';
  const lower = id.toLowerCase();
  if (lower.endsWith(':free')) return true;
  if (/(^|[/:_-])free$/.test(lower) && lower !== 'openrouter/free') return true;
  if (pid === 'openrouter' && lower === 'openrouter/free') return true;
  return false;
}

/**
 * 读一个金额 / 计数。
 *
 * Platform 的钱包余额是**十进制字符串**（可能是 "12.5" 或 "0E-16" 这种带指数的
 * 文法），OpenRouter 与渠道包给的是数字。两种都收。
 */
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function bounded(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * 进程内调用 channel-pack 的 RPC。
 *
 * 用的是 DSH 的公开 API：`connection.createSharedFetchHandler('/api')` 返回的
 * handler 是**已注册的 exact Fetch 路由**的组装体，直接 fetch(request, peer)
 * 即可命中 `/api/channel-pack`——纯进程内，不经 HTTP、不带 Cookie、不受
 * Origin/Host 围栏约束。
 *
 * exact 路由只允许 owner Peer 通过，所以这里显式造一个 owner Peer。
 *
 * @param {object} ctx - 宿主 Context
 * @param {string} method - channel-pack 的 RPC 方法名
 * @param {object} payload - 该方法的参数
 * @returns {Promise<{ ok: boolean, value?: any, error?: { code: string, message: string } }>}
 */
export async function callChannelPack(ctx, method, payload) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection.createSharedFetchHandler !== 'function') {
    return { ok: false, error: { code: 'unavailable', message: 'connection service unavailable' } };
  }
  let peer;
  try {
    const handler = connection.createSharedFetchHandler('/api');
    if (typeof connection.createPeer !== 'function') {
      return { ok: false, error: { code: 'unavailable', message: 'connection peer unavailable' } };
    }
    peer = connection.createPeer({ principal: { kind: 'owner' } });
    const message = {
      type: 'client-request',
      rpcId: `live-window-${randomUUID()}`,
      method: CHANNEL_PACK_ENDPOINT,
      payload: { method, payload },
    };
    const response = await handler.fetch(new Request(`http://dsh.internal${CHANNEL_PACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    }), peer);
    if (response.status === 404) {
      return { ok: false, error: { code: 'not-found', message: 'channel-pack is not installed' } };
    }
    if (!response.ok) {
      return { ok: false, error: { code: 'http', message: `channel-pack responded ${response.status}` } };
    }
    const envelope = await response.json();
    // 外层信封 { type, rpcId, result }；result 是业务结果 { ok, value | error }。
    const result = envelope?.result;
    if (result === undefined || result === null) {
      return { ok: false, error: { code: 'bad-response', message: 'malformed channel-pack envelope' } };
    }
    return result;
  } catch (error) {
    return { ok: false, error: { code: 'exception', message: String(error?.message ?? error) } };
  } finally {
    // Peer 挂在 connection 服务的 fiber 上，不随本插件卸载；显式释放。
    try { peer?.dispose?.(); } catch { /* 释放失败不影响主流程 */ }
  }
}

/**
 * 读渠道包的账号余额（积分）。
 *
 * @returns {Promise<{ ok: boolean, credits?: number, packages?: any[], error?: any }>}
 */
export async function fetchChannelCredits(ctx, provider) {
  const result = await callChannelPack(ctx, 'credits.balances', { provider });
  if (!result?.ok) return { ok: false, error: result?.error ?? { code: 'failed', message: 'unknown' } };
  const accounts = Array.isArray(result.value?.accounts) ? result.value.accounts : [];
  let credits = 0;
  let known = false;
  const packages = [];
  for (const account of accounts) {
    if (account?.error !== undefined) continue;
    const total = number(account?.balance?.total);
    if (total === null) continue;
    known = true;
    credits += total;
    for (const pkg of Array.isArray(account.balance.packages) ? account.balance.packages : []) {
      packages.push({ name: bounded(pkg?.name, 60), remaining: number(pkg?.remaining) ?? 0, unit: bounded(pkg?.unit, 20) });
    }
  }
  // 一个账号都读不到时如实返回失败，不把「查不到」显示成 0 积分。
  if (!known) return { ok: false, error: { code: 'no-data', message: 'no channel account reported a balance' } };
  return { ok: true, credits, packages };
}

/**
 * 读 OpenRouter 的 Key 额度信息：余额 + 免费模型每日请求数。
 *
 * `GET /api/v1/key` 返回 `{ data: { limit_remaining, usage_daily, free_model_daily_requests: { used, limit } } }`。
 */
async function fetchOpenRouterKey(ctx) {
  const credential = await resolveCredential(ctx, 'OPENROUTER_API_KEY');
  if (credential === undefined) return null;
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const data = body?.data;
  if (data === undefined || data === null) return null;
  const remaining = number(data.limit_remaining);
  const used = number(data.usage);
  const daily = data.free_model_daily_requests;
  return {
    currency: 'USD',
    total: remaining ?? (used === null ? null : Math.max(0, -used)),
    dailySpend: number(data.usage_daily),
    freeModelDaily: daily === undefined || daily === null ? null : {
      used: number(daily.used) ?? 0,
      limit: number(daily.limit) ?? 0,
    },
  };
}

/**
 * 读货币余额（凭据 + HTTP）。
 */
async function fetchHttpBalance(ctx, provider) {
  const spec = HTTP_BALANCE_PROVIDERS[provider];
  if (spec === undefined) return null;
  const credential = await resolveCredential(ctx, spec.credential);
  if (credential === undefined) return null;
  const response = await fetch(spec.url, {
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return spec.parse(body);
}

/**
 * 读宿主登录账号的余额（DeepSeek Platform）。
 */
async function fetchPlatformBalance(ctx) {
  const account = ctx.get('deepseekAccount');
  if (account === undefined || typeof account.getBalance !== 'function') return null;
  // 客户端身份：版本 + 语言 + 时区偏移（东为正秒）。宿主据此派生 Platform 请求头。
  const result = await account.getBalance({
    version: PLUGIN_VERSION,
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  });
  if (result == null || result.status !== 'ready') return null;
  const wallets = Array.isArray(result.value) ? result.value : [];
  const normal = wallets.find(wallet => wallet?.currency === 'CNY') ?? wallets[0];
  if (normal === undefined) return null;
  const total = number(normal.balance);
  if (total === null) return null;
  const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets : [];
  const bonusWallet = bonus.find(wallet => wallet?.currency === 'CNY') ?? bonus[0];
  return {
    currency: normal.currency === 'USD' ? 'USD' : 'CNY',
    total,
    granted: bonusWallet === undefined ? 0 : (number(bonusWallet.balance) ?? 0),
  };
}

async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
  try {
    const resolved = await credentials.resolve(ref);
    return typeof resolved?.value === 'string' && resolved.value.length > 0 ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 账户级消耗追踪（方案 B 的那一半）。
 *
 * 用户要的是「多对话同时使用时消耗」——那是**账户级**的数字，不能按会话拆分
 * （会话级已经由 usage-tracker 的请求计数给出）。
 *
 * 做法：定期读一次账户余额，存下快照；两次快照之差就是这段时间的账户消耗。
 * 局限要说清楚：并发时这个差值包含**所有**对话的消耗，无法拆分到单个对话；
 * 它回答的是「这个账户这段时间花了多少」。
 *
 * ⚠️ 【本插件修正】快照的 key 原来是 **provider**，但余额金额是该 provider
 * **所有账号之和**。这带来两个「显示不完全」的问题：
 *
 *   1. 同一 provider 换了模型 → key 不变、金额口径却变了（不同模型的免费额度
 *      不同），差值把两次不同口径的余额相减，得到的是**噪声**而非消耗；
 *   2. 换 provider → key 变 → 上一个 provider 的快照作废，「本期已用」归零重算。
 *
 * 现在 key 改成 **provider + model**，与余额的查询口径一一对应：同一口径下两次
 * 快照相减才是真正的消耗，不同口径之间不互相污染。
 */
export function createAccountSpendTracker() {
  /** @type {Map<string, { at: number, total: number, currency: string, baseline: number, spent: number }>} */
  const snapshots = new Map();

  return {
    /**
     * 记一次余额快照（**推进**）。只有「记账节拍」该调用它：
     * 宿主后台刷新。
     *
     * 【本插件修正】这里记的是**本期累计消耗**，不是「上次到现在」的差值。
     *
     * 之前用相邻两次快照相减，于是：
     *   - 「已用」只在 30 秒的记账窗口内有效，窗口一过就冻在一个很小的数上
     *     （实测 minimax 余额从 3,361.9 掉到 2,582.1，界面却一直显示「已用 5.2」）；
     *   - 余额没变化时差值恒为 0，界面干脆不显示「已用」。
     *
     * 现在保留一个**基线**（本期开始时的余额），每次都用「基线 − 当前」：
     * 只要余额在降，「已用」就单调增长，而不是停在某个小数字上。
     *
     * 充值（余额上升）时把基线抬到新余额——那属于新的一期，已用从 0 重新累计。
     *
     * @param {string} key - 账户键（provider + model，与余额查询口径一致）
     * @param {number} total - 当前余额
     * @param {string} currency - 币种
     * @returns {{ spent: number, currency: string, since: number } | null} 本期累计消耗
     */
    snapshot(key, total, currency) {
      const now = Date.now();
      const previous = snapshots.get(key);
      if (previous === undefined) {
        // 第一次见到这个账户：先立基线，还没有消耗可比。
        snapshots.set(key, { at: now, total, currency, baseline: total, spent: 0 });
        return null;
      }
      // 余额上升 = 充值：以新余额为本期基线。
      const baseline = total > previous.total ? total : previous.baseline;
      const spent = Math.max(0, baseline - total);
      snapshots.set(key, { at: now, total, currency, baseline, spent });
      return { spent, currency, since: previous.at };
    },

    /**
     * 读本期累计消耗（**不推进**）。
     *
     * 收起态胶囊要显示「已用」，但它不能推进快照——否则会把差值吃掉，
     * 展开态随后就显示 0。所以界面读用这个，记账节拍用 {@link snapshot}。
     *
     * @param {string} key - 账户键
     * @returns {{ spent: number, currency: string, at: number, baseline: number } | undefined}
     */
    lastSpent(key) {
      const entry = snapshots.get(key);
      if (entry === undefined) return undefined;
      return { spent: entry.spent, currency: entry.currency, at: entry.at, baseline: entry.baseline };
    },

    /** 上一次快照。 */
    last(key) {
      return snapshots.get(key);
    },

    dispose() {
      snapshots.clear();
    },
  };
}

/**
 * 渠道余额总入口。
 *
 * 显示口径按渠道分四类（用户需求）：
 *   - **NVIDIA**：没有余额接口（NVIDIA 已取消积分制，改按每账号请求速率限制，
 *     默认 40 RPM），所以显示**每分钟请求次数**，随分钟窗口自动刷新。
 *   - **OpenRouter 免费模型**：显示**每日请求次数累计**（上游 `free_model_daily_requests`）。
 *   - **其它免费模型**：显示「免费」。
 *   - **付费渠道**：显示真实账户余额（积分或货币）。
 *
 * @param {object} ctx - 宿主 Context
 * @param {{ provider?: string, model?: string }} selection - 当前会话的模型路由
 * @param {object} [counters] - 本插件的请求计数器（提供每分钟/每日次数）
 * @returns {Promise<{ kind: 'free'|'credits'|'money'|'rate'|'none', label: string, detail?: any }>}
 */
export async function resolveChannelBalance(ctx, selection, counters) {
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  if (!provider) return { kind: 'none', label: '' };

  // NVIDIA：按每分钟请求速率限制，没有余额概念。
  if (provider === 'nvidia') {
    const minute = counters?.perMinute?.(provider, model) ?? 0;
    const day = counters?.perDay?.(provider, model) ?? 0;
    const parts = ['免费'];
    if (minute > 0 || day > 0) parts.push(`本分钟 ${minute} 次 · 今日 ${day} 次`);
    return { kind: 'rate', label: parts.join(' · '), detail: { perMinute: minute, perDay: day } };
  }

  // 免费模型没有余额概念：显示「免费」（OpenRouter 另附每日请求数）。
  if (isFreeModel(provider, model)) {
    if (provider === 'openrouter') {
      const key = await fetchOpenRouterKey(ctx);
      if (key !== null) {
        const parts = ['免费'];
        if (key.freeModelDaily !== null) {
          parts.push(`今日 ${key.freeModelDaily.used}/${key.freeModelDaily.limit} 次`);
        }
        const local = counters?.perDay?.(provider, model) ?? 0;
        if (local > 0) parts.push(`本机 ${local} 次`);
        return { kind: 'free', label: parts.join(' · '), detail: key };
      }
    }
    return { kind: 'free', label: '免费' };
  }

  // 渠道包（积分）。
  if (CHANNEL_PACK_PROVIDERS.has(provider)) {
    const credits = await fetchChannelCredits(ctx, provider);
    if (credits.ok) {
      return {
        kind: 'credits',
        label: `余额 ${formatCredits(credits.credits)} 积分`,
        detail: { credits: credits.credits, packages: credits.packages.slice(0, 8) },
      };
    }
    return { kind: 'none', label: '' };
  }

  // OpenRouter：货币余额。
  if (provider === 'openrouter') {
    const key = await fetchOpenRouterKey(ctx);
    if (key === null) return { kind: 'none', label: '' };
    const parts = [];
    if (key.total !== null) parts.push(`余额 ${formatMoney(key.total, key.currency)}`);
    return { kind: 'money', label: parts.join(' · '), detail: key };
  }

  // DeepSeek 官方 API Key。
  if (provider === 'deepseek') {
    const balance = await fetchHttpBalance(ctx, 'deepseek');
    if (balance === null) return { kind: 'none', label: '' };
    return { kind: 'money', label: `余额 ${formatMoney(balance.total, balance.currency)}`, detail: balance };
  }

  // DeepSeek 宿主登录账号。
  if (PLATFORM_ACCOUNT_PROVIDERS.has(provider)) {
    const balance = await fetchPlatformBalance(ctx);
    if (balance === null) return { kind: 'none', label: '' };
    return { kind: 'money', label: `余额 ${formatMoney(balance.total, balance.currency)}`, detail: balance };
  }

  return { kind: 'none', label: '' };
}

function formatCredits(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100000) return `${(value / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

function formatMoney(value, currency) {
  const code = currency === 'USD' ? 'USD' : 'CNY';
  const sign = code === 'USD' ? '$' : '¥';
  if (!Number.isFinite(value)) return `${sign}0.00`;
  return `${sign}${value.toFixed(2)}`;
}
