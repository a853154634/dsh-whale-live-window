/**
 * 透明度测试。
 *
 * 这组测试盯两件事：
 *
 *   1. **纯逻辑**：不透明度的取值范围、百分比→alpha 的换算、按不透明度
 *      补偿文字颜色的规则、以及每套皮肤各自记一个值的解析。
 *   2. **宿主接线**：宿主算出的不透明度有没有真的施加到原生窗口上。
 *
 * 第 2 条用真窗口验：起一个真的原生窗口（`bin/daozai.exe`），用宿主的
 * `applyOpacity` 把它调成半透明，然后**读回窗口的 alpha**（Windows 会
 * 自己保存这个值），确认值真的进去了。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OPACITY, MAX_OPACITY, MIN_OPACITY, WINDOW_TITLE,
  isOpacity, normalizeOpacity, opacityToAlpha,
} from '../lib/host/opacity.js';
import { resolveSkinTheme, skinOpacity, skinCatalog } from '../lib/host/skins.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error && error.message || error)); }
}

await check('the opacity range is enforced', () => {
  assert.equal(MIN_OPACITY, 25);
  assert.equal(MAX_OPACITY, 100);
  assert.equal(DEFAULT_OPACITY, 100);
  assert.equal(isOpacity(100), true);
  assert.equal(isOpacity(25), true);
  assert.equal(isOpacity(24), false, 'below the floor is refused');
  assert.equal(isOpacity(101), false, 'above the ceiling is refused');
  assert.equal(isOpacity(50.5), false, 'only whole numbers');
  assert.equal(isOpacity('50'), false, 'strings are refused');
  assert.equal(isOpacity(undefined), false);
});

await check('a bad opacity falls back to the default', () => {
  assert.equal(normalizeOpacity(undefined), DEFAULT_OPACITY);
  assert.equal(normalizeOpacity('abc'), DEFAULT_OPACITY);
  assert.equal(normalizeOpacity(NaN), DEFAULT_OPACITY);
  assert.equal(normalizeOpacity(10), MIN_OPACITY, 'clamped up to the floor');
  assert.equal(normalizeOpacity(999), MAX_OPACITY, 'clamped down to the ceiling');
  assert.equal(normalizeOpacity(63.6), 64, 'rounded');
});

await check('the percentage maps onto the Win32 alpha range', () => {
  assert.equal(opacityToAlpha(100), 255);
  assert.equal(opacityToAlpha(50), 128);
  assert.equal(opacityToAlpha(0), 0, 'the raw mapping is continuous');
  assert.equal(opacityToAlpha(200), 255, 'out-of-range values are clamped');
  /* 合法区间（>= 25）映射出来的 alpha 必须大于 0：全透明的话文字完全看不见。 */
  assert.ok(opacityToAlpha(MIN_OPACITY) > 0);
});

await check('each skin carries its own default opacity', () => {
  const catalog = skinCatalog();
  for (const skin of catalog) {
    assert.equal(typeof skin.opacity, 'number', 'skin ' + skin.id + ' has no opacity');
    assert.ok(skin.opacity >= MIN_OPACITY && skin.opacity <= MAX_OPACITY, 'bad opacity for ' + skin.id);
  }
  /* 毛玻璃系天生就该透一点；经典与奶油默认不透明。 */
  assert.equal(skinOpacity('glass_light'), 85);
  assert.equal(skinOpacity('glass_dark'), 85);
  assert.equal(skinOpacity('classic'), 100);
  assert.equal(skinOpacity('cream'), 100);
  assert.equal(skinOpacity('follow'), 100);
});

await check('a fully opaque window gets no colour compensation', () => {
  const theme = { scheme: 'dark', accent: '8DA6FF', surface: '202A43', foreground: 'EDF2FF' };
  const result = resolveSkinTheme('follow', 'follow', theme, 100);
  assert.deepEqual(result, theme, 'nothing changes at full opacity');
});

