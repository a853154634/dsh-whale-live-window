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
    opacity: 100,
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
    /* 每套皮肤有自己的默认不透明度。经典是纯黑，半透明时最自然，
     * 所以默认给 100（不透明）；毛玻璃系天生就该透，默认给 85。 */
    opacity: 100,
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
    opacity: 100,
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
    opacity: 85,
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
    opacity: 85,
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
 * 每套皮肤还带一个**默认不透明度**：毛玻璃系天生就该透一点（85），
 * 经典与奶油默认不透明（100）。
 *
 * @returns {{id: string, label: {zh: string, en: string}, description: {zh: string, en: string}, opacity: number}[]} 皮肤清单。
 */
export function skinCatalog() {
  return SKIN_DEFINITIONS.map((skin) => ({
    id: skin.id,
    label: { ...skin.label },
    description: { ...skin.description },
    opacity: skin.opacity ?? 100,
  }));
}

/**
 * 取某套皮肤的默认不透明度。
 *
 * @param {string} skinId 皮肤 id。
 * @returns {number} 0-100 的不透明度。
 */
export function skinOpacity(skinId) {
  const skin = SKIN_DEFINITIONS.find((entry) => entry.id === skinId);
  return skin?.opacity ?? 100;
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
 * @param {number} [opacity] 窗口不透明度（0-100）。低于 100 时整窗变淡，
 *   文字也跟着淡，所以要提亮前景色补偿（见 readableForeground）。
 * @returns {{scheme: string, accent: string, surface: string, foreground: string}} 生效的配色。
 */
export function resolveSkinTheme(skinId, themeMode, baseTheme, opacity = 100) {
  const base = normalizeTheme(baseTheme);
  if (!isSkinId(skinId) || skinId === 'follow') {
    return withOpacityCompensation(base, opacity);
  }
  const scheme = themeMode === 'light' || themeMode === 'dark' ? themeMode : base.scheme;
  const palette = skinPalette(skinId, scheme) ?? skinPalette(skinId, 'dark');
  if (!palette) return withOpacityCompensation(base, opacity);
  return withOpacityCompensation({
    scheme,
    accent: normalizeTheme({ accent: palette.accent }).accent,
    surface: normalizeTheme({ surface: palette.surface }).surface,
    foreground: normalizeTheme({ foreground: palette.foreground }).foreground,
  }, opacity);
}

/**
 * 按不透明度补偿前景色。
 *
 * 窗口的 alpha 作用于**整窗**（底板和文字一起淡）。窗口变淡后，原本的
 * 文字色在浅色背景上会看不清，所以按淡的程度把前景色往白色推。
 *
 * 只在「深色底 + 浅色字」时提亮；「浅色底 + 深色字」时反而要压暗，
 * 否则字会淡到看不见。
 *
 * @param {{scheme: string, accent: string, surface: string, foreground: string}} theme 配色。
 * @param {number} opacity 0-100 的不透明度。
 * @returns {{scheme: string, accent: string, surface: string, foreground: string}} 补偿后的配色。
 */
export function withOpacityCompensation(theme, opacity) {
  const level = normalizeOpacityLevel(opacity);
  if (level >= 100) return theme;
  const foreground = mixColor(theme.foreground, theme.surface, level / 100);
  const accent = mixColor(theme.accent, theme.surface, (level / 100) * 0.5);
  return { ...theme, foreground, accent };
}

/**
 * 把不透明度收拾成 0-100 的整数。
 *
 * @param {unknown} value 待收拾的值。
 * @returns {number} 0-100 的整数。
 */
function normalizeOpacityLevel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * 两个颜色按比例混合。
 *
 * @param {string} from 起点颜色（`#RRGGBB`）。
 * @param {string} to 终点颜色（`#RRGGBB`）。
 * @param {number} ratio 混合比例（0 = 全是 from，1 = 全是 to）。
 * @returns {string} 混合后的 `#RRGGBB`。
 */
function mixColor(from, to, ratio) {
  const parse = (value) => {
    const match = typeof value === 'string' ? value.match(/^#?([\da-f]{6})$/i) : null;
    if (!match) return null;
    const digits = match[1];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ];
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return from;
  const clamped = Math.max(0, Math.min(1, ratio));
  const mixed = a.map((channel, index) => Math.round(channel + (b[index] - channel) * clamped));
  return '#' + mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
}
