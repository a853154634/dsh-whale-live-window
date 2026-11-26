/**
 * 实况窗的配色皮肤表。
 *
 * 参照岛仔（xiaotang-daozai）的岛体配色模型：岛仔把「岛体配色」做成一份
 * 皮肤表，每种皮肤给出底色（paper）、文字色（ink）与强调色（accent），
 * 再由绘制层统一映射（见岛仔 `src/skin_paint.rs` 的 `Palette`）。
 *
 * 实况窗这边，原生窗口只有一条四色通道：
 *
 *     --theme=<scheme>,<accent>,<surface>,<foreground>
 *
 * 所以这里的「皮肤」就是一组 (scheme, accent, surface, foreground)，
 * 岛仔的 paper/ink/accent 三元组直接对应 surface/foreground/accent。
 *
 * 两级配置，与岛仔一致：
 *
 *   - **配色皮肤（skin）**：选哪一套配色。`follow` 表示完全用 DSH 当前主题；
 *     其余四种是岛仔的皮肤（经典 / 奶油 / 毛玻璃·浅 / 毛玻璃·深）。
 *   - **明暗模式（themeMode）**：明暗跟随 DSH，还是固定浅色 / 深色。
 *
 * 固定皮肤都备了浅色与深色两套配色，所以强制明暗永远不会出现
 * 「深色底 + 浅色字」这种读不清的组合；只有 DSH 自己的调色板是绑在
 * 明暗上的，因此 `skin=follow` 时明暗模式强制跟随 DSH。
 */

/** 全部配色皮肤 id。顺序即设置面板里的显示顺序。 */
export const SKIN_IDS = ['follow', 'classic', 'cream', 'glass_light', 'glass_dark'];

/** 全部明暗模式 id。 */
export const THEME_MODE_IDS = ['follow', 'light', 'dark'];

/** 原生窗口没拿到颜色时用的兜底主题（与原版默认一致）。 */
export const DEFAULT_THEME = Object.freeze({
  scheme: 'dark', accent: '8DA6FF', surface: '202A43', foreground: 'EDF2FF',
});

/**
 * 皮肤表。
 *
 * 浅色/深色两套配色取自岛仔的真实常量：
 *
 *   - CREAM       纸 [255,243,228] 墨 [46,32,22] 强调 [240,138,36]
 *   - GLASS_LIGHT 纸 [255,255,255] 墨 [22,22,26] 强调 [10,112,230]
 *   - GLASS_DARK  纸 [0,0,0]       墨 [255,255,255]（不替换强调色）
 *   - 毛玻璃底色  浅 [248,248,250] 深 [28,28,30]
 *   - 经典        纯黑岛体，强调色沿用岛仔的 DeepSeek 徽标色 #4d6bfe
 *
 * @type {{id: string, label: {zh: string, en: string}, description: {zh: string, en: string}, palette: {light: object, dark: object}|null}[]}
 */
const SKIN_DEFINITIONS = [
  {
    id: 'follow',
    label: { zh: '跟随 DSH', en: 'Follow DSH' },
    description: {
      zh: '沿用 DSH 当前主题的配色与明暗；切换 DSH 主题时实况窗跟着变。',
      en: 'Use the palette and light/dark mode of the active DSH theme; the Live Window follows theme changes.',
    },
    palette: null,
  },
  {
    id: 'classic',
    label: { zh: '经典', en: 'Classic' },
    description: {
      zh: '纯黑底、白色文字，与屏幕刘海融为一体，资源占用最低。',
      en: 'Pure black with white text, blending into the screen notch; the lightest skin.',
    },
    palette: {
      light: { accent: '4D6BFE', surface: 'FFFFFF', foreground: '16161A' },
      dark: { accent: '4D6BFE', surface: '000000', foreground: 'FFFFFF' },
    },
  },
  {
    id: 'cream',
    label: { zh: '奶油', en: 'Cream' },
    description: {
      zh: '暖白底色配深棕文字和橙色强调，柔和明亮。',
      en: 'Warm paper background with dark brown text and an orange accent.',
    },
    palette: {
      light: { accent: 'F08A24', surface: 'FFF3E4', foreground: '2E2016' },
      dark: { accent: 'F08A24', surface: '2E2016', foreground: 'FFF3E4' },
    },
  },
  {
    id: 'glass_light',
    label: { zh: '毛玻璃·浅', en: 'Glass light' },
    description: {
      zh: '浅色磨砂玻璃，文字为深色；按背景明暗自动调整，保证清晰。',
      en: 'Light frosted glass with dark text; adjusted to the background to stay legible.',
    },
    palette: {
      light: { accent: '0A70E6', surface: 'FFFFFF', foreground: '16161A' },
      dark: { accent: '0A70E6', surface: 'F8F8FA', foreground: '16161A' },
    },
  },
  {
    id: 'glass_dark',
    label: { zh: '毛玻璃·深', en: 'Glass dark' },
    description: {
      zh: '深色磨砂玻璃，文字为白色；按背景明暗自动调整，保证清晰。',
      en: 'Dark frosted glass with white text; adjusted to the background to stay legible.',
    },
    palette: {
      light: { accent: '0A70E6', surface: '1C1C1E', foreground: 'FFFFFF' },
      dark: { accent: '0A70E6', surface: '000000', foreground: 'FFFFFF' },
    },
  },
];

