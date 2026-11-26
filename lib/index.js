/**
 * dsh-whale-live-window — 宿主入口（薄适配层）。
 *
 * 实况窗的全部业务逻辑都在 lib/host/verbatim/ 里，是从 dsh-whale-dream@1.0.0
 * 【整段搬运】的原版代码。本文件只做原版之外的五件事：
 *
 *   1. 把原版 companion 挂在 /live-window/api 上（原版是 /whale-dream/api）；
 *   2. 复用原版的偏好读取与 companion-* 方法分派，协议一个字节不改；
 *   3. 提供 usageSource（用量/额度/余额）——本插件按渠道类型分派余额
 *      （见 host/balance-sources.js），费用改为请求次数；
 *   4. 挂 llm/stream 钩子逐请求计数，并把子代理的请求归并到主对话；
 *   5. 托管 webServer 路由的信任围栏与生命周期。
 */
import { createDesktopCompanion, resolveExecutableOverride } from './host/verbatim/desktop-companion.js';
import { createLedgerUsageSource, ledgerDirectory } from './host/usage-source.js';
import { createRequestCounter, createLineageResolver } from './host/usage-tracker.js';
import { createAccountSpendTracker } from './host/balance-sources.js';
import { SKIN_IDS, THEME_MODE_IDS, isSkinId, isThemeModeId, skinCatalog, skinOpacity, themeModeCatalog } from './host/skins.js';
import { DEFAULT_OPACITY, MIN_OPACITY, MAX_OPACITY, isOpacity, normalizeOpacity, applyOpacity, isOpacitySupported } from './host/opacity.js';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-whale-live-window';
// `llm` —— llm/stream 钩子（请求计数）；`sessions` —— 读会话 header（子代理谱系）。
// `connection` / `credentials` / `deepseekAccount` / `configEditor` 用 ctx.get() 取，
// 不进 inject：它们可能不存在（没装渠道包 / 没配 Key / 精简组合），
// 不该阻塞插件启动。
export const inject = ['webServer', 'llm', 'sessions'];

/**
 * 插件的配置项。
 *
 * 之前只有 `debug` 一个字段，而且没有导出 `Config` schema——于是这行配置
 * 既不会被校验，也没有表单可编辑（DSH 的设置页靠 Config schema 派生表单）。
 * 现在导出 schema，并把「能在运行中改」的字段声明成 volatile：
 * DSH 的设置表单只编辑 volatile 字段，并把它们原地热更新，不必重启插件。
 *
 * - `debug`：把最后一次状态包写到数据目录，供排查窗口/宿主的通信问题。
 * - `executable`：覆盖原生程序路径。留空则用本包 `bin/` 里自带的那个。
 * - `autoStart`：DSH 启动后自动打开实况窗（不必先在设置里手动开一次）。
 * - `showBalance`：是否在实况窗里显示余额/费用栏。
 * - `skin`：实况窗的配色皮肤。`follow` 跟随 DSH 主题，其余为岛仔的皮肤
 *   （经典 / 奶油 / 毛玻璃·浅 / 毛玻璃·深）。
 * - `themeMode`：实况窗的明暗模式。`follow` 跟随 DSH，其余强制浅色 / 深色。
 * - `opacity`：实况窗的不透明度（25-100）。越小越透，能看见后面的桌面。
 * - `skinOpacitys`：每套皮肤各自的不透明度（`{ [skinId]: 25-100 }`），
 *   切皮肤时用各自的值；没写的皮肤用 `opacity`。
 */
export const Config = z.object({
  debug: z.boolean().default(false).volatile(),
  executable: z.string().default('').volatile(),
  autoStart: z.boolean().default(false).volatile(),
  showBalance: z.boolean().default(true).volatile(),
  skin: z.union(SKIN_IDS.map((id) => z.const(id))).default('follow').volatile(),
  themeMode: z.union(THEME_MODE_IDS.map((id) => z.const(id))).default('follow').volatile(),
  opacity: z.natural().default(DEFAULT_OPACITY).volatile(),
  skinOpacitys: z.dict(z.natural()).default({}).volatile(),
});

