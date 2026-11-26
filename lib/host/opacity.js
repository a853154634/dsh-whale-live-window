/**
 * 实况窗的窗口透明度。
 *
 * 原生窗口本身**不透明**：它把 theme 的 surface 色画成实心底板，主题协议
 * （`--theme=scheme,accent,surface,foreground`）只认 6 位 RGB，没有 alpha 通道。
 *
 * 但 Windows 允许给窗口加 `WS_EX_LAYERED` 样式，再用
 * `SetLayeredWindowAttributes` 整窗调节不透明度。实测有效：
 *
 *   alpha 255 → 底板纯色；alpha 100 → 桌面背景按比例透进来。
 *
 * 两个已知的事实（都实测过，别再重查）：
 *
 *   1. `SetLayeredWindowAttributes` 要求窗口**已经**带 `WS_EX_LAYERED`，
 *      原生窗口没有这个样式，直接调用会失败。所以要先补样式再设 alpha。
 *   2. 这个 alpha 作用于**整个窗口**（含文字），不是只作用于底板。
 *      实况窗另有一个 `DaozaiGlassBackdrop` 模糊底板窗口，但只改它没有效果 ——
 *      不透明底板是主窗口自己画的。所以「文字也变淡」由颜色补偿处理
 *      （见 skins.js 的 readableForeground）。
 *
 * Node 没有内置 Win32 绑定，本插件又不引入原生依赖，所以用一个常驻的
 * PowerShell 助手（`opacity-helper.ps1`）做 Win32 互操作：启动时编译一次，
 * 之后走 stdin/stdout 的 JSON 行协议。拖动滑块时只是一次 IPC 往返。
 *
 * 非 Windows 平台没有这套 API，全部函数返回「没做」，不报错。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 实况窗主窗口的标题。 */
export const WINDOW_TITLE = '实况窗';

/** 透明度下限：低于这个值文字就基本看不清了。 */
export const MIN_OPACITY = 25;

/** 透明度上限。 */
export const MAX_OPACITY = 100;

/** 默认不透明度（不透明）。 */
export const DEFAULT_OPACITY = 100;

/**
 * 是不是受支持的不透明度值。
 *
 * @param {unknown} value 待校验的值（0-100 的整数百分比）。
 * @returns {boolean} 是否合法。
 */
export function isOpacity(value) {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= MIN_OPACITY && value <= MAX_OPACITY;
}

/**
 * 把任意输入收拾成合法的不透明度。
 *
 * @param {unknown} value 待收拾的值。
 * @returns {number} 25-100 的整数百分比。
 */
export function normalizeOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_OPACITY;
  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, Math.round(value)));
}

/**
 * 百分比转 Win32 的 alpha 字节。
 *
 * 这里**不**套 normalizeOpacity：alpha 是 0-255 的连续值，调用方给的
 * 百分比要如实映射。下限（25%）由设置面板与配置校验负责，不在这里拦。
 *
 * @param {number} opacity 0-100 的百分比。
 * @returns {number} 0-255 的 alpha。
 */
export function opacityToAlpha(opacity) {
  const level = typeof opacity === 'number' && Number.isFinite(opacity)
    ? Math.max(0, Math.min(100, opacity))
    : DEFAULT_OPACITY;
  return Math.round((level / 100) * 255);
}

/** 助手进程（懒启动，只在 Windows 上）。 */
let helper = null;
/** 助手是否已经启动过（失败过就不再重试，免得刷屏）。 */
let helperFailed = false;
/** 等待中的请求。 */
const pending = new Map();
/** 下一个请求 id。 */
let nextId = 1;

/**
 * 启动常驻的 PowerShell 助手。
 *
 * @returns {object|null} 助手句柄，失败时是 null。
 */
function startHelper() {
  if (helper) return helper;
  if (helperFailed) return null;
  if (process.platform !== 'win32') { helperFailed = true; return null; }
  const script = fileURLToPath(new URL('./opacity-helper.ps1', import.meta.url));
  let child;
  try {
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    helperFailed = true;
    return null;
  }
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  child.on('error', () => { helperFailed = true; helper = null; });
  child.on('exit', () => { helperFailed = true; helper = null; });
  child.stderr.resume();
  /* 助手是常驻的，但**不能**让它吊住宿主进程的 event loop ——
   * 否则插件卸载后 Node 不会退出（测试跑完会挂住）。
   * unref 解除「等待子进程」与管道这两项，通信照旧。 */
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  helper = child;
  return child;
}

/**
 * 停掉助手进程。
 */
export function stopOpacityHelper() {
  if (!helper) return;
  try { helper.stdin.end(); } catch { /* 已经断了 */ }
  try { helper.kill(); } catch { /* 已经退了 */ }
  helper = null;
  helperFailed = false;
}

/**
 * 给助手发一条请求并等它的回复。
 *
 * @param {object} request 请求对象。
 * @param {number} timeoutMs 超时（毫秒）。
 * @returns {Promise<object>} 助手的回复。
 */
function ask(request, timeoutMs = 3000) {
  const child = startHelper();
  if (!child) return Promise.resolve({ ok: false, error: 'helper unavailable' });
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    try {
      child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: String(error && error.message || error) });
    }
  });
}

/**
 * 给实况窗设置不透明度。
 *
 * 不传窗口标题：标题是中文，经过 PowerShell 的控制台管道会被拆坏
 * （实测「实况窗」变成乱码，JSON 直接解析失败）。助手改为按
 * 「有标题 + 可见 + 类名 `Window Class`」自己挑出主窗口 —— 实况窗进程里
 * 只有它符合这三条。
 *
 * @param {number} pid 窗口进程 id。
 * @param {number} opacity 0-100 的百分比。
 * @returns {Promise<boolean>} 是否成功。
 */
export async function applyOpacity(pid, opacity) {
  if (process.platform !== 'win32') return false;
  if (typeof pid !== 'number' || pid <= 0) return false;
  const response = await ask({
    op: 'setAlpha',
    pid,
    alpha: opacityToAlpha(opacity),
  });
  return response?.ok === true;
}

/**
 * 助手是否可用（用于设置面板决定要不要显示透明度滑块）。
 *
 * @returns {boolean} 是否支持透明度调节。
 */
export function isOpacitySupported() {
  return process.platform === 'win32';
}