/** 明暗模式的文案。 */
const THEME_MODE_DEFINITIONS = [
  { id: 'follow', label: { zh: '跟随 DSH', en: 'Follow DSH' } },
  { id: 'light', label: { zh: '浅色', en: 'Light' } },
  { id: 'dark', label: { zh: '深色', en: 'Dark' } },
];

/**
 * 是不是受支持的配色皮肤 id。
 *
 * @param {unknown} value 待校验的值。
 * @returns {boolean} 是否是合法皮肤 id。
 */
export function isSkinId(value) {
  return typeof value === 'string' && SKIN_IDS.includes(value);
}

/**
 * 是不是受支持的明暗模式 id。
 *
 * @param {unknown} value 待校验的值。
 * @returns {boolean} 是否是合法明暗模式 id。
 */
export function isThemeModeId(value) {
  return typeof value === 'string' && THEME_MODE_IDS.includes(value);
}

/**
 * 皮肤表（给设置面板用）。中英文文案都带上，界面自己按当前语言选。
 *
 * @returns {{id: string, label: {zh: string, en: string}, description: {zh: string, en: string}}[]} 皮肤清单。
 */
export function skinCatalog() {
  return SKIN_DEFINITIONS.map((skin) => ({
    id: skin.id,
    label: { ...skin.label },
    description: { ...skin.description },
  }));
}

/**
 * 明暗模式清单（给设置面板用）。
 *
 * @returns {{id: string, label: {zh: string, en: string}}[]} 明暗模式清单。
 */
export function themeModeCatalog() {
  return THEME_MODE_DEFINITIONS.map((mode) => ({
    id: mode.id,
    label: { ...mode.label },
  }));
}

/**
 * 取某套皮肤里给定明暗的配色。
 *
 * @param {string} skinId 皮肤 id。
 * @param {'light'|'dark'} scheme 明暗。
 * @returns {{accent: string, surface: string, foreground: string}|undefined} 配色，固定皮肤一定有。
 */
export function skinPalette(skinId, scheme) {
  const skin = SKIN_DEFINITIONS.find((entry) => entry.id === skinId);
  if (!skin || !skin.palette) return undefined;
  return skin.palette[scheme === 'light' ? 'light' : 'dark'];
}

/**
 * 把一份主题收拾成原生窗口认的形状。
 *
 * @param {unknown} value 待收拾的主题。
 * @returns {{scheme: string, accent: string, surface: string, foreground: string}} 规范后的主题。
 */
export function normalizeTheme(value) {
  const source = value && typeof value === 'object' ? value : {};
  const scheme = source.scheme === 'light' ? 'light' : 'dark';
  const color = (input, fallback) => (typeof input === 'string' && /^[\da-f]{6}$/i.test(input)
    ? input.toUpperCase()
    : fallback);
  return {
    scheme,
    accent: color(source.accent, DEFAULT_THEME.accent),
    surface: color(source.surface, DEFAULT_THEME.surface),
    foreground: color(source.foreground, DEFAULT_THEME.foreground),
  };
}

/**
 * 算出原生窗口最终该用的配色。
 *
 * 规则：
 *
 *   - `skin=follow`：整个主题交给 DSH 的主题（明暗与三色都跟 DSH 走）。
 *   - 固定皮肤：配色取皮肤，明暗取 `themeMode`；`themeMode=follow` 时
 *     跟 DSH 的明暗走，并取皮肤对应明暗的那套配色。
 *
 * @param {string} skinId 皮肤 id。
 * @param {string} themeMode 明暗模式 id。
 * @param {unknown} baseTheme DSH 当前主题（跟随时用）。
 * @returns {{scheme: string, accent: string, surface: string, foreground: string}} 生效的配色。
 */
export function resolveSkinTheme(skinId, themeMode, baseTheme) {
  const base = normalizeTheme(baseTheme);
  if (!isSkinId(skinId) || skinId === 'follow') return base;
  const scheme = themeMode === 'light' || themeMode === 'dark' ? themeMode : base.scheme;
  const palette = skinPalette(skinId, scheme) ?? skinPalette(skinId, 'dark');
  if (!palette) return base;
  return {
    scheme,
    accent: normalizeTheme({ accent: palette.accent }).accent,
    surface: normalizeTheme({ surface: palette.surface }).surface,
    foreground: normalizeTheme({ foreground: palette.foreground }).foreground,
  };
}