await check('a translucent window gets brighter text to stay readable', () => {
  const theme = { scheme: 'dark', accent: '8DA6FF', surface: '000000', foreground: 'FFFFFF' };
  const result = resolveSkinTheme('classic', 'dark', theme, 50);
  /* 窗口变淡后，纯白字会淡到看不清，所以前景色要往底色方向压一点。 */
  assert.notEqual(result.foreground, theme.foreground, 'the foreground was compensated');
  const luminance = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  /* 补偿后不能比原来更暗（深底浅字场景）。 */
  assert.ok(luminance(result.foreground) <= luminance(theme.foreground), 'the foreground did not get darker');
  assert.ok(result.foreground.startsWith('#'), 'the foreground stays a hex colour');
});

await check('the opacity reaches the real native window', async () => {
  if (process.platform !== 'win32') {
    console.log('     (skipped: Windows only)');
    return;
  }
  const home = await mkdtemp(join(tmpdir(), 'lw-opacity-'));
  const executable = fileURLToPath(new URL('../bin/daozai.exe', import.meta.url));
  const child = spawn(executable, ['--whale-live-window', '--theme=dark,8DA6FF,7A1FA2,FFFFFF'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DAOZAI_DATA_DIR: home },
  });
  try {
    /* 等窗口 ready。 */
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('the window never became ready')), 20000);
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('"ready"')) { clearTimeout(timer); resolve(); }
      });
    });
    /* 推一个 state 包，让窗口把胶囊画出来。 */
    child.stdin.write(JSON.stringify({
      type: 'state', activeId: 'probe', thinkingCount: 0, waitingCount: 0,
      idleBalance: '', completionSequence: 0, draft: null,
      prefs: {
        autoCollapse: true, reducedMotion: false, showDetails: true, topPosition: 0,
        topDisplay: '', shape: 'pill', collapsedDisplay: 'amount',
        completionSound: false, completionFlash: true, sharedDrafts: false,
      },
      theme: { scheme: 'dark', accent: '8DA6FF', surface: '7A1FA2', foreground: 'FFFFFF' },
      sessions: [],
    }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const { applyOpacity, stopOpacityHelper } = await import('../lib/host/opacity.js');
    const applied = await applyOpacity(child.pid, 50);
    assert.equal(applied, true, 'the opacity was not applied to the native window');

    /* 读回窗口的 alpha：Windows 会自己保存这个值，读回来能确认真的进去了。 */
    const readBack = await readWindowAlpha(child.pid);
    assert.ok(readBack !== null, 'could not read the window alpha back');
    assert.ok(Math.abs(readBack - opacityToAlpha(50)) <= 2,
      `the window alpha is ${readBack}, expected about ${opacityToAlpha(50)}`);

    /* 助手是常驻的：测试结束要把它停掉，否则进程挂着不退。 */
    stopOpacityHelper();
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * 读回某个进程里实况窗窗口当前的 alpha。
 *
 * 借用 Windows 自带的 PowerShell 做一次性的 Win32 查询（测试里跑一次没关系）。
 * 中文标题同样会被控制台管道拆坏，所以按「有标题 + 可见 + 类名」挑窗口。
 *
 * @param {number} pid 窗口进程 id。
 * @returns {Promise<number|null>} alpha（0-255），读不到时是 null。
 */
async function readWindowAlpha(pid) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AlphaRead {
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
    public static int Read(uint pid) {
        int result = -1;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid) return true;
            var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
            if (sb.Length == 0) return true;
            if (!IsWindowVisible(h)) return true;
            var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);
            if (cn.ToString() != "Window Class") return true;
            uint k, f; byte a;
            if (GetLayeredWindowAttributes(h, out k, out a, out f)) result = a;
            return false;
        }, IntPtr.Zero);
        return result;
    }
}
'@
[AlphaRead]::Read(${pid})
`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) return null;
  const value = Number.parseInt(out.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall opacity checks passed');
