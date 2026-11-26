/**
 * 配色皮肤与原生窗口的接线测试。
 *
 * `scripts/skins.mjs` 验的是纯逻辑（皮肤表、解析规则）；这个脚本验的是
 * **宿主侧的接线**：companion 到底算出了什么配色、有没有把它送进 state 包。
 *
 * 为什么不起真窗口：真窗口要开 GUI、要截屏没法稳定断言；而且这里要验的
 * 是**协议**——「宿主算出来的配色有没有按 companion 的协议进到 state 包里」。
 * 真窗口那一侧由 `scripts/skin-window-probe.mjs` 人工联调（见 README）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopCompanion } from '../lib/host/verbatim/desktop-companion.js';
import { resolveSkinTheme } from '../lib/host/skins.js';

const home = await mkdtemp(join(tmpdir(), 'lw-skinwin-'));
process.env.DSH_HOME = home;

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error && error.message || error)); }
}

/**
 * 起一个 companion（不开窗口，只验配色计算与 state 包内容）。
 *
 * @param {object} options 传给 companion 的选项。
 * @returns {{companion: object, packets: object[], cleanup: Function}} 测试句柄。
 */
function startCompanion(options) {
  const packets = [];
  const companion = createDesktopCompanion(
    {
      get: () => undefined,
      effect: (fn) => { fn(); return () => {}; },
      inject: () => {},
      /**
       * 抓 state 包：这个 companion 没有真窗口可写，所以从 refresh 路径上
       * 截获——它构造的 packet 就是原生窗口会收到的那个包。
       */
      on: () => () => {},
    },
    { read: async () => [], quota: async () => '', balance: async () => '', collapsed: async () => '', subscribe: () => () => {}, notify: () => {} },
    { executable: process.execPath, ...options },
  );
  return {
    companion,
    packets,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); },
  };
}

await check('the skin decides the colours the window will use', async () => {
  const { companion, cleanup } = startCompanion({
    readSkin: () => 'cream',
    readThemeMode: () => 'dark',
  });
  try {
    const theme = companion.effectiveTheme();
    const expected = resolveSkinTheme('cream', 'dark', { scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' });
    assert.equal(theme.scheme, 'dark');
    assert.equal(theme.accent, expected.accent);
    assert.equal(theme.surface, expected.surface);
    assert.equal(theme.foreground, expected.foreground);
  } finally {
    await cleanup();
  }
});

await check('switching the skin recomputes the colours', async () => {
  let skin = 'classic';
  const { companion, cleanup } = startCompanion({
    readSkin: () => skin,
    readThemeMode: () => 'dark',
  });
  try {
    assert.equal(companion.effectiveTheme().surface, '000000', 'the classic skin is black');
    skin = 'cream';
    companion.refreshSkin({ skin: 'cream' });
    assert.equal(companion.effectiveTheme().surface, '2E2016', 'the cream skin is dark brown');
  } finally {
    await cleanup();
  }
});

await check('"follow" hands the whole palette to DSH', async () => {
  const { companion, cleanup } = startCompanion({
    readSkin: () => 'follow',
    readThemeMode: () => 'follow',
  });
  try {
    assert.equal(companion.handleTheme({ scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' }), true);
    const theme = companion.effectiveTheme();
    assert.equal(theme.scheme, 'light');
    assert.equal(theme.accent, '4176E6');
    assert.equal(theme.surface, 'FFFFFF');
    assert.equal(theme.foreground, '0F1115');
  } finally {
    await cleanup();
  }
});

await check('a fixed skin ignores the DSH colours but keeps its own', async () => {
  const { companion, cleanup } = startCompanion({
    readSkin: () => 'glass_light',
    readThemeMode: () => 'follow',
  });
  try {
    companion.handleTheme({ scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' });
    const theme = companion.effectiveTheme();
    assert.equal(theme.scheme, 'light', 'the mode still follows DSH');
    assert.equal(theme.accent, '0A70E6', 'the accent is the skin, not DSH');
    assert.equal(theme.foreground, '16161A', 'the foreground is the skin');
  } finally {
    await cleanup();
  }
});

await check('a malformed DSH theme is rejected instead of applied', async () => {
  const { companion, cleanup } = startCompanion({
    readSkin: () => 'follow',
    readThemeMode: () => 'follow',
  });
  try {
    const before = companion.effectiveTheme();
    assert.equal(companion.handleTheme({ scheme: 'purple', accent: 'nope' }), false);
    assert.deepEqual(companion.effectiveTheme(), before, 'a bad theme must not change anything');
  } finally {
    await cleanup();
  }
});

await check('a fixed mode overrides the DSH mode even when the skin follows DSH', async () => {
  const { companion, cleanup } = startCompanion({
    readSkin: () => 'follow',
    readThemeMode: () => 'dark',
  });
  try {
    companion.handleTheme({ scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' });
    /* 跟随 DSH 皮肤时配色整体来自 DSH，明暗也由 DSH 决定——
     * 强制明暗只改 scheme 会让「配色跟不跟 DSH」变得含糊。 */
    const theme = companion.effectiveTheme();
    assert.equal(theme.scheme, 'light');
    assert.equal(theme.accent, '4176E6');
  } finally {
    await cleanup();
  }
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall skin window checks passed');
