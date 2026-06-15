const DEFAULT_BRAND_ICON = '🌬️';
const SCHEME_IDS = new Set(['frost', 'lava', 'asagi', 'cyber', 'custom']);

export const DEFAULT_CUSTOM_THEME_COLORS = Object.freeze({
    bgMain: '#101114',
    bgCard: '#1b1c20',
    primary: '#0a84ff',
    primaryHover: '#2997ff',
    text: '#f4f4f6',
    textSecondary: '#9a9ca3',
    border: '#303237',
    danger: '#ff453a',
    success: '#32d74b',
    warning: '#ffd60a',
});

const ICON_PALETTES = Object.freeze({
    frost: { main: '#eef2f7', mid: '#a8b5c3', dark: '#6e7b88', glow: 'rgba(10, 132, 255, 0.18)', title: '#0a84ff', dotA: '#0a84ff', dotB: '#8e99a6', midOffset: '58%', polar: false },
    lava: { main: '#f1e8df', mid: '#c79672', dark: '#8d5a3a', glow: 'rgba(191, 90, 31, 0.16)', title: '#bf5a1f', dotA: '#bf5a1f', dotB: '#a58a78', midOffset: '58%', polar: false },
    asagi: { main: '#edf4f2', mid: '#9bbdb5', dark: '#5e8f83', glow: 'rgba(77, 156, 138, 0.15)', title: '#4d9c8a', dotA: '#4d9c8a', dotB: '#829b96', midOffset: '58%', polar: false },
    cyber: { main: '#eef3f5', mid: '#9eb7bd', dark: '#5d858d', glow: 'rgba(79, 157, 166, 0.15)', title: '#4f9da6', dotA: '#4f9da6', dotB: '#7f9298', midOffset: '58%', polar: false },
});

const CUSTOM_COLOR_VARS = Object.freeze({
    bgMain: ['--bg-main', '--bg'],
    bgCard: ['--bg-card', '--surface'],
    primary: ['--color-primary', '--accent', '--brand-icon-color'],
    primaryHover: ['--color-primary-hover', '--accent-hover'],
    text: ['--text'],
    textSecondary: ['--text-secondary'],
    border: ['--border'],
    danger: ['--danger'],
    success: ['--success'],
    warning: ['--warning'],
});

let iconSeq = 0;

