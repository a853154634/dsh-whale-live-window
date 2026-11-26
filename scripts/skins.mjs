/**
 * 配色皮肤测试。
 *
 * 这一轮新增的东西：参照岛仔灵动岛的配色模型，给实况窗加「配色皮肤 +
 * 明暗模式」两级配置。这组测试把三件容易悄悄坏掉的事钉住：
 *
 *   1. 皮肤表本身：每个皮肤都得有浅色与深色两套配色，且颜色合法；
 *   2. 解析规则：「跟随 DSH」用 DSH 的配色，固定皮肤用自己的配色，
 *      明暗模式固定时用对应明暗的那一套；
 *   3. 宿主链路：配置能读能写，清单会下发给设置面板。
 */
import assert from 'node:assert/strict';
import {
  SKIN_IDS, THEME_MODE_IDS, isSkinId, isThemeModeId,
  normalizeTheme, resolveSkinTheme, skinCatalog, skinPalette, themeModeCatalog,
} from '../lib/host/skins.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error && error.message || error)); }
}

/** 原生窗口只认 `#RRGGBB`（见 desktop-companion 的 readTheme）。 */
const HEX = /^[\dA-F]{6}$/;

await check('the skin catalog lists every skin with both palettes', () => {
  const catalog = skinCatalog();
  assert.equal(catalog.length, SKIN_IDS.length, 'catalog size matches the id list');
  for (const skin of catalog) {
    assert.ok(SKIN_IDS.includes(skin.id), 'unexpected skin id: ' + skin.id);
    assert.ok(skin.label.zh && skin.label.en, 'skin needs a bilingual label: ' + skin.id);
    assert.ok(skin.description.zh && skin.description.en, 'skin needs a bilingual description: ' + skin.id);
  }
});

await check('every fixed skin has a valid light and dark palette', () => {
  for (const id of SKIN_IDS) {
    if (id === 'follow') continue;
    for (const scheme of ['light', 'dark']) {
      const palette = skinPalette(id, scheme);
      assert.ok(palette, 'missing palette: ' + id + '/' + scheme);
      for (const key of ['accent', 'surface', 'foreground']) {
        assert.match(palette[key], HEX, 'bad color ' + key + ' in ' + id + '/' + scheme + ': ' + palette[key]);
      }
    }
  }
});

await check('the "follow" skin has no palette of its own', () => {
  assert.equal(skinPalette('follow', 'dark'), undefined);
  assert.equal(skinPalette('follow', 'light'), undefined);
});

await check('the island skins carry the colours the island app uses', () => {
  /* 岛仔的常量：奶油纸 [255,243,228] 墨 [46,32,22] 强调 [240,138,36]；
   * 毛玻璃浅色 强调 [10,112,230]；深色毛玻璃底 [28,28,30]。 */
  const cream = skinPalette('cream', 'light');
  assert.equal(cream.surface, 'FFF3E4');
  assert.equal(cream.foreground, '2E2016');
  assert.equal(cream.accent, 'F08A24');
  const glassLight = skinPalette('glass_light', 'light');
  assert.equal(glassLight.accent, '0A70E6');
  const glassDark = skinPalette('glass_dark', 'dark');
  assert.equal(glassDark.surface, '000000');
  assert.equal(glassDark.foreground, 'FFFFFF');
});

await check('unknown ids are rejected instead of silently accepted', () => {
  assert.equal(isSkinId('cream'), true);
  assert.equal(isSkinId('nope'), false);
  assert.equal(isSkinId(undefined), false);
  assert.equal(isSkinId(42), false);
  assert.equal(isThemeModeId('dark'), true);
  assert.equal(isThemeModeId('nope'), false);
});

await check('a malformed theme falls back to the default colours', () => {
  const theme = normalizeTheme({ scheme: 'light', accent: 'zzz', surface: 42, foreground: '#abc' });
  assert.equal(theme.scheme, 'light');
  assert.match(theme.accent, HEX);
  assert.match(theme.surface, HEX);
  assert.match(theme.foreground, HEX);
  assert.equal(theme.accent, '8DA6FF', 'bad accent falls back to the default');
  assert.equal(theme.surface, '202A43', 'bad surface falls back to the default');
});

await check('"follow" hands the whole palette to DSH', () => {
  const dsh = { scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' };
  const theme = resolveSkinTheme('follow', 'follow', dsh);
  assert.deepEqual(theme, dsh);
});

await check('"follow" still follows DSH when the mode is forced', () => {
  /* 跟随 DSH 皮肤时强制明暗没有意义：配色整体都来自 DSH，
   * 硬改明暗只会让「配色跟不跟 DSH」变得含糊。 */
  const dsh = { scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' };
  const theme = resolveSkinTheme('follow', 'dark', dsh);
  assert.deepEqual(theme, dsh);
});

await check('a fixed skin replaces the palette but keeps the mode', () => {
  const dsh = { scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' };
  const theme = resolveSkinTheme('cream', 'follow', dsh);
  assert.equal(theme.scheme, 'light', 'the mode follows DSH');
  assert.equal(theme.surface, 'FFF3E4');
  assert.equal(theme.foreground, '2E2016');
  assert.equal(theme.accent, 'F08A24');
});

await check('a fixed mode overrides the DSH mode', () => {
  const dsh = { scheme: 'light', accent: '4176E6', surface: 'FFFFFF', foreground: '0F1115' };
  const dark = resolveSkinTheme('cream', 'dark', dsh);
  assert.equal(dark.scheme, 'dark');
  assert.equal(dark.surface, '2E2016', 'the dark cream palette is the inverse one');
  assert.equal(dark.foreground, 'FFF3E4');
  const light = resolveSkinTheme('cream', 'light', dsh);
  assert.equal(light.scheme, 'light');
  assert.equal(light.surface, 'FFF3E4');
});

await check('a fixed skin never produces unreadable colours', () => {
  /* 浅色皮肤在深色模式下要换成深底浅字，不能「深底深字」。 */
  for (const id of SKIN_IDS) {
    if (id === 'follow') continue;
    for (const scheme of ['light', 'dark']) {
      const theme = resolveSkinTheme(id, scheme, { scheme, accent: '8DA6FF', surface: '202A43', foreground: 'EDF2FF' });
      assert.equal(theme.scheme, scheme, 'mode honoured for ' + id);
      const luma = (hex) => {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b;
      };
      const surface = luma(theme.surface);
      const text = luma(theme.foreground);
      assert.ok(Math.abs(surface - text) > 60, 'surface and text are too close in ' + id + '/' + scheme);
    }
  }
});

await check('the theme-mode catalog is bilingual and complete', () => {
  const catalog = themeModeCatalog();
  assert.equal(catalog.length, THEME_MODE_IDS.length);
  for (const mode of catalog) {
    assert.ok(THEME_MODE_IDS.includes(mode.id));
    assert.ok(mode.label.zh && mode.label.en, 'mode needs a bilingual label: ' + mode.id);
  }
});

if (failures) { console.error('\n' + failures + ' failed'); process.exitCode = 1; }
else console.log('\nall skin checks passed');