const API_PREFIX = '/live-window/api';
const COMPANION_PREFIX = 'companion-';
/**
 * 余额/费用这版代码的版本号。
 *
 * 改动这组功能后**必须**把这里 +1：宿主日志不一定落盘，而这个标记会写进
 * 插件自己的诊断文件，用来确认跑的是哪一份代码。
 *
 * v2 —— 「本期已用」改为按 provider+model 口径记账，并在每次请求后主动刷新
 *        余额快照（不再依赖窗口何时显示余额）。
 */
const BALANCE_SOURCES_VERSION = 'v2';
/** 调试导出目录（仅 config.debug 时写）。 */
const dataDir = () => ledgerDirectory();
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const PAYLOAD_TOO_LARGE = Symbol('payload-too-large');

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        req.destroy();
        resolve(PAYLOAD_TOO_LARGE);
        return;
      }
      if (!aborted) chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => { if (!aborted) resolve(null); });
  });
}

function writeJson(res, status, value) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority); } catch { return undefined; }
}

function trustedAuthorities(ctx) {
  try {
    const startup = ctx.get && ctx.get('webStartup');
    if (startup) return startup.trustedHosts ?? [];
    const runtime = ctx.get && ctx.get('webRuntime');
    if (runtime) return runtime.trustedHosts ?? [];
  } catch { /* 两个服务都可能不存在 */ }
  return [];
}

