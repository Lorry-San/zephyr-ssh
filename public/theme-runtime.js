const DEFAULT_BRAND_ICON = '🌬️';
const SCHEME_IDS = new Set(['frost', 'lava', 'asagi', 'cyber', 'custom']);

export const DEFAULT_CUSTOM_THEME_COLORS = Object.freeze({
    bgMain: '#0d1117',
    bgCard: '#161b22',
    primary: '#58a6ff',
    primaryHover: '#79c0ff',
    text: '#e6edf3',
    textSecondary: '#8b949e',
    border: '#30363d',
    danger: '#f85149',
    success: '#3fb950',
    warning: '#d2991d',
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

function escapeHtml(value = '') {
    return String(value || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function normalizeScheme(value = '') {
    const scheme = String(value || 'frost').toLowerCase();
    return SCHEME_IDS.has(scheme) ? scheme : 'frost';
}

function normalizeHex(value, fallback = '') {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

export function normalizeCustomThemeColors(colors = {}) {
    const out = {};
    Object.entries(DEFAULT_CUSTOM_THEME_COLORS).forEach(([key, fallback]) => {
        out[key] = normalizeHex(colors?.[key], fallback);
    });
    return out;
}

export function forcedThemeForAppearance(appearance = {}, getSystemTheme = () => 'dark') {
    const scheme = normalizeScheme(appearance.colorScheme || appearance.palette || 'frost');
    if (scheme === 'lava' || scheme === 'cyber') return 'dark';
    if (scheme === 'asagi') return 'light';
    if (scheme === 'custom') {
        const mode = String(appearance.customThemeMode || 'dark').toLowerCase();
        if (mode === 'light' || mode === 'dark') return mode;
        if (mode === 'auto') return getSystemTheme() === 'light' ? 'light' : 'dark';
        return 'dark';
    }
    return '';
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
        // Admin-defined site customization. Errors are isolated from Zephyr runtime.
        new Function('ZephyrCustomContext', code)(window.ZephyrCustomContext);
    } catch (err) {
        console.warn('[theme-runtime]', 'custom JS failed', { page: context.page || 'app', error: err?.message || String(err) });
    }
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
        root.style.setProperty('--protocol-badge-bg', `color-mix(in srgb, ${colors.primary} 14%, transparent)`);
        root.style.setProperty('--protocol-badge-fg', colors.primaryHover || colors.primary);
    } else {
        Object.values(CUSTOM_COLOR_VARS).flat().forEach((name) => root.style.removeProperty(name));
        root.style.removeProperty('--protocol-badge-bg');
        root.style.removeProperty('--protocol-badge-fg');
    }

    ensureCustomStyle('zephyr-custom-css', scheme === 'custom' ? String(appearance.customCss || '') : '');
    if (scheme === 'custom' && executeCustomJs) runCustomJsOnce(appearance.customJs || '', { page, scheme, theme: root.getAttribute('data-theme') || theme || '' });
}

export function zephyrBrandIconHtml(icon = DEFAULT_BRAND_ICON) {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return `<img src="${value}" alt="">`;
    if (value === DEFAULT_BRAND_ICON) {
        return `<span class="zephyr-brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><path d="M10 27h30.5c8.2 0 12.5-4.4 12.5-10.1 0-5.1-3.6-8.9-8.8-8.9-4.1 0-7.2 2.1-8.8 5.2"/><path d="M6 38h41.5c6.7 0 10.5 3.7 10.5 8.7 0 4.7-3.4 8.3-8.2 8.3-3.6 0-6.2-1.7-7.8-4.4"/><path d="M14 49h19.5c4.9 0 7.5-2.6 7.5-6.1 0-3.2-2.3-5.8-5.8-5.8-2.7 0-4.7 1.2-5.9 3.2"/></svg></span>`;
    }
    return escapeHtml(value);
}

export function zephyrFaviconHref(icon = DEFAULT_BRAND_ICON, color = '#58a6ff') {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return value;
    if (value === DEFAULT_BRAND_ICON) {
        const safeColor = String(color || '#58a6ff').replace(/[<>"']/g, '');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="transparent"/><g fill="none" stroke="${safeColor}" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 27h30.5c8.2 0 12.5-4.4 12.5-10.1 0-5.1-3.6-8.9-8.8-8.9-4.1 0-7.2 2.1-8.8 5.2"/><path d="M6 38h41.5c6.7 0 10.5 3.7 10.5 8.7 0 4.7-3.4 8.3-8.2 8.3-3.6 0-6.2-1.7-7.8-4.4"/><path d="M14 49h19.5c4.9 0 7.5-2.6 7.5-6.1 0-3.2-2.3-5.8-5.8-5.8-2.7 0-4.7 1.2-5.9 3.2"/></g></svg>`;
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${escapeHtml(value)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function brandIconColor(fallback = '#58a6ff') {
    try {
        const style = getComputedStyle(document.documentElement);
        return (style.getPropertyValue('--brand-icon-color') || style.getPropertyValue('--accent-hover') || style.getPropertyValue('--accent') || fallback).trim() || fallback;
    } catch (_) {
        return fallback;
    }
}