function escapeHtml(value = '') {
    return String(value || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function normalizeScheme(value = '') {
    const scheme = String(value || 'frost').toLowerCase();
    return SCHEME_IDS.has(scheme) ? scheme : 'frost';
}

function normalizeHex(value, fallback = '') {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function hexToRgb(hex) {
    const safe = normalizeHex(hex, '#000000').slice(1);
    return { r: parseInt(safe.slice(0, 2), 16), g: parseInt(safe.slice(2, 4), 16), b: parseInt(safe.slice(4, 6), 16) };
}

function rgbToHex({ r, g, b }) {
    const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
}

function rgba(hex, alpha = 1) {
    const { r, g, b } = hexToRgb(hex);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function mixHex(a, b, weightB = 0.5) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    const w = Math.max(0, Math.min(1, Number(weightB)));
    return rgbToHex({ r: ca.r * (1 - w) + cb.r * w, g: ca.g * (1 - w) + cb.g * w, b: ca.b * (1 - w) + cb.b * w });
}

export function normalizeCustomThemeColors(colors = {}) {
    const out = {};
    Object.entries(DEFAULT_CUSTOM_THEME_COLORS).forEach(([key, fallback]) => {
        out[key] = normalizeHex(colors?.[key], fallback);
    });
    return out;
}

function ensureCustomStyle(id, cssText = '') {
    let style = document.getElementById(id);
    if (!cssText) {
        style?.remove();
        return;
    }
    if (!style) {
        style = document.createElement('style');
        style.id = id;
        document.head.appendChild(style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
}

function runCustomJsOnce(jsText = '', context = {}) {
    const code = String(jsText || '').trim();
    if (!code) return;
    const key = `${context.page || 'app'}:${code}`;
    if (window.__zephyrCustomJsLastRun === key) return;
    window.__zephyrCustomJsLastRun = key;
    try {
        window.ZephyrCustomContext = { ...(window.ZephyrCustomContext || {}), ...context };
        new Function('ZephyrCustomContext', code)(window.ZephyrCustomContext);
    } catch (err) {
        console.warn('[theme-runtime]', 'custom JS failed', { page: context.page || 'app', error: err?.message || String(err) });
    }
}

function currentScheme() {
    return normalizeScheme(document.documentElement?.getAttribute('data-color-scheme') || 'frost');
}

function paletteForScheme(scheme = currentScheme()) {
    const normalized = normalizeScheme(scheme);
    if (normalized !== 'custom') return ICON_PALETTES[normalized] || ICON_PALETTES.frost;
    const root = document.documentElement;
    const primary = normalizeHex(root?.style?.getPropertyValue('--color-primary') || '', DEFAULT_CUSTOM_THEME_COLORS.primary);
    return {
        main: mixHex(primary, '#ffffff', 0.68),
        mid: mixHex(primary, '#ffffff', 0.34),
        dark: primary,
        glow: rgba(primary, 0.42),
        title: primary,
        dotA: primary,
        dotB: mixHex(primary, '#ffffff', 0.52),
        midOffset: '60%',
        polar: false,
    };
}

function applyIconPaletteVars(root, palette) {
    root.style.setProperty('--zephyr-icon-main', palette.main);
    root.style.setProperty('--zephyr-icon-mid', palette.mid);
    root.style.setProperty('--zephyr-icon-dark', palette.dark);
    root.style.setProperty('--zephyr-icon-glow', palette.glow);
    root.style.setProperty('--zephyr-icon-title', palette.title || palette.dark);
    root.style.setProperty('--zephyr-icon-dot-a', palette.dotA || palette.dark);
    root.style.setProperty('--zephyr-icon-dot-b', palette.dotB || palette.mid);
    root.style.setProperty('--zephyr-icon-grad-start', palette.polar ? palette.dark : palette.main);
    root.style.setProperty('--zephyr-icon-grad-mid', palette.mid);
    root.style.setProperty('--zephyr-icon-grad-end', palette.polar ? palette.main : palette.dark);
    root.style.setProperty('--zephyr-icon-grad-mid-offset', palette.midOffset || '60%');
    root.style.setProperty('--brand-icon-color', palette.title || palette.dark);
    root.style.setProperty('--brand-icon-glow', palette.glow);
}

export function applyZephyrColorScheme(appearance = {}, { theme = '', page = 'app', executeCustomJs = true } = {}) {
    const root = document.documentElement;
    if (!root) return;
    const scheme = normalizeScheme(appearance.colorScheme || appearance.palette || 'frost');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    root.setAttribute('data-color-scheme', scheme);

    if (scheme === 'custom') {
        const colors = normalizeCustomThemeColors(appearance.customColors || {});
        Object.entries(CUSTOM_COLOR_VARS).forEach(([key, vars]) => {
            vars.forEach((name) => root.style.setProperty(name, colors[key]));
        });
        root.style.setProperty('--protocol-badge-bg', rgba(colors.primary, 0.14));
        root.style.setProperty('--protocol-badge-fg', colors.primaryHover || colors.primary);
        root.style.setProperty('--accent-soft-border', rgba(colors.primary, 0.48));
        root.style.setProperty('--accent-soft-bg', rgba(colors.primary, 0.12));
        root.style.setProperty('--accent-glow', rgba(colors.primary, 0.28));
        applyIconPaletteVars(root, paletteForScheme('custom'));
    } else {
        Object.values(CUSTOM_COLOR_VARS).flat().forEach((name) => root.style.removeProperty(name));
        ['--protocol-badge-bg', '--protocol-badge-fg', '--accent-soft-border', '--accent-soft-bg', '--accent-glow'].forEach((name) => root.style.removeProperty(name));
        applyIconPaletteVars(root, ICON_PALETTES[scheme] || ICON_PALETTES.frost);
    }

    ensureCustomStyle('zephyr-custom-css', scheme === 'custom' ? String(appearance.customCss || '') : '');
    if (scheme === 'custom' && executeCustomJs) runCustomJsOnce(appearance.customJs || '', { page, scheme, theme: root.getAttribute('data-theme') || theme || '' });
}

function zephyrWindSvg({ gradientId = 'zephyr-brand-gradient', title = 'Zephyr' } = {}) {
    return `<svg class="zephyr-brand-svg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false"><title>${escapeHtml(title)}</title><defs><linearGradient id="${gradientId}" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="var(--zephyr-icon-grad-start, #e0f2fe)"/><stop offset="var(--zephyr-icon-grad-mid-offset, 60%)" stop-color="var(--zephyr-icon-grad-mid, #93c5fd)"/><stop offset="100%" stop-color="var(--zephyr-icon-grad-end, #60a5fa)"/></linearGradient></defs><path class="wind-path-main" d="M 45 65 C 85 45, 135 55, 160 80 C 130 80, 95 95, 75 125" stroke="url(#${gradientId})"/><path class="wind-path-mid" d="M 50 75 C 90 75, 125 90, 145 115 C 115 135, 75 155, 40 135" stroke="url(#${gradientId})"/><path class="wind-path-tail" d="M 85 95 C 110 110, 135 135, 155 130" stroke="url(#${gradientId})"/><circle cx="145" cy="115" r="4.5" fill="var(--zephyr-icon-dot-a, #60a5fa)" opacity="0.9"/><circle cx="75" cy="125" r="3" fill="var(--zephyr-icon-dot-b, #93c5fd)" opacity="0.8"/></svg>`;
}

export function zephyrBrandIconHtml(icon = DEFAULT_BRAND_ICON) {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return `<img src="${value}" alt="">`;
    if (value === DEFAULT_BRAND_ICON) {
        const gradientId = `zephyr-brand-gradient-${++iconSeq}`;
        return `<span class="zephyr-brand-mark" aria-hidden="true">${zephyrWindSvg({ gradientId })}</span>`;
    }
    return escapeHtml(value);
}

function faviconSvgForPalette(palette) {
    const midOffset = palette.midOffset || '60%';
    const s0 = palette.polar ? palette.dark : palette.main;
    const s1 = palette.mid;
    const s2 = palette.polar ? palette.main : palette.dark;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none"><defs><linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="${s0}"/><stop offset="${midOffset}" stop-color="${s1}"/><stop offset="100%" stop-color="${s2}"/></linearGradient></defs><path d="M 45 65 C 85 45, 135 55, 160 80 C 130 80, 95 95, 75 125" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M 50 75 C 90 75, 125 90, 145 115 C 115 135, 75 155, 40 135" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/><path d="M 85 95 C 110 110, 135 135, 155 130" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/><circle cx="145" cy="115" r="4.5" fill="${palette.dotA || palette.dark}" opacity="0.9"/><circle cx="75" cy="125" r="3" fill="${palette.dotB || palette.mid}" opacity="0.8"/></svg>`;
}

export function zephyrFaviconHref(icon = DEFAULT_BRAND_ICON) {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return value;
    if (value === DEFAULT_BRAND_ICON) return `data:image/svg+xml,${encodeURIComponent(faviconSvgForPalette(paletteForScheme()))}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${escapeHtml(value)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
