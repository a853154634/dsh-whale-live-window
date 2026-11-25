/**
 * 请求计数与会话归因（本插件新增）。
 *
 * 原版鲸梦把用量挂在「账本」上，但账本记账要靠 `llm/stream` 钩子 + 价目表，
 * 且 trae 这类渠道不在价目表里 → 只能显示 Token 数。本插件按用户需求改成：
 *
 *   - **费用栏 = 请求次数**（对免费模型尤其重要：NVIDIA 按每分钟请求数限流，
 *     OpenRouter 免费模型按每日请求数限流）。
 *   - **本对话消耗 = 本对话（含子代理）发起的请求数**。
 *
 * 子代理归属有两条来源，都要用：
 *   1. `subagent/start` 事件携带 `parentSessionId`（直接创建者）——权威；
 *   2. Session header 的 `parentSession`（子会话谱系）——补上事件漏掉的。
 *
 * ⚠️ mnemon 的 `mnemon-task-v1-*` 会话**没有** `parentSession`（实测：其 header
 * 只有 cwd/isSeeded/delegationDepth/agentPreset），因为它们由
 * `ctx.agents.create()` 直接创建而不是走子代理激活。mnemon 自己的
 * `mnemon-run-v1-*` / `mnemon-review-v1-*` 才是真子代理（有 parentSession）。
 * 因此**任务型子会话按 id 前缀兜底归到当前主会话**，并在注释里标明这一口径。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * mnemon 直接创建的会话**没有** `parentSession`（实测：header 只有
 * cwd/isSeeded/delegationDepth/agentPreset），因为它们由 `ctx.agents.create()`
 * 直接创建而不是走子代理激活。
 *
 * 实测本机的两种：
 *   - `mnemon-task-v1-*`：后台任务会话，是 mnemon 子树的根；
 *   - `mnemon-review-owner-v1-*`：复盘 owner 会话，同样是子树的根。
 * 它们的子会话（`mnemon-run-v1-*` / `mnemon-review-v1-*`）**有** parentSession。
 *
 * 所以谱系链的**末端**可能是这两类之一 —— 那时它就归到主会话。
 */
const ORPHAN_SESSION_PATTERN = /^mnemon-(?:task|review-owner)-v1-[0-9a-f-]{36}$/;

/**
 * 创建请求计数器。
 *
 * 计数是**进程内**的：本插件在宿主进程里跑，重启后归零。
 * 这与「每分钟刷新」的语义一致（分钟窗口本来就短）。
 *
 * @returns {object} 计数器
 */
export function createRequestCounter() {
  /** @type {Map<string, { minute: number, minuteCount: number, day: number, dayCount: number }>} */
  const buckets = new Map();
  const listeners = new Set();

  function slot(key, now = Date.now()) {
    const minute = Math.floor(now / MINUTE_MS);
    const day = Math.floor(now / DAY_MS);
    let entry = buckets.get(key);
    if (entry === undefined) {
      entry = { minute, minuteCount: 0, day, dayCount: 0 };
      buckets.set(key, entry);
    }
    if (entry.minute !== minute) { entry.minute = minute; entry.minuteCount = 0; }
    if (entry.day !== day) { entry.day = day; entry.dayCount = 0; }
    return entry;
  }

  function countOf(key, field) {
    const entry = buckets.get(key);
    if (entry === undefined) return 0;
    const now = Date.now();
    if (field === 'minute') {
      const minute = Math.floor(now / MINUTE_MS);
      return entry.minute === minute ? entry.minuteCount : 0;
    }
    const day = Math.floor(now / DAY_MS);
    return entry.day === day ? entry.dayCount : 0;
  }

  function prune() {
    const day = Math.floor(Date.now() / DAY_MS);
    for (const [key, entry] of buckets) {
      if (entry.day < day - 1) buckets.delete(key);
    }
  }

  return {
    /**
     * 记一次请求。
     *
     * 计数分两个维度：
     *   - `route\0<provider>\0<model>`：某个路由的请求数（余额栏的每分钟/每日）；
     *   - `session\0<sessionId>\0<provider>`：某会话在某 provider 下的请求数。
     *
     * 子代理的请求会记到它自己**和它的每一级祖先**上，所以「本对话消耗」
     * 把子代理的消耗算进来，而每个子会话自己的计数也仍然正确。
     *
     * @param {string} provider - 路由 provider
     * @param {string} model - 模型 id
     * @param {string} sessionId - 发起请求的会话
     * @param {string[]} ancestors - 归属链（自己 → 根）
     */
    record(provider, model, sessionId, ancestors) {
      const providerKey = typeof provider === 'string' && provider ? provider : 'unknown';
      const modelKey = typeof model === 'string' && model ? model : '';
      const chain = Array.isArray(ancestors) && ancestors.length > 0
        ? ancestors
        : (typeof sessionId === 'string' && sessionId ? [sessionId] : []);

      const routeEntry = slot(`route\0${providerKey}\0${modelKey}`);
      routeEntry.minuteCount += 1;
      routeEntry.dayCount += 1;
      for (const id of chain) {
        const entry = slot(`session\0${id}\0${providerKey}`);
        entry.minuteCount += 1;
        entry.dayCount += 1;
      }
      prune();
      for (const listener of listeners) {
        try { listener(providerKey, modelKey, sessionId, chain[chain.length - 1]); } catch { /* 监听器失败不影响计数 */ }
      }
    },

    /** 某 provider+model 的本分钟请求数。 */
    perMinute(provider, model) {
      return countOf(`route\0${provider}\0${model}`, 'minute');
    },

    /** 某 provider+model 的今日请求数。 */
    perDay(provider, model) {
      return countOf(`route\0${provider}\0${model}`, 'day');
    },

    /** 某会话在某 provider 下的今日请求数（含其子代理归并）。 */
    sessionPerDay(sessionId, provider) {
      const pid = typeof provider === 'string' && provider ? provider : 'unknown';
      return countOf(`session\0${sessionId}\0${pid}`, 'day');
    },

    /** 某会话在某 provider 下的本分钟请求数（含其子代理归并）。 */
    sessionPerMinute(sessionId, provider) {
      const pid = typeof provider === 'string' && provider ? provider : 'unknown';
      return countOf(`session\0${sessionId}\0${pid}`, 'minute');
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      buckets.clear();
      listeners.clear();
    },
  };
}

/**
 * 会话归属解析器（本插件新增）。
 *
 * 维护「子会话 → 主会话」的映射，让子代理的请求算进主对话的消耗。
 */
export function createLineageResolver(ctx) {
  /** @type {Map<string, string>} 直接创建者：child → parent */
  const parents = new Map();

  function remember(child, parent) {
    if (typeof child !== 'string' || !child) return;
    if (typeof parent !== 'string' || !parent) return;
    if (child === parent) return;
    parents.set(child, parent);
  }

  return {
    /**
     * 订阅 `subagent/start` —— 它带权威的 `parentSessionId`。
     *
     * 事件名来自 dsh-subagent 的 emit（dsh-subagent/src/index.ts:158）。
     * 宿主没有这个服务时不订阅：谱系就只剩 Session header 那一条来源。
     */
    attach(onChild) {
      if (typeof ctx.on !== 'function') return () => {};
      const dispose = ctx.on('subagent/start', (info) => {
        if (info?.id === undefined || info?.parentSessionId === undefined) return;
        remember(String(info.id), String(info.parentSessionId));
        onChild?.(String(info.id), String(info.parentSessionId));
      });
      return typeof dispose === 'function' ? dispose : () => {};
    },

    /**
     * 记住一条谱系边：child → parent。
     *
     * 传入 Session header（用它的 parentSession）或直接传 parent id 都行。
     */
    learn(child, headerOrParent) {
      const parent = typeof headerOrParent === 'string'
        ? headerOrParent
        : headerOrParent?.parentSession;
      if (typeof parent !== 'string' || !parent) return;
      remember(child, parent);
    },

    /**
     * 解析一个会话的**祖先链**（从自己往上到根）。
     *
     * 谱系链走 `parentSession`；链的**末端**若是 mnemon 直接创建的会话
     * （`mnemon-task-v1-*` / `mnemon-review-owner-v1-*`，它们没有 parentSession），
     * 就把主会话接在链尾 —— 这样 mnemon 子树的消耗会算进主对话。
     *
     * @returns {string[]} 自己的 id 在前，根在后
     */
    chainOf(sessionId, fallbackRoot) {
      const chain = [];
      let current = typeof sessionId === 'string' ? sessionId : '';
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        const parent = parents.get(current);
        if (parent === undefined) break;
        current = parent;
      }
      // 链尾是 mnemon 的子树根：把主会话接上去。
      const tail = chain[chain.length - 1];
      if (tail !== undefined && ORPHAN_SESSION_PATTERN.test(tail)) {
        const root = typeof fallbackRoot === 'string' && fallbackRoot ? fallbackRoot : '';
        if (root !== '' && root !== tail && !chain.includes(root)) chain.push(root);
      }
      return chain;
    },

    /**
     * 解析一个会话的根（主会话）。
     */
    rootOf(sessionId, fallbackRoot) {
      const chain = this.chainOf(sessionId, fallbackRoot);
      return chain[chain.length - 1] ?? sessionId;
    },
  };
}