/** 信任围栏：挡非本机来源与 DNS 重绑定（回环 + Host 校验 + 拒跨站 + Origin 同源）。 */
function isTrustedRequest(req, trusted) {
  const address = req.socket?.remoteAddress ?? '';
  if (!/^(?:127(?:\.\d+){3}|::1|::ffff:127(?:\.\d+){3})$/i.test(address)) return false;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  const allowed = isLoopbackHostname(hostUrl.hostname) || trusted.some((entry) => {
    if (typeof entry !== 'string') return false;
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
  if (!allowed) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

/**
 * 用量桥：原版 companion 用它显示「余额 / 用量 / 额度」。
 *
 * 本插件改动：余额与额度改为**按渠道类型分派**到 balance-sources.js，
 * 用量改为**请求次数**（本对话含子代理）。
 *
 * 两个来源，按可信度排：
 *   1. 本包内的账本（lib/host/ledger/，从鲸梦整段搬来）——有真实记录时给出金额；
 *   2. tokenMeter 投影——账本没有该会话记录时，退一步给出 Token 数。
 * 两者都没有就返回空，原版界面回落成「暂无用量」，绝不编造数字。
 */
export function createUsageBridge() {
  const listeners = new Set();
  let read, readQuota, readBalance, readCollapsed;
  function notify(...args) { for (const l of listeners) l(...args); }
  return {
    attach(reader, quotaReader, balanceReader, collapsedReader) {
      read = reader; readQuota = quotaReader; readBalance = balanceReader;
      readCollapsed = collapsedReader;
      notify();
      return () => {
        if (read !== reader) return;
        read = undefined; readQuota = undefined; readBalance = undefined; readCollapsed = undefined;
      };
    },
    read(pairs) { return read ? read(pairs) : Promise.resolve([]); },
    quota(sessionId, provider, model) {
      return readQuota ? readQuota({ sessionId, provider, model }) : Promise.resolve('');
    },
    balance(sessionId, provider, model) {
      return readBalance ? readBalance({ sessionId, provider, model }) : Promise.resolve('');
    },
    /**
     * 收起态标签：按 `collapsedDisplay` 给不同文案。
     *
     * @param {string} sessionId 会话 id
     * @param {string} provider 渠道
     * @param {string} model 模型
     * @param {string} mode collapsedDisplay（status/title/detail/amount）
     */
    collapsed(sessionId, provider, model, mode) {
      return readCollapsed
        ? readCollapsed({ sessionId, provider, model }, mode)
        : Promise.resolve('');
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify,
  };
}

/**
 * 追加一条诊断到插件自己的数据目录。
 *
 * 桌面端宿主日志不一定落盘，而余额/额度这条链路要能事后核对「查到了什么、
 * 为什么是空的」，所以单独写一份滚动日志。
 */
function appendDiagnostic(message) {
  const dir = ledgerDirectory();
  mkdirSync(dir, { recursive: true });
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(join(dir, 'diagnostics.log'), line);
}

export function apply(ctx, config = {}) {
  const usageSource = createUsageBridge();
  /**
   * 读配置。
   *
   * Config 里每个字段都是 volatile 的，DSH 的设置表单改它们时会**原地**更新
   * 这份引用（不重启插件），所以这里每次都重新读 `.get()`，而不是在启动时
   * 拍一次快照。
   *
   * @param {string} field 配置字段名。
   * @returns {unknown} 字段当前值。
   */
  const read = (field) => {
    const value = config?.[field];
    if (value && typeof value === 'object' && typeof value.get === 'function') return value.get();
    return value;
  };
  const debug = () => read('debug') === true;

  /**
   * 读出当前生效的配置值（普通值，不是 volatile 引用）。
   *
   * @returns {Record<string, unknown>} 供设置面板展示的配置。
   */
  const readConfigValues = () => ({
    debug: read('debug') === true,
    autoStart: read('autoStart') === true,
    showBalance: read('showBalance') !== false,
    executable: typeof read('executable') === 'string' ? read('executable') : '',
    skin: isSkinId(read('skin')) ? read('skin') : 'follow',
    themeMode: isThemeModeId(read('themeMode')) ? read('themeMode') : 'follow',
    opacity: normalizeOpacity(read('opacity')),
    skinOpacitys: readSkinOpacitys(),
  });

  /**
   * 读每套皮肤各自的不透明度。
   *
   * 键必须是合法的皮肤 id，值必须落在合法区间；不合法的条目直接丢掉，
   * 不能让一个坏配置把窗口变成全透明。
   *
   * @returns {Record<string, number>} 皮肤 id → 不透明度。
   */
  const readSkinOpacitys = () => {
    const source = read('skinOpacitys');
    if (!source || typeof source !== 'object') return {};
    const result = {};
    for (const [id, value] of Object.entries(source)) {
      if (!isSkinId(id)) continue;
      if (!isOpacity(value)) continue;
      result[id] = value;
    }
    return result;
  };

  /**
   * 当前皮肤该用多少不透明度。
   *
   * 优先用该皮肤自己记的值；没有就退回全局的 `opacity`；再没有就用
   * 皮肤的默认值（比如毛玻璃系 85）。
   *
   * @returns {number} 0-100 的不透明度。
   */
  const readCurrentOpacity = () => {
    const perSkin = readSkinOpacitys();
    const skin = isSkinId(read('skin')) ? read('skin') : 'follow';
    if (perSkin[skin] !== undefined) return perSkin[skin];
    if (isOpacity(read('opacity'))) return read('opacity');
    return skinOpacity(skin);
  };

  /**
   * 写配置。
   *
   * 用 DSH 的 configEditor 写：它会校验、保留 patch 里的注释与其它字段，
   * 并在有更高层覆盖时拒绝（此时返回 false，界面提示用户）。
   *
   * @param {Record<string, unknown>} values 要改的字段。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  const writeConfigValues = async (values) => {
    const editor = ctx.get('configEditor');
    const entry = ctx.fiber?.entry;
    if (!editor || !entry) return false;
    if (!values || typeof values !== 'object') return false;
    const patch = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'debug' || key === 'autoStart' || key === 'showBalance') {
        if (typeof value === 'boolean') patch[key] = value;
        continue;
      }
      if (key === 'skin') {
        if (isSkinId(value)) patch[key] = value;
        continue;
      }
      if (key === 'themeMode') {
        if (isThemeModeId(value)) patch[key] = value;
        continue;
      }
      if (key === 'opacity') {
        if (typeof value === 'number' && Number.isFinite(value)) {
          patch[key] = Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, Math.round(value)));
        }
        continue;
      }
      if (key === 'skinOpacitys') {
        /* 每套皮肤各自的不透明度。合并而不是覆盖，这样只改一套皮肤时
         * 不会把别的皮肤的值弄丢。 */
        if (!value || typeof value !== 'object') continue;
        const merged = { ...readSkinOpacitys() };
        for (const [id, level] of Object.entries(value)) {
          if (!isSkinId(id) || typeof level !== 'number' || !Number.isFinite(level)) continue;
          merged[id] = Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, Math.round(level)));
        }
        patch[key] = merged;
        continue;
      }
      if (key === 'executable') {
        if (typeof value !== 'string') continue;
        patch[key] = value.slice(0, 1024);
      }
    }
    if (!Object.keys(patch).length) return false;
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
      /* 【本插件新增】皮肤/明暗模式/不透明度改了：立刻让窗口换配色与透明度。
       *
       * 这里不依赖 `loader/volatile-update` 事件——那条路要等 Loader 重新
       * 解析 patch 才发，界面会有明显的滞后。写成功就直接重算一次，
       * 并把新值带过去（volatile 引用此刻可能还没刷新）。
       * （Loader 解析完还会再发一次事件，那次是幂等的，不会重复上色。） */
      if ('skin' in patch || 'themeMode' in patch || 'opacity' in patch || 'skinOpacitys' in patch) {
        const level = readCurrentOpacity();
        companion.refreshSkin?.({
          skin: 'skin' in patch ? patch.skin : undefined,
          themeMode: 'themeMode' in patch ? patch.themeMode : undefined,
          opacity: level,
        });
        /* 不透明度是 Win32 层面的，得单独往窗口上施加。 */
        if ('opacity' in patch || 'skinOpacitys' in patch || 'skin' in patch) {
          void companion.applyOpacity?.({ opacity: level });
        }
      }
      return true;
    } catch (error) {
      console.warn('[live-window] config write:', error && error.message);
      return false;
    }
  };
  // 启动标记：写一条带版本号的诊断，用来确认「跑的是哪份代码」。
  try {
    appendDiagnostic('apply() loaded — balance-sources=' + BALANCE_SOURCES_VERSION);
  } catch { /* 诊断写失败不影响主流程 */ }
  // 账本：本包自带，数据在 $DSH_HOME/whale-live-window-info/。
  // counters 记本机发起的请求次数（费用栏按请求次数显示）。
  // accountSpend 记账户余额快照，用于「本期已用」（方案 B 的账户级差值）。
  const counters = createRequestCounter();
  const accountSpend = createAccountSpendTracker();
  const ledger = createLedgerUsageSource({
    // 诊断写进插件自己的目录：宿主日志在桌面端不一定落盘，这里要能事后核对。
    log: (m) => {
      console.warn('[live-window] ' + m);
      try {
        appendDiagnostic(m);
      } catch { /* 诊断写失败不影响主流程 */ }
    },
    ctx,
    counters,
    accountSpend,
  });
  usageSource.attach(
    (pairs) => ledger.read(pairs),
    // 原版把额度/余额读成「与当前会话无关的账户快照」；本插件按渠道分派，
    // 所以要把 (sessionId, provider, model) 传下去。
    (selection) => ledger.quota(selection),
    (selection) => ledger.balance(selection),
    // 收起态标签按 collapsedDisplay 取不同文案（见 usage-source 的 collapsedBalance）。
    (selection, mode) => ledger.collapsedBalance(selection, mode),
  );
  // 原版 companion：窗口进程、状态包、审批、草稿、导航全在里面。
  const companion = createDesktopCompanion(ctx, usageSource, {
    executable: resolveExecutableOverride(read('executable')),
    showBalance: read('showBalance') !== false,
    /* 【本插件新增】配色皮肤与明暗模式：每次都重新读配置，配置是 volatile 的。 */
    readSkin: () => (isSkinId(read('skin')) ? read('skin') : 'follow'),
    readThemeMode: () => (isThemeModeId(read('themeMode')) ? read('themeMode') : 'follow'),
    /* 【本插件新增】不透明度：切皮肤时用该皮肤自己记的值。 */
    readOpacity: () => readCurrentOpacity(),
    /* 【本插件新增】把不透明度施加到原生窗口（Win32 分层窗口）。 */
    applyWindowOpacity: (pid, level) => applyOpacity(pid, level),
  });

  /* ------------------------------------------------------------------
   * 配色皮肤变了就重算配色并推给窗口。
   *
   * 配置是 volatile 的：DSH 改完立刻原地更新这份引用，不重启插件。
   * `loader/volatile-update` 事件就是「配置里的 volatile 字段变了」的信号
   * （cordis-plugin-loader 在提交 volatile 值后发出）。
   * ---------------------------------------------------------------- */
  ctx.on?.('loader/volatile-update', () => {
    try { companion.refreshSkin?.(); } catch (error) {
      console.warn('[live-window] refresh skin:', error && error.message);
    }
  });

  /* ------------------------------------------------------------------
   * 请求计数（费用栏）。
   *
   * `llm/stream` 携带 sessionId（dsh-llm/src/types.ts:599），所以能在
   * 宿主侧逐请求记账。子代理的请求归并到主会话：谱系来自
   * `subagent/start` 的 parentSessionId 与 Session header 的 parentSession。
   * ---------------------------------------------------------------- */
  const lineage = createLineageResolver(ctx);
  const disposeLineage = lineage.attach(() => { /* 谱系变更本身不触发刷新 */ });
  /**
   * 主会话 id：mnemon 的子树根（`mnemon-task-v1-*` / `mnemon-review-owner-v1-*`）
   * 没有 parentSession，它们的消耗要归到主对话上。
   *
   * 怎么找到主会话：mnemon 的这些会话与主会话**共享同一个 cwd**（实测它们的
   * header.cwd 与主会话一致），而且主会话是**非** subagent 起源的。所以按
   * 「同 cwd + 非 subagent」定位主会话。
   */
  const mainSessionsByCwd = new Map();
  let mainSessionId = '';
  /** 当前工作目录：mnemon 的子树根靠它找到主会话。 */
  let currentCwd = '';
  /** 每个会话只记一次诊断，避免刷屏。 */
  const loggedSessions = new Set();

  /* ------------------------------------------------------------------
   * 后台余额刷新（「本期已用」的记账节拍）。
   *
   * 原来余额只在**窗口要显示**时才查，于是：
   *   - 「本期已用」取决于余额被查询的时机，而不是实际消耗；
   *   - 窗口不刷新余额时，消耗数字长期停在旧值；
   *   - 两次快照之间的多次消耗只留下最后一个差值。
   *
   * 现在宿主自己在**每次请求之后**推进一次该路由的余额快照：快照间隔与
   * 消耗区间对齐，差值就是这段时间的真实消耗。界面读取只读不推，
   * 所以数字稳定、收起态与展开态一致。
   *
   * 刷新有最小间隔，避免连续请求把上游账号查询打爆（渠道包刻意不并发查账号）。
   * ---------------------------------------------------------------- */
  const balanceRefreshAt = new Map();
  /** 同一路由的余额刷新最小间隔（毫秒）。 */
  const BALANCE_REFRESH_MIN_MS = 30_000;
  /**
   * 推进某个路由的余额快照，让「本期已用」前进一格。
   *
   * @param {string} provider - 渠道 provider
   * @param {string} model - 模型 id
   */
  const refreshBalance = (provider, model) => {
    if (typeof provider !== 'string' || provider === '') return;
    if (typeof model !== 'string' || model === '') return;
    const key = `${provider}\0${model}`;
    const now = Date.now();
    const last = balanceRefreshAt.get(key);
    if (last !== undefined && now - last < BALANCE_REFRESH_MIN_MS) return;
    balanceRefreshAt.set(key, now);
    // advance 会推进 accountSpend 的快照；随后让窗口丢掉旧缓存，立刻显示新值。
    void ledger.advance({ provider, model })
      .then(() => {
        companion.invalidateQuota?.();
      })
      .catch(() => {});
  };

  const disposeStream = typeof ctx.on === 'function'
    ? ctx.on('llm/stream', (options, next) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
      if (sessionId !== '') {
        try {
          const session = ctx.sessions?.get?.(sessionId);
          const header = session?.header;
          if (header?.parentSession !== undefined) {
            lineage.learn(sessionId, header);
          } else if (header?.origin !== 'subagent') {
            // 这是一个普通会话：按 cwd 记住它，供 mnemon 子树回溯。
            if (typeof header?.cwd === 'string' && header.cwd !== '') {
              mainSessionsByCwd.set(header.cwd, sessionId);
              currentCwd = header.cwd;
            }
            if (mainSessionId === '') mainSessionId = sessionId;
          }
        } catch { /* 会话可能已经结束；不影响计数 */ }
        const fallback = mainSessionId !== ''
          ? mainSessionId
          : mainSessionsByCwd.get(currentCwd) ?? '';
        counters.record(options?.provider, options?.model, sessionId, lineage.chainOf(sessionId, fallback));
        // 通知 companion 重新读这一行的用量，窗口里的费用栏才会跟着变。
        usageSource.notify(sessionId, options?.provider);
        if (!loggedSessions.has(sessionId)) {
          loggedSessions.add(sessionId);
          try {
            appendDiagnostic('llm/stream ' + (options?.provider ?? '?') + '/' + (options?.model ?? '?')
              + ' session=' + sessionId + ' root=' + lineage.rootOf(sessionId, fallback));
          } catch { /* 诊断写失败不影响主流程 */ }
        }
      }
      // 请求完成后刷新该路由的余额：让「本期已用」覆盖到刚刚这次消耗。
      refreshBalance(options?.provider, options?.model);
      return next();
    })
    : () => {};

  /**
   * 【本插件新增】autoStart：DSH 启动后自动打开实况窗。
   *
   * 只在「配置里开着 autoStart」且「用户自己没有显式关掉过窗口」时生效——
   * 窗口进程自己发来的 close 事件会把 enabled 写回 false，所以用户关过
   * 之后这里不会把它又打开。
   */
  ctx.effect(() => {
    if (read('autoStart') !== true) return;
    const timer = setTimeout(() => {
      void companion.enable?.().catch((error) => {
        console.warn('[live-window] autoStart:', error && error.message);
      });
    }, 1500);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, 'whale-live-window: auto start');

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (!isTrustedRequest(req, trustedAuthorities(ctx))) { writeJson(res, 403, { ok: false }); return; }
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false }); return; }
        const contentType = typeof req.headers['content-type'] === 'string'
          ? req.headers['content-type'].toLowerCase() : '';
        if (!contentType.startsWith('application/json')) { writeJson(res, 415, { ok: false }); return; }
        const payload = await readJsonBody(req);
        if (payload === PAYLOAD_TOO_LARGE) { writeJson(res, 413, { ok: false }); return; }
        if (!payload || typeof payload !== 'object' || typeof payload.method !== 'string') {
          writeJson(res, 400, { ok: false });
          return;
        }
        try {
          if (debug() && payload.method === 'companion-view') {
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync(join(dataDir(), 'last-view.json'), JSON.stringify(payload, null, 1));
            } catch { /* 调试导出失败不影响主流程 */ }
          }
          /* 【本插件新增】宿主级配置的读写。
           *
           * 走 DSH 自己的配置编辑器（configEditor.edit），写入的是 profile 的
           * cordis.patch.yml，格式与其它插件的配置一致，且会被更高层的覆盖挡住。
           * 写完由 Loader 重新解析，volatile 字段原地更新，不重启插件。 */
          if (payload.method === 'live-window-config-get') {
            const writable = Boolean(ctx.get('configEditor')) && Boolean(ctx.fiber?.entry);
            writeJson(res, 200, {
              ok: true,
              value: {
                config: readConfigValues(),
                writable,
                // 皮肤与明暗模式的清单：设置面板按这个渲染分段控件，
                // 文案由宿主给，省得客户端再抄一份。
                catalog: {
                  skins: skinCatalog(),
                  themeModes: themeModeCatalog(),
                  // 透明度是 Windows 专属的特性（Win32 分层窗口），
                  // 其他平台没有，界面据此决定要不要显示滑块。
                  opacity: {
                    supported: isOpacitySupported(),
                    min: MIN_OPACITY,
                    max: MAX_OPACITY,
                    current: readCurrentOpacity(),
                  },
                },
              },
            });
            return;
          }
          if (payload.method === 'live-window-config-set') {
            const changed = await writeConfigValues(payload.config);
            writeJson(res, changed ? 200 : 409, { ok: changed, value: { config: readConfigValues() } });
            return;
          }
          if (payload.method.startsWith(COMPANION_PREFIX)) {
            const handled = await companion(payload, res, (status, data) => writeJson(res, status, data));
            if (handled) return;
          }
          writeJson(res, 404, { ok: false, error: 'unknown method' });
        } catch (error) {
          console.error('[live-window] route:', error);
          writeJson(res, 500, { ok: false });
        }
      },
    });
    return () => {
      dispose?.();
      disposeStream?.();
      disposeLineage?.();
      counters.dispose();
      accountSpend.dispose();
      // 账本在 worker 线程里：关闭时让它 checkpoint + 落盘，别丢最近写入。
      void ledger.close();
    };
  }, 'whale-live-window: companion route');
}