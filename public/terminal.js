const $ = (sel) => document.querySelector(sel);

function getParams() {
    try {
        const raw = sessionStorage.getItem('zephyr_ssh_params');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

const params = getParams();
if (!params) {
    window.location.href = '/';
    throw new Error('缺少连接参数');
}

// ---------- DOM 元素 ----------
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const terminalOverlay = $('#terminalOverlay');
const overlayMsg = $('#overlayMsg');
const terminalContainer = $('#terminalContainer');
const wtermWrapper = $('#wtermWrapper');
const terminalScrollbar = $('#terminalScrollbar');
const terminalScrollbarThumb = $('#terminalScrollbarThumb');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const themeToggle = $('#themeToggle');
const cmdInput = $('#cmdInput');
const cmdSendBtn = $('#cmdSendBtn');
const copyBtn = $('#copyBtn');
const fileBtn = $('#fileBtn');
const infoBtn = $('#infoBtn');
const fontDecreaseBtn = $('#fontDecreaseBtn');
const fontIncreaseBtn = $('#fontIncreaseBtn');

// 文件管理器 DOM
const fileManager = $('#fileManager');
const fmBackBtn = $('#fmBackBtn');
const fmPathInput = $('#fmPathInput');
const fmGoBtn = $('#fmGoBtn');
const fmRefreshBtn = $('#fmRefreshBtn');
const fmCloseBtn = $('#fmCloseBtn');
const fmNewFolderBtn = $('#fmNewFolderBtn');
const fmNewFileBtn = $('#fmNewFileBtn');
const fmUploadInput = $('#fmUploadInput');
const fmSearchInput = $('#fmSearchInput');
const fmList = $('#fmList');
const fmEditorModal = $('#fmEditorModal');
const fmEditorTitle = $('#fmEditorTitle');
const fmEditorMain = $('#fmEditorMain');
const fmEditorTextarea = $('#fmEditorTextarea');
const fmEditorHighlight = $('#fmEditorHighlight');
const fmEditorMinimap = $('#fmEditorMinimap');
const fmEditorMinimapCode = $('#fmEditorMinimapCode');
const fmEditorMinimapToggle = $('#fmEditorMinimapToggle');
const fmEditorSaveBtn = $('#fmEditorSaveBtn');
const fmEditorCancelBtn = $('#fmEditorCancelBtn');
const fmEditorCloseBtn = $('#fmEditorCloseBtn');
const fmEditorUndoBtn = $('#fmEditorUndoBtn');
const fmEditorRedoBtn = $('#fmEditorRedoBtn');
const fmEditorEncoding = $('#fmEditorEncoding');
const fmEditorLineEnding = $('#fmEditorLineEnding');
const fmEditorTabSize = $('#fmEditorTabSize');
const fmEditorWrap = $('#fmEditorWrap');
const fmEditorStatus = $('#fmEditorStatus');

// 监控相关 DOM
const infoModal = $('#infoModal');
const infoCloseBtn = $('#infoCloseBtn');
const infoBody = $('#infoBody');

// ---------- 全局变量 ----------
let term = null;
let wsConnection = null;
let isConnected = false;
let sftpReady = false;
let currentPath = '.';
let allFiles = [];
let searchQuery = '';
let editorFilePath = null;
let editorLanguage = 'plain';
let editorRawBytes = null;
let editorMinimapHidden = localStorage.getItem('zephyr-editor-minimap-hidden') === '1';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const EDITOR_MINIMAP_SCALE = 0.22;

// 图表实例管理
let chartInstances = {};
let shouldFollowTerminalOutput = true;
let terminalScrollRaf = 0;
let terminalScrollbarRaf = 0;
let isProgrammaticTerminalScroll = false;
let terminalScrollCleanup = null;
let terminalInputEchoSuppressUntil = 0;
let terminalInputEchoMaxLength = 0;
let terminalFontSize = 14;
let pinchStartDistance = 0;
let pinchStartFontSize = 14;
let pinchLastAppliedFontSize = 14;
let suppressNextLayoutClick = false;

const TERMINAL_FONT_MIN = 10;
const TERMINAL_FONT_MAX = 28;
const TERMINAL_FONT_STEP = 1;
const TERMINAL_FONT_STORAGE_KEY = 'zephyr-terminal-font-size';
const TERMINAL_BOTTOM_THRESHOLD = 48;
const TERMINAL_SCROLLBAR_MIN_THUMB = 28;


// ---------- 主题管理 ----------
function getPreferredTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('zephyr-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}
applyTheme(getPreferredTheme());

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'light' : 'dark');
    }
});

// ---------- 终端字体缩放 ----------
function clampTerminalFontSize(size) {
    return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

function getStoredTerminalFontSize() {
    const saved = Number(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY));
    return Number.isFinite(saved) ? clampTerminalFontSize(saved) : terminalFontSize;
}

function updateFontSizeButtons() {
    if (fontDecreaseBtn) fontDecreaseBtn.disabled = terminalFontSize <= TERMINAL_FONT_MIN;
    if (fontIncreaseBtn) fontIncreaseBtn.disabled = terminalFontSize >= TERMINAL_FONT_MAX;
}

function getTerminalCharMetrics() {
    const root = getTerminalScrollElement?.() || wtermWrapper;
    const computed = getComputedStyle(root);
    const fontSize = terminalFontSize || parseFloat(computed.fontSize) || 14;
    const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.25;
    return {
        lineHeight,
        charWidth: fontSize * 0.62,
    };
}

function sendTerminalResize(cols, rows) {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return;
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
        wsConnection.send(JSON.stringify({
            type: 'resize',
            rows: Math.max(2, Math.floor(rows)),
            cols: Math.max(2, Math.floor(cols)),
        }));
        return;
    }
    const rect = wtermWrapper.getBoundingClientRect();
    const { lineHeight, charWidth } = getTerminalCharMetrics();
    wsConnection.send(JSON.stringify({
        type: 'resize',
        rows: Math.max(2, Math.floor(rect.height / lineHeight)),
        cols: Math.max(2, Math.floor(rect.width / charWidth)),
    }));
}

function scheduleTerminalResize() {
    window.clearTimeout(scheduleTerminalResize._timer);
    scheduleTerminalResize._timer = window.setTimeout(sendTerminalResize, 120);
}

function applyTerminalFontSize(size, { persist = true } = {}) {
    terminalFontSize = clampTerminalFontSize(size);
    document.documentElement.style.setProperty('--terminal-font-size', `${terminalFontSize}px`);
    wtermWrapper.style.fontSize = `${terminalFontSize}px`;
    try { term?.setOption?.('fontSize', terminalFontSize); } catch (_) {}
    try { term?.options && (term.options.fontSize = terminalFontSize); } catch (_) {}
    if (persist) localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(terminalFontSize));
    updateFontSizeButtons();
    scheduleTerminalResize();
    scheduleTerminalScrollToBottom();
}

function getTouchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function setupTerminalPinchZoom() {
    wtermWrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        pinchStartDistance = getTouchDistance(e.touches);
        pinchStartFontSize = terminalFontSize;
        pinchLastAppliedFontSize = terminalFontSize;
    }, { passive: false });

    wtermWrapper.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2 || !pinchStartDistance) return;
        e.preventDefault();
        const distance = getTouchDistance(e.touches);
        const nextSize = clampTerminalFontSize(pinchStartFontSize * (distance / pinchStartDistance));
        if (nextSize !== pinchLastAppliedFontSize) {
            pinchLastAppliedFontSize = nextSize;
            applyTerminalFontSize(nextSize);
        }
    }, { passive: false });

    const endPinch = () => { pinchStartDistance = 0; };
    wtermWrapper.addEventListener('touchend', endPinch, { passive: true });
    wtermWrapper.addEventListener('touchcancel', endPinch, { passive: true });
}

applyTerminalFontSize(getStoredTerminalFontSize(), { persist: false });
fontDecreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize - TERMINAL_FONT_STEP));
fontIncreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize + TERMINAL_FONT_STEP));
setupTerminalPinchZoom();

// ---------- 复制功能 ----------
copyBtn.addEventListener('click', async () => {
    const selection = window.getSelection();
    const text = selection.toString();
    if (!text) return;
    const originalText = copyBtn.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✅ 已复制';
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); copyBtn.textContent = '✅ 已复制'; } catch (_) { copyBtn.textContent = '❌ 失败'; }
        document.body.removeChild(ta);
    }
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

// ---------- Ctrl+C 智能判断 ----------
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c') {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text) return;
        e.preventDefault();
        sendData('\x03');
    }
});

// ---------- 文件管理器 ----------
function showFileManager() {
    ensureFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
    fileManager.classList.add('open');
    fileBtn.classList.add('active');
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}
function hideFileManager() {
    fileManager.classList.remove('open');
    fileBtn.classList.remove('active');
}
fileBtn.addEventListener('click', () => {
    if (fileManager.classList.contains('open')) hideFileManager();
    else showFileManager();
});
fmCloseBtn.addEventListener('click', hideFileManager);

function initSFTP() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-init' }));
}
function refreshFileList() {
    if (!sftpReady) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-list', path: currentPath }));
    fmPathInput.value = currentPath;
}
fmRefreshBtn.addEventListener('click', refreshFileList);

function navigateTo(path) {
    currentPath = path;
    searchQuery = '';
    fmSearchInput.value = '';
    refreshFileList();
}
fmGoBtn.addEventListener('click', () => {
    const p = fmPathInput.value.trim();
    if (p) navigateTo(p);
});
fmPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const p = fmPathInput.value.trim();
        if (p) navigateTo(p);
    }
});
fmBackBtn.addEventListener('click', () => {
    const parts = currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    navigateTo(parts.join('/') || '/');
});
fmSearchInput.addEventListener('input', () => {
    searchQuery = fmSearchInput.value.trim();
    renderFileList(allFiles);
});

function sortFiles(files) {
    return [...files].sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'd' ? -1 : 1;
    });
}
function filterFiles(files, query) {
    if (!query) return files;
    return files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
}

fmList.addEventListener('click', (e) => {
    if (e.target.closest('.fm-item-actions')) return;
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const fileName = item.dataset.fileName;
    const fileType = item.dataset.fileType;
    if (!fileName) return;
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + fileName;
    if (fileType === 'd') navigateTo(fullPath);
    else openEditor(fullPath);
});

function renderFileList(files) {
    allFiles = sortFiles(files);
    const filtered = filterFiles(allFiles, searchQuery);
    fmList.innerHTML = '';
    filtered.forEach(file => {
        const item = document.createElement('div');
        item.className = 'fm-item';
        item.dataset.fileName = file.name;
        item.dataset.fileType = file.type;
        const icon = file.type === 'd' ? '📁' : '📄';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${icon} ${file.name}`;
        const actions = document.createElement('div');
        actions.className = 'fm-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.textContent = '✏️';
        renameBtn.title = '重命名';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = prompt('新名称:', file.name);
            if (!newName) return;
            const oldPath = currentPath.replace(/\/+$/, '') + '/' + file.name;
            const newPath = currentPath.replace(/\/+$/, '') + '/' + newName;
            wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath, newPath }));
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = '删除';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确认删除 ${file.name}?`)) {
                wsConnection.send(JSON.stringify({
                    type: 'sftp-delete',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            }
        });

        if (file.type !== 'd') {
            const downloadBtn = document.createElement('button');
            downloadBtn.textContent = '⬇️';
            downloadBtn.title = '下载';
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                wsConnection.send(JSON.stringify({
                    type: 'sftp-download',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            });
            actions.appendChild(downloadBtn);
        }

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(nameSpan);
        item.appendChild(actions);
        fmList.appendChild(item);
    });
}

// 新建文件夹
fmNewFolderBtn.addEventListener('click', () => {
    const name = prompt('请输入文件夹名称:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 新建文件
fmNewFileBtn.addEventListener('click', () => {
    const name = prompt('请输入文件名:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 上传文件
fmUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        wsConnection.send(JSON.stringify({ type: 'sftp-upload', path: currentPath.replace(/\/+$/, '') + '/' + file.name, data: base64 }));
    };
    reader.readAsDataURL(file);
    fmUploadInput.value = '';
});
// 编辑器
function base64ToBytes(base64) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function decodeBytes(bytes, encoding) {
    if (!bytes) return '';
    if (encoding === 'utf-16be') {
        const swapped = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 2) {
            swapped[i] = bytes[i + 1] || 0;
            swapped[i + 1] = bytes[i] || 0;
        }
        return new TextDecoder('utf-16le').decode(swapped);
    }
    const decoderEncoding = encoding === 'latin1' ? 'iso-8859-1' : encoding;
    return new TextDecoder(decoderEncoding).decode(bytes);
}

function encodeText(text, encoding) {
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const offset = i * 2;
            if (encoding === 'utf-16le') {
                bytes[offset] = code & 0xff;
                bytes[offset + 1] = code >> 8;
            } else {
                bytes[offset] = code >> 8;
                bytes[offset + 1] = code & 0xff;
            }
        }
        return bytes;
    }
    if (encoding === 'latin1') {
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }
    return new TextEncoder().encode(text);
}

function detectEncoding(bytes) {
    if (!bytes || bytes.length < 2) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return 'utf-8';
}

function detectLineEnding(text) {
    return /\r\n/.test(text) ? 'crlf' : 'lf';
}

function normalizeLineEnding(text, lineEnding) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return lineEnding === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function updateEditorStatus() {
    const text = fmEditorTextarea.value || '';
    const lines = text.length ? text.split(/\r\n|\r|\n/).length : 1;
    const langLabel = getEditorLanguageLabel(editorLanguage);
    fmEditorStatus.textContent = `${lines} 行 · ${text.length} 字符 · ${editorRawBytes?.length || 0} bytes · ${langLabel}`;
    renderEditorCodeLayers();
}

const EDITOR_LANGUAGE_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'javascript',
    html: 'html', htm: 'html', xml: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    py: 'python', rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', env: 'shell',
    md: 'markdown', markdown: 'markdown',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', sql: 'sql', lua: 'lua',
};

const EDITOR_LANGUAGE_BY_NAME = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile',
    'compose.yml': 'yaml', 'compose.yaml': 'yaml',
};

const EDITOR_LANGUAGE_LABELS = {
    plain: 'Plain Text', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON',
    html: 'HTML/XML', css: 'CSS', python: 'Python', shell: 'Shell', yaml: 'YAML',
    markdown: 'Markdown', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++',
    csharp: 'C#', php: 'PHP', ruby: 'Ruby', sql: 'SQL', lua: 'Lua', dockerfile: 'Dockerfile',
    makefile: 'Makefile', toml: 'TOML', ini: 'INI', kotlin: 'Kotlin', swift: 'Swift',
};

const EDITOR_KEYWORDS = {
    javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null true false undefined'.split(' ')),
    typescript: new Set('abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield'.split(' ')),
    json: new Set('true false null'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'.split(' ')),
    shell: new Set('alias bg bind break builtin case cd command continue do done echo elif else esac eval exec exit export false fg fi for function getopts hash if in jobs kill let local logout popd printf pushd pwd read readonly return select set shift source test then time trap true type typeset ulimit umask unalias unset until wait while sudo'.split(' ')),
    yaml: new Set('true false null yes no on off'.split(' ')),
    css: new Set('important import media supports keyframes from to and or not only screen print all root'.split(' ')),
    go: new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var nil true false iota'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while'.split(' ')),
    c: new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while null NULL'.split(' ')),
    cpp: new Set('alignas alignof and asm auto bitand bitor bool break case catch char char16_t char32_t class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor'.split(' ')),
    php: new Set('abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list namespace new null or print private protected public require require_once return static switch throw trait try unset use var while xor yield true false'.split(' ')),
    ruby: new Set('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')),
    sql: new Set('add all alter and as asc by case check column constraint create database default delete desc distinct drop else exists foreign from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then union unique update values view where true false'.split(' ')),
    lua: new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' ')),
    dockerfile: new Set('FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'.split(' ')),
    makefile: new Set('include define endef ifeq ifneq ifdef ifndef else endif export unexport override private vpath'.split(' ')),
    markdown: new Set(), toml: new Set('true false'.split(' ')), ini: new Set('true false yes no on off'.split(' ')),
};

function detectEditorLanguage(filePath = '') {
    const fileName = (filePath.split('/').pop() || '').toLowerCase();
    if (EDITOR_LANGUAGE_BY_NAME[fileName]) return EDITOR_LANGUAGE_BY_NAME[fileName];
    const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
    return EDITOR_LANGUAGE_BY_EXT[ext] || 'plain';
}

function getEditorLanguageLabel(language) {
    return EDITOR_LANGUAGE_LABELS[language] || EDITOR_LANGUAGE_LABELS.plain;
}

function escapeHtml(text = '') {
    return String(text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function tok(type, text) {
    if (!text) return '';
    return `<span class="tok-${type}">${escapeHtml(text)}</span>`;
}

function getLineComment(language) {
    if (['python', 'shell', 'yaml', 'ruby', 'toml', 'ini', 'dockerfile', 'makefile'].includes(language)) return '#';
    if (['sql', 'lua'].includes(language)) return '--';
    if (language === 'plain' || language === 'json') return '';
    return '//';
}

function getBlockComment(language) {
    if (['javascript', 'typescript', 'css', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'swift', 'kotlin'].includes(language)) {
        return ['/*', '*/'];
    }
    return null;
}

function readQuoted(line, start, quote, language, state) {
    const triple = (language === 'python' || language === 'ruby') && (quote === '"' || quote === "'") && line.startsWith(quote.repeat(3), start);
    const delimiter = triple ? quote.repeat(3) : quote;
    let i = start + delimiter.length;
    while (i < line.length) {
        if (!triple && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            return { end: i, closed: true, delimiter };
        }
        i++;
    }
    const canContinue = triple || quote === '`' || (!triple && line.endsWith('\\'));
    if (canContinue) state.stringQuote = delimiter;
    return { end: line.length, closed: false, delimiter };
}

function finishOpenString(line, state) {
    const delimiter = state.stringQuote;
    let i = 0;
    while (i < line.length) {
        if (delimiter.length === 1 && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            state.stringQuote = '';
            return { html: tok('string', line.slice(0, i)), index: i };
        }
        i++;
    }
    return { html: tok('string', line), index: line.length };
}

function classifyIdentifier(identifier, line, start, end, language) {
    const keywords = EDITOR_KEYWORDS[language] || EDITOR_KEYWORDS.plain;
    const upper = identifier.toUpperCase();
    const normalized = language === 'dockerfile' ? upper : identifier;
    const after = line.slice(end).trimStart();
    const before = line.slice(0, start).trimEnd();

    if (keywords?.has(normalized) || keywords?.has(identifier)) return tok('keyword', identifier);
    if (/^(true|false|null|nil|None|True|False|undefined|NaN|Infinity)$/i.test(identifier)) return tok('literal', identifier);
    if ((language === 'json' || language === 'yaml' || language === 'toml' || language === 'ini') && after.startsWith(':')) return tok('attr', identifier);
    if (language === 'css' && (after.startsWith(':') || identifier.startsWith('--'))) return tok(identifier.startsWith('--') ? 'variable' : 'attr', identifier);
    if (after.startsWith('(') && !before.endsWith('.')) return tok('function', identifier);
    if (before.endsWith('.') || before.endsWith('::')) return tok('property', identifier);
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(identifier)) return tok('type', identifier);
    return escapeHtml(identifier);
}

function highlightHtmlTag(rawTag) {
    const match = rawTag.match(/^(<\/?)([^\s>/]+)([\s\S]*?)(\/?>)$/);
    if (!match) return tok('tag', rawTag);
    const [, open, name, attrs, close] = match;
    let html = `${tok('punctuation', open)}${tok('tag', name)}`;
    const attrRegex = /([:@A-Za-z_][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g;
    let lastIndex = 0;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrs))) {
        html += escapeHtml(attrs.slice(lastIndex, attrMatch.index));
        html += tok('attr', attrMatch[1]);
        if (attrMatch[2]) html += tok('operator', attrMatch[2]);
        if (attrMatch[3]) html += tok('string', attrMatch[3]);
        lastIndex = attrRegex.lastIndex;
    }
    html += escapeHtml(attrs.slice(lastIndex));
    html += tok('punctuation', close);
    return html;
}

function highlightHtmlLine(line, state) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        if (state.htmlComment) {
            const end = line.indexOf('-->', i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + 3));
            state.htmlComment = false;
            i = end + 3;
            continue;
        }
        if (line.startsWith('<!--', i)) {
            const end = line.indexOf('-->', i + 4);
            if (end === -1) {
                state.htmlComment = true;
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + 3));
            i = end + 3;
            continue;
        }
        if (line[i] === '<') {
            const end = line.indexOf('>', i + 1);
            if (end !== -1) {
                html += highlightHtmlTag(line.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (line[i] === '&') {
            const entity = line.slice(i).match(/^&[A-Za-z0-9#]+;/)?.[0];
            if (entity) {
                html += tok('literal', entity);
                i += entity.length;
                continue;
            }
        }
        html += escapeHtml(line[i]);
        i++;
    }
    return html;
}

function highlightMarkdownLine(line) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return tok('keyword', line);
    if (/^\s{0,3}([-*+]\s|\d+\.\s)/.test(line)) return line.replace(/^([\s\d.*+-]+)/, (m) => tok('operator', m));
    return highlightGenericLine(line, 'plain', {});
}

function highlightGenericLine(line, language, state) {
    if (language === 'html') return highlightHtmlLine(line, state);
    if (language === 'markdown') return highlightMarkdownLine(line);

    let html = '';
    let i = 0;
    const lineComment = getLineComment(language);
    const blockComment = getBlockComment(language);

    while (i < line.length) {
        if (state.stringQuote) {
            const open = finishOpenString(line.slice(i), state);
            html += open.html;
            i += open.index;
            continue;
        }

        if (state.blockComment) {
            const end = line.indexOf(state.blockComment, i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + state.blockComment.length));
            i = end + state.blockComment.length;
            state.blockComment = '';
            continue;
        }

        if (blockComment && line.startsWith(blockComment[0], i)) {
            const end = line.indexOf(blockComment[1], i + blockComment[0].length);
            if (end === -1) {
                state.blockComment = blockComment[1];
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + blockComment[1].length));
            i = end + blockComment[1].length;
            continue;
        }

        if (lineComment && line.startsWith(lineComment, i)) {
            html += tok('comment', line.slice(i));
            break;
        }

        const rest = line.slice(i);
        if (language === 'markdown' && /^\s{0,3}>/.test(rest)) {
            html += tok('comment', rest);
            break;
        }

        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quoted = readQuoted(line, i, ch, language, state);
            html += tok('string', line.slice(i, quoted.end));
            i = quoted.end;
            continue;
        }

        const atRule = rest.match(/^@[A-Za-z_-][\w-]*/)?.[0];
        if (atRule && (language === 'css' || language === 'java' || language === 'typescript')) {
            html += tok('keyword', atRule);
            i += atRule.length;
            continue;
        }

        const number = rest.match(/^(0x[\da-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
        if (number && !/[\w$]/.test(line[i - 1] || '')) {
            html += tok('number', number);
            i += number.length;
            continue;
        }

        const identifier = rest.match(/^[A-Za-z_$-][\w$-]*/)?.[0];
        if (identifier && !identifier.startsWith('-')) {
            html += classifyIdentifier(identifier, line, i, i + identifier.length, language);
            i += identifier.length;
            continue;
        }

        const operator = rest.match(/^(===|!==|=>|->|::|&&|\|\||\+\+|--|==|!=|<=|>=|[-+*/%=&|^!~?:]+)/)?.[0];
        if (operator) {
            html += tok('operator', operator);
            i += operator.length;
            continue;
        }

        if (/^[{}()[\],.;]$/.test(ch)) {
            html += tok('punctuation', ch);
            i++;
            continue;
        }

        html += escapeHtml(ch);
        i++;
    }
    return html;
}

function highlightCode(text, language) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const state = { blockComment: '', stringQuote: '', htmlComment: false };
    const highlighted = lines.map(line => highlightGenericLine(line, language, state));
    return highlighted.join('\n') || '&#8203;';
}

function syncEditorCodeScroll() {
    if (!fmEditorTextarea) return;
    if (fmEditorHighlight) {
        fmEditorHighlight.style.transform = `translate3d(${-fmEditorTextarea.scrollLeft}px, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    updateEditorMinimapViewport();
}

function renderEditorCodeLayers() {
    if (!fmEditorTextarea) return;
    const highlighted = highlightCode(fmEditorTextarea.value || '', editorLanguage);
    if (fmEditorHighlight) fmEditorHighlight.innerHTML = highlighted;
    if (fmEditorMinimapCode && !editorMinimapHidden) fmEditorMinimapCode.innerHTML = highlighted;
    syncEditorCodeScroll();
}

function updateEditorMinimap() {
    if (!fmEditorMinimap) return;
    fmEditorModal.classList.toggle('minimap-hidden', editorMinimapHidden);
    fmEditorMinimapToggle?.classList.toggle('active', !editorMinimapHidden);
    fmEditorMinimap.style.setProperty('--minimap-scale', String(EDITOR_MINIMAP_SCALE));
    renderEditorCodeLayers();
}

function updateEditorMinimapViewport() {
    if (!fmEditorMinimap || !fmEditorTextarea) return;
    if (editorMinimapHidden) return;
    const maxScroll = Math.max(1, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const ratio = fmEditorTextarea.scrollTop / maxScroll;
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const heightPercent = Math.max(10, viewportRatio * 100);
    fmEditorMinimap.style.setProperty('--minimap-view-top', `${ratio * (100 - heightPercent)}%`);
    fmEditorMinimap.style.setProperty('--minimap-view-height', `${heightPercent}%`);
    if (fmEditorMinimapCode) {
        const scaledHeight = fmEditorMinimapCode.scrollHeight * EDITOR_MINIMAP_SCALE;
        const overflow = Math.max(0, scaledHeight - fmEditorMinimap.clientHeight);
        fmEditorMinimap.style.setProperty('--minimap-code-top', `${-(ratio * overflow)}px`);
    }
}

function setEditorScrollFromMinimap(clientY) {
    if (!fmEditorMinimap || editorMinimapHidden) return;
    const rect = fmEditorMinimap.getBoundingClientRect();
    const maxScroll = Math.max(0, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const thumbHeight = Math.max(18, rect.height * viewportRatio);
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
    fmEditorTextarea.scrollTop = ratio * maxScroll;
    syncEditorCodeScroll();
}

function closeEditor({ animated = true } = {}) {
    if (!animated) {
        fmEditorModal.style.display = 'none';
        fmEditorModal.classList.remove('open', 'closing');
        return;
    }
    fmEditorModal.classList.remove('open');
    fmEditorModal.classList.add('closing');
    window.clearTimeout(closeEditor._timer);
    closeEditor._timer = window.setTimeout(() => {
        fmEditorModal.style.display = 'none';
        fmEditorModal.classList.remove('closing');
    }, 260);
}

function applyEditorOptions() {
    fmEditorTextarea.wrap = fmEditorWrap.checked ? 'soft' : 'off';
    fmEditorTextarea.style.tabSize = fmEditorTabSize.value;
    fmEditorMain?.classList.toggle('wrap-enabled', fmEditorWrap.checked);
    fmEditorHighlight?.style.setProperty('tab-size', fmEditorTabSize.value);
    fmEditorMinimapCode?.style.setProperty('tab-size', fmEditorTabSize.value);
    updateEditorMinimap();
}

function loadEditorFromBytes(bytes, encoding = fmEditorEncoding.value) {
    editorRawBytes = bytes;
    let text = decodeBytes(bytes, encoding);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    fmEditorTextarea.value = text;
    fmEditorLineEnding.value = detectLineEnding(text);
    applyEditorOptions();
    updateEditorStatus();
}

function openEditor(filePath) {
    editorFilePath = filePath;
    editorLanguage = detectEditorLanguage(filePath);
    fmEditorModal.style.display = 'flex';
    fmEditorModal.classList.remove('closing');
    requestAnimationFrame(() => fmEditorModal.classList.add('open'));
    fmEditorTitle.textContent = `编辑: ${filePath}`;
    fmEditorStatus.textContent = '读取中...';
    fmEditorTextarea.value = '';
    updateEditorMinimap();
    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath }));
}
fmEditorCloseBtn.addEventListener('click', () => closeEditor());
fmEditorCancelBtn.addEventListener('click', () => closeEditor());
fmEditorUndoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('undo');
    updateEditorStatus();
});
fmEditorRedoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('redo');
    updateEditorStatus();
});
fmEditorSaveBtn.addEventListener('click', () => {
    if (!editorFilePath) return;
    const text = normalizeLineEnding(fmEditorTextarea.value, fmEditorLineEnding.value);
    const bytes = encodeText(text, fmEditorEncoding.value);
    wsConnection.send(JSON.stringify({
        type: 'sftp-writefile',
        path: editorFilePath,
        data: bytesToBase64(bytes),
        encoding: 'base64',
    }));
    closeEditor();
});
fmEditorEncoding.addEventListener('change', () => {
    if (editorRawBytes) loadEditorFromBytes(editorRawBytes, fmEditorEncoding.value);
});
fmEditorLineEnding.addEventListener('change', updateEditorStatus);
fmEditorTabSize.addEventListener('change', applyEditorOptions);
fmEditorWrap.addEventListener('change', applyEditorOptions);
fmEditorTextarea.addEventListener('input', updateEditorStatus);
fmEditorTextarea.addEventListener('scroll', syncEditorCodeScroll, { passive: true });
fmEditorMinimap?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fmEditorMinimap.setPointerCapture?.(e.pointerId);
    setEditorScrollFromMinimap(e.clientY);
    fmEditorTextarea.focus();
    const onMove = (ev) => setEditorScrollFromMinimap(ev.clientY);
    const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
});
fmEditorMinimapToggle?.addEventListener('click', () => {
    editorMinimapHidden = !editorMinimapHidden;
    localStorage.setItem('zephyr-editor-minimap-hidden', editorMinimapHidden ? '1' : '0');
    updateEditorMinimap();
});
fmEditorTextarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const tab = ' '.repeat(Number(fmEditorTabSize.value) || 4);
    const { selectionStart, selectionEnd, value } = fmEditorTextarea;
    fmEditorTextarea.value = value.slice(0, selectionStart) + tab + value.slice(selectionEnd);
    fmEditorTextarea.selectionStart = fmEditorTextarea.selectionEnd = selectionStart + tab.length;
    updateEditorStatus();
});

if (window.ResizeObserver && fmEditorTextarea) {
    const editorResizeObserver = new ResizeObserver(updateEditorMinimapViewport);
    editorResizeObserver.observe(fmEditorTextarea);
}

// ---------- SFTP 消息处理 ----------
function handleSFTPMessage(msg) {
    switch (msg.type) {
        case 'sftp-ready': sftpReady = true; refreshFileList(); break;
        case 'sftp-list':
            if (msg.error) alert('列出目录失败: ' + msg.error);
            else { renderFileList(msg.files); currentPath = msg.path; fmPathInput.value = currentPath; }
            break;
        case 'sftp-mkdir': case 'sftp-touch': case 'sftp-delete': case 'sftp-rename': case 'sftp-upload':
            if (msg.success) refreshFileList(); else alert('操作失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-download':
            if (msg.error) alert('下载失败: ' + msg.error);
            else {
                const byteChars = atob(msg.data);
                const byteNums = new Array(byteChars.length).fill(0).map((_, i) => byteChars.charCodeAt(i));
                const blob = new Blob([new Uint8Array(byteNums)]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = msg.path.split('/').pop(); a.click();
                URL.revokeObjectURL(url);
            }
            break;
        case 'sftp-readfile':
            if (msg.error) {
                alert('读取失败: ' + msg.error);
                fmEditorStatus.textContent = '读取失败';
            } else {
                const bytes = msg.encoding === 'base64' ? base64ToBytes(msg.data) : new TextEncoder().encode(msg.data || '');
                fmEditorEncoding.value = detectEncoding(bytes);
                loadEditorFromBytes(bytes, fmEditorEncoding.value);
            }
            break;
        case 'sftp-writefile':
            if (msg.success) { refreshFileList(); closeEditor(); } else alert('保存失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-error': alert('SFTP 错误: ' + msg.message); sftpReady = false; break;
    }
}

// ---------- 监控面板 ----------
function safeVal(val, fallback = 0) {
    return (val != null && !isNaN(val)) ? val : fallback;
}

function destroyCharts() {
    Object.values(chartInstances).forEach(chart => {
        try { chart.destroy(); } catch (_) {}
    });
    chartInstances = {};
}

// 自定义插件：环形图中心显示百分比
const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
        const { ctx, chartArea, config: { type } } = chart;
        if (type !== 'doughnut' || !chartArea) return;
        const { left, top, right, bottom } = chartArea;
        if ([left, top, right, bottom].some((v) => typeof v !== 'number' || isNaN(v))) return;
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2 + (bottom - top) * 0.05;
        const value = chart.data.datasets[0].data[0] || 0;
        ctx.save();
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e6edf3';
        ctx.font = 'bold 18px "JetBrains Mono", "Fira Code", monospace';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(value)}%`, centerX, centerY);
        ctx.restore();
    }
};

function initCharts() {
    destroyCharts();

    const commonDoughnut = {
        type: 'doughnut',
        data: { datasets: [{ data: [0, 100], backgroundColor: ['#3fb950', 'rgba(139,148,158,0.25)'], borderWidth: 0 }] },
        options: {
            circumference: 270,
            rotation: 225,
            cutout: '80%',
            responsive: true,
            maintainAspectRatio: true,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        },
        plugins: [centerTextPlugin]
    };

    const commonLine = {
        type: 'line',
        data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } }
        }
    };

    document.querySelectorAll('.doughnut-wrap canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        chartInstances[id] = new Chart(canvas, commonDoughnut);
    });

    document.querySelectorAll('.sparkline-row canvas, .line-canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        const color = canvas.dataset.color || '#3fb950';
        const config = JSON.parse(JSON.stringify(commonLine));
        config.data.datasets[0].borderColor = color;
        config.data.datasets[0].fill = false;
        chartInstances[id] = new Chart(canvas, config);
    });
}

function updateDoughnut(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const p = Math.min(100, Math.max(0, safeVal(value)));
    if (chart.data.datasets[0].data[0] === p) return; // 无变化不更新
    chart.data.datasets[0].data = [p, 100 - p];
    const color = p < 50 ? '#3fb950' : p < 80 ? '#d2991d' : '#f85149';
    chart.data.datasets[0].backgroundColor = [color, 'rgba(139,148,158,0.25)'];
    chart.update('none');
}

function updateLine(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const data = chart.data.datasets[0].data;
    data.push(safeVal(value));
    if (data.length > 20) data.shift();
    chart.update('none');
}

function getTerminalScrollElement() {
    return wtermWrapper;
}

function getTerminalBottomDistance(el = getTerminalScrollElement()) {
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isTerminalAtBottom(el = getTerminalScrollElement(), threshold = TERMINAL_BOTTOM_THRESHOLD) {
    if (!el) return true;
    return getTerminalBottomDistance(el) <= threshold;
}

function getTerminalMaxScroll(el = getTerminalScrollElement()) {
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
}

function updateTerminalScrollbarNow() {
    const el = getTerminalScrollElement();
    if (!el || !terminalContainer || !terminalScrollbar || !terminalScrollbarThumb) return;
    const maxScroll = getTerminalMaxScroll(el);
    const scrollable = maxScroll > 1;
    terminalContainer.classList.toggle('scrollable', scrollable);
    el.classList.toggle('terminal-scrollable', scrollable);
    if (!scrollable) {
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', '0px');
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', '100%');
        return;
    }

    const trackHeight = terminalScrollbar.clientHeight || terminalScrollbar.getBoundingClientRect().height || 1;
    const thumbHeight = Math.min(trackHeight, Math.max(TERMINAL_SCROLLBAR_MIN_THUMB, (el.clientHeight / Math.max(el.scrollHeight, 1)) * trackHeight));
    const movable = Math.max(1, trackHeight - thumbHeight);
    const ratio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', `${thumbHeight}px`);
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', `${ratio * movable}px`);
}

function scheduleTerminalScrollbarUpdate() {
    if (terminalScrollbarRaf) return;
    terminalScrollbarRaf = requestAnimationFrame(() => {
        terminalScrollbarRaf = 0;
        updateTerminalScrollbarNow();
    });
}

function scrollTerminalToBottom() {
    const el = getTerminalScrollElement();
    if (!el) return;
    isProgrammaticTerminalScroll = true;
    el.scrollTop = getTerminalMaxScroll(el);
    shouldFollowTerminalOutput = true;
    scheduleTerminalScrollbarUpdate();
    requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
}

function markTerminalUserInput(data = '') {
    if (!data) return;
    shouldFollowTerminalOutput = true;
    terminalInputEchoSuppressUntil = performance.now() + 350;
    terminalInputEchoMaxLength = Math.max(terminalInputEchoMaxLength, data.length);
    scheduleTerminalScrollToBottom();
}

function isLikelyTerminalInputEcho(data = '') {
    if (!data || !terminalInputEchoMaxLength) return false;
    if (performance.now() > terminalInputEchoSuppressUntil) {
        terminalInputEchoMaxLength = 0;
        return false;
    }
    return data.length <= terminalInputEchoMaxLength + 8;
}

function scheduleTerminalScrollToBottom() {
    if (terminalScrollRaf) return;
    terminalScrollRaf = requestAnimationFrame(() => {
        terminalScrollRaf = 0;
        requestAnimationFrame(() => {
            if (shouldFollowTerminalOutput) scrollTerminalToBottom();
            else scheduleTerminalScrollbarUpdate();
        });
    });
}

function stopTerminalAutoScrollObserver() {
    if (terminalScrollRaf) {
        cancelAnimationFrame(terminalScrollRaf);
        terminalScrollRaf = 0;
    }
    if (terminalScrollbarRaf) {
        cancelAnimationFrame(terminalScrollbarRaf);
        terminalScrollbarRaf = 0;
    }
    terminalScrollCleanup?.();
    terminalScrollCleanup = null;
    isProgrammaticTerminalScroll = false;
}

function setupTerminalScrollHooks() {
    stopTerminalAutoScrollObserver();
    shouldFollowTerminalOutput = true;

    const onScroll = () => {
        if (!isProgrammaticTerminalScroll) {
            shouldFollowTerminalOutput = isTerminalAtBottom();
        }
        scheduleTerminalScrollbarUpdate();
    };

    const onWheel = (e) => {
        if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
            shouldFollowTerminalOutput = e.deltaY >= 0 ? isTerminalAtBottom(getTerminalScrollElement(), TERMINAL_BOTTOM_THRESHOLD * 2) : false;
        }
    };

    let touchStartY = 0;
    const onTouchStart = (e) => {
        if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
        if (e.touches.length !== 1) return;
        const dy = e.touches[0].clientY - touchStartY;
        if (Math.abs(dy) > 4) {
            shouldFollowTerminalOutput = dy < 0 ? isTerminalAtBottom(getTerminalScrollElement(), TERMINAL_BOTTOM_THRESHOLD * 2) : false;
        }
    };

    wtermWrapper.addEventListener('scroll', onScroll, { passive: true });
    wtermWrapper.addEventListener('wheel', onWheel, { passive: true });
    wtermWrapper.addEventListener('touchstart', onTouchStart, { passive: true });
    wtermWrapper.addEventListener('touchmove', onTouchMove, { passive: true });

    let resizeObserver = null;
    if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            if (shouldFollowTerminalOutput) scheduleTerminalScrollToBottom();
            else scheduleTerminalScrollbarUpdate();
        });
        resizeObserver.observe(wtermWrapper);
        const grid = wtermWrapper.querySelector('.term-grid');
        if (grid) resizeObserver.observe(grid);
    }

    setupTerminalCustomScrollbar();
    terminalScrollCleanup = () => {
        wtermWrapper.removeEventListener('scroll', onScroll);
        wtermWrapper.removeEventListener('wheel', onWheel);
        wtermWrapper.removeEventListener('touchstart', onTouchStart);
        wtermWrapper.removeEventListener('touchmove', onTouchMove);
        resizeObserver?.disconnect();
    };

    scheduleTerminalScrollToBottom();
    scheduleTerminalScrollbarUpdate();
}

function isModifierOnlyKeyEvent(e) {
    return ['Alt', 'Control', 'Meta', 'Shift', 'CapsLock'].includes(e.key);
}

function setupTerminalInputActivityHooks() {
    document.addEventListener('keydown', (e) => {
        if (isModifierOnlyKeyEvent(e)) return;
        if (document.activeElement === cmdInput) return;
        if (!terminalContainer?.contains(document.activeElement) && document.activeElement !== document.body) return;
        shouldFollowTerminalOutput = true;
        scheduleTerminalScrollToBottom();
    }, true);
}

function setupTerminalCustomScrollbar() {
    if (!terminalScrollbar || !terminalScrollbarThumb || terminalScrollbar._zephyrReady) return;
    terminalScrollbar._zephyrReady = true;

    const setScrollFromClientY = (clientY) => {
        const el = getTerminalScrollElement();
        const maxScroll = getTerminalMaxScroll(el);
        if (!el || maxScroll <= 0) return;
        const rect = terminalScrollbar.getBoundingClientRect();
        const thumbHeight = terminalScrollbarThumb.getBoundingClientRect().height || TERMINAL_SCROLLBAR_MIN_THUMB;
        const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
        isProgrammaticTerminalScroll = true;
        el.scrollTop = ratio * maxScroll;
        shouldFollowTerminalOutput = isTerminalAtBottom(el);
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    };

    terminalScrollbar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        terminalScrollbar.classList.add('dragging');
        terminalScrollbar.setPointerCapture?.(e.pointerId);
        setScrollFromClientY(e.clientY);
        const onMove = (ev) => {
            ev.preventDefault();
            setScrollFromClientY(ev.clientY);
        };
        const onUp = () => {
            terminalScrollbar.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            term?.focus?.();
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
    }, { passive: false });
}

function renderStats(d) {
    const cpuUsage = safeVal(d.cpu?.usage);
    const memUsedGB = (safeVal(d.memUsed) / 1024).toFixed(1);
    const memTotalGB = (safeVal(d.memTotal) / 1024).toFixed(1);
    const swapUsedGB = (safeVal(d.swapUsed) / 1024).toFixed(1);
    const swapTotalGB = (safeVal(d.swapTotal) / 1024).toFixed(1);
    const rxMbps = safeVal(d.net?.rx).toFixed(1);
    const txMbps = safeVal(d.net?.tx).toFixed(1);
    const ipv4 = d.ip?.ipv4 || 'N/A';
    const ipv6 = d.ip?.ipv6 || 'N/A';
    const hostName = d.host?.hostname || 'N/A';
    const hostOS = d.host?.os || 'N/A';
    const diskDevices = Array.isArray(d.disk?.devices) ? d.disk.devices : [];
    const diskDeviceCards = diskDevices.map(device => `
        <div class="doughnut-item disk-card">
            <div class="disk-card-meta">
                <div class="doughnut-label">${device.mountpoint}</div>
                <div class="doughnut-text">${device.usedGB} / ${device.totalGB} GB</div>
                <div class="doughnut-sub">${device.filesystem}</div>
                <div class="doughnut-sub">已用 ${device.usageLabel}</div>
                <div class="doughnut-sub">读 ${device.readKBps} KB/s · 写 ${device.writeKBps} KB/s</div>
            </div>
            <div class="doughnut-wrap"><canvas id="${device.id}"></canvas></div>
        </div>
    `).join('');

    infoBody.innerHTML = `
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">CPU</div>
                    <div class="doughnut-text">${d.cpu?.model || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.freq || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.cores || 0} 核心</div>
                </div>
                <div class="doughnut-wrap"><canvas id="cpuDoughnut"></canvas></div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">内存</div>
                <div class="doughnut-wrap"><canvas id="ramDoughnut"></canvas></div>
                <div class="doughnut-text">${memUsedGB} / ${memTotalGB} GB</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">Swap</div>
                <div class="doughnut-wrap"><canvas id="swapDoughnut"></canvas></div>
                <div class="doughnut-text">${swapUsedGB} / ${swapTotalGB} GB</div>
            </div>
        </div>
        <div class="doughnut-row disk-card-row">
            ${diskDeviceCards}
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">下载</div>
                <div class="doughnut-text">${rxMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="rxLine" data-color="#3fb950" class="line-canvas" height="30"></canvas>
                </div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">上传</div>
                <div class="doughnut-text">${txMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="txLine" data-color="#58a6ff" class="line-canvas" height="30"></canvas>
                </div>
            </div>
        </div>
        <div class="ip-section">
            <div class="ip-box"><span>IPv4</span><code>${ipv4}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv4}')">📋</button></div>
            <div class="ip-box"><span>IPv6</span><code>${ipv6}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv6}')">📋</button></div>
        </div>
    `;

    initCharts();

    updateDoughnut('cpuDoughnut', cpuUsage);
    updateDoughnut('ramDoughnut', (safeVal(d.memUsed) / safeVal(d.memTotal)) * 100);
    updateDoughnut('swapDoughnut', safeVal(d.swapTotal) ? (safeVal(d.swapUsed) / safeVal(d.swapTotal)) * 100 : 0);
    diskDevices.forEach(device => updateDoughnut(device.id, device.percent));

    updateLine('rxLine', rxMbps);
    updateLine('txLine', txMbps);
}

function showInfoModal() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        alert('请先连接 SSH');
        return;
    }
    ensureFloatingPanel(infoModal, getDefaultPanelOptions(infoModal));
    infoModal.style.display = 'flex';
    // display 从 none 切换为 flex 后，下一帧再加 open，确保浏览器能播放开启动画。
    requestAnimationFrame(() => {
        infoModal.classList.add('open');
        infoBtn.classList.add('active');
    });
}

function patchWTermScrollBehavior() {
    if (!term || term._zephyrScrollPatched) return;
    // wterm 0.1.x 的私有 _scrollToBottom 会按行高向下取整，某些尺寸下会离底部差半行，
    // 下一次 write 前 _isScrolledToBottom() 判断失败，自动滚动就会断掉。这里改成精确贴底。
    if (typeof term._scrollToBottom === 'function') {
        term._scrollToBottom = () => scrollTerminalToBottom();
    }
    if (typeof term._isScrolledToBottom === 'function') {
        term._isScrolledToBottom = () => isTerminalAtBottom(getTerminalScrollElement(), TERMINAL_BOTTOM_THRESHOLD);
    }
    term._zephyrScrollPatched = true;
}

function writeTerminalData(data = '') {
    if (!term?.write) return;
    const wasAtBottom = isTerminalAtBottom();
    if (isLikelyTerminalInputEcho(data)) shouldFollowTerminalOutput = true;
    else shouldFollowTerminalOutput = shouldFollowTerminalOutput || wasAtBottom;
    term.write(data);
    if (shouldFollowTerminalOutput) scheduleTerminalScrollToBottom();
    else scheduleTerminalScrollbarUpdate();
}

function hideInfoModal() {
    infoModal.classList.remove('open');
    infoBtn.classList.remove('active');
    window.setTimeout(() => {
        if (!infoModal.classList.contains('open')) {
            infoModal.style.display = 'none';
        }
    }, 280);
}

function toggleInfoModal() {
    if (infoModal.classList.contains('open')) hideInfoModal();
    else showInfoModal();
}

infoBtn.addEventListener('click', toggleInfoModal);

infoCloseBtn.addEventListener('click', hideInfoModal);

// ---------- 浮动面板拖动 / 缩放 ----------
const panelState = new WeakMap();

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panelState.has(panel)) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const width = defaults.width || Math.min(parentRect.width * 0.72, 760);
    const height = defaults.height || Math.min(parentRect.height * 0.72, 560);
    const left = defaults.left ?? Math.max(12, (parentRect.width - width) / 2);
    const top = defaults.top ?? 52;

    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    panelState.set(panel, { left, top, width, height });
}

function isCompactScreen() {
    return window.matchMedia('(max-width: 700px), (pointer: coarse)').matches;
}

function getDefaultPanelOptions(panel) {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(300, parentRect.height - 58),
        };
    }
    if (panel === fileManager) {
        return { width: Math.min(parentRect.width * 0.72, 820), height: Math.min(parentRect.height * 0.68, 620), left: 16, top: 52 };
    }
    return { width: Math.min(480, parentRect.width - 24), height: Math.min(parentRect.height * 0.72, 620), top: 52 };
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;

    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }

    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => {
        panel.classList.remove('layout-animating');
        clampPanel(panel);
    }, 480);
}

let panelLayoutMenu = null;
function closePanelLayoutMenu() {
    panelLayoutMenu?.remove();
    panelLayoutMenu = null;
}

function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu();
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '窗口布局');
    menu.innerHTML = `
        <button data-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="半屏" aria-label="半屏"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="左侧四分之一" aria-label="左侧四分之一"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="右侧四分之一" aria-label="右侧四分之一"><span class="panel-layout-icon right"></span></button>
    `;
    document.body.appendChild(menu);
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - menuRect.width / 2), window.innerWidth - menuRect.width - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - menuRect.height - 8)}px`;
    menu.style.setProperty('--menu-origin-x', `${rect.left + rect.width / 2 - left}px`);
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-layout]');
        if (!item) return;
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
    panelLayoutMenu = menu;
}

function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const panel = document.getElementById(button.dataset.layoutPanel);
        if (!panel) return;
        button.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closePanelLayoutMenu();
            bringPanelToFront(panel);
            button.classList.add('pressing');
            panel.classList.add('dragging');
            button.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;

            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.setTimeout(() => button.classList.remove('pressing'), moved ? 0 : 140);
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            bringPanelToFront(panel);
            if (panelLayoutMenu) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (e) => {
        if (panelLayoutMenu && !e.target.closest('.panel-layout-menu') && !e.target.closest('[data-layout-panel]')) {
            closePanelLayoutMenu();
        }
    });
    window.addEventListener('resize', closePanelLayoutMenu);
}

function bringPanelToFront(panel) {
    if (!panel) return;
    const wasFront = panel.classList.contains('front');
    document.querySelectorAll('.file-manager, .info-modal').forEach((p) => {
        p.classList.remove('front');
        if (p !== panel) p.classList.remove('front-switching');
    });
    panel.classList.add('front');
    if (!wasFront) {
        panel.classList.remove('front-switching');
        // 重新触发布局动画：模拟 iPadOS 窗口切到前台时的轻微弹性抬起感。
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => {
            panel.classList.remove('front-switching');
        }, 360);
    }
}

function setupFloatingPanel(panel, options) {
    ensureFloatingPanel(panel, options);
    panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
}

function setupPanelDrag() {
    document.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.dragPanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button,input,select,textarea,label')) return;
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;

            const onMove = (ev) => {
                ev.preventDefault();
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const compact = isCompactScreen();
            const minWidth = compact ? 260 : (Number(getComputedStyle(panel).minWidth.replace('px', '')) || 420);
            const minHeight = compact ? 240 : (Number(getComputedStyle(panel).minHeight.replace('px', '')) || 320);

            const onMove = (ev) => {
                ev.preventDefault();
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 8) {
                        nextWidth += nextLeft - 8;
                        nextLeft = 8;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                const width = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                const height = Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight);
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

setupFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
setupFloatingPanel(infoModal, getDefaultPanelOptions(infoModal));
setupPanelLayoutMenu();
setupPanelDrag();
setupPanelResize();
setupTerminalInputActivityHooks();
window.addEventListener('resize', () => {
    [fileManager, infoModal].forEach((panel) => panel && clampPanel(panel));
});

// ---------- 辅助键 / 终端输入 ----------
const modifierState = { ctrl: false, alt: false, shift: false };
const modifierButtons = document.querySelectorAll('.modifier');
function updateModifierUI() {
    modifierButtons.forEach(btn => btn.classList.toggle('active', modifierState[btn.dataset.key]));
}
function processModifiers(data) {
    if (!modifierState.ctrl && !modifierState.alt && !modifierState.shift) return data;
    let result = '';
    for (const ch of data) {
        const code = ch.charCodeAt(0);
        let transformed = ch;
        if (modifierState.ctrl) {
            if (code >= 65 && code <= 90) transformed = String.fromCharCode(code - 64);
            else if (code >= 97 && code <= 122) transformed = String.fromCharCode(code - 96);
        }
        if (modifierState.alt) transformed = '\x1b' + transformed;
        result += transformed;
    }
    return result;
}
function sendData(data) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        markTerminalUserInput(data);
        wsConnection.send(JSON.stringify({ type: 'input', data: processModifiers(data) }));
    }
}
function sendCommand() {
    const text = cmdInput.value;
    if (text && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        sendData(text + '\r\n');
    }
    cmdInput.value = '';
}
cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCommand(); } });
cmdSendBtn.addEventListener('click', sendCommand);

document.querySelectorAll('.func, .arrow, .combo, .modifier').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (btn.classList.contains('modifier')) { modifierState[key] = !modifierState[key]; updateModifierUI(); return; }
        if (keySequences[key]) sendData(keySequences[key]);
        if (comboSequences[key]) sendData(comboSequences[key]);
    });
});

const keySequences = {
    esc: '\x1b', tab: '\t', home: '\x1b[1~', end: '\x1b[4~',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
};
const comboSequences = { 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', 'ctrl-u': '\x15' };

// 保留选区
wtermWrapper.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) term?.focus?.();
});

// ---------- 状态指示 ----------
function setStatus(state, msg) {
    statusDot.className = 'status-dot';
    if (state === 'connecting') {
        statusText.textContent = msg || '连接中...';
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '正在建立 SSH 连接...';
    } else if (state === 'connected') {
        statusDot.classList.add('connected');
        statusText.textContent = msg || '已连接';
        terminalOverlay.classList.add('hidden');
        isConnected = true;
    } else if (state === 'disconnected') {
        statusDot.classList.add('disconnected');
        statusText.textContent = msg || '已断开';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接已断开';
    } else if (state === 'error') {
        statusDot.classList.add('disconnected');
        statusText.textContent = '错误';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接出错';
    }
}
connInfo.textContent = `${params.username}@${params.host}:${params.port}`;

// ---------- WTerm 初始化 ----------
async function initWTerm() {
    let WTermClass;
    try {
        const module = await import('/vendor/@wterm/dom/dist/index.js');
        WTermClass = module.WTerm;
    } catch {
        const module = await import('/vendor/@wterm/dom/dist/wterm.js');
        WTermClass = module.WTerm || module.default;
    }
    wtermWrapper.innerHTML = '';
    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80, rows: 24, autoResize: true, cursorBlink: true,
            onData: (data) => sendData(data),
            onResize: (cols, rows) => sendTerminalResize(cols, rows),
        });
    } catch {
        term = new WTermClass(wtermWrapper);
        if (typeof term.onData === 'function') term.onData(data => sendData(data));
        else if (typeof term.on === 'function') term.on('data', data => sendData(data));
    }
    if (typeof term.init === 'function') await term.init();
    applyTerminalFontSize(terminalFontSize, { persist: false });
    patchWTermScrollBehavior();

    const observeResize = () => sendTerminalResize();
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => { clearTimeout(ro._timer); ro._timer = setTimeout(observeResize, 150); });
        ro.observe(wtermWrapper);
    }
    window.addEventListener('resize', observeResize);
    setupTerminalScrollHooks();
}

// ---------- WebSocket 连接 ----------
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ssh`);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时')); }, 10000);

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({
                type: 'connect',
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password || '',
                privateKey: params.privateKey || '',
                init: params.init || ''
            }));
        });

        ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats') { renderStats(msg.data); return; }
                if (msg.type?.startsWith('sftp-')) { handleSFTPMessage(msg); return; }
                switch (msg.type) {
                    case 'ready':
                        setStatus('connected', '已连接');
                        if (term?.focus) term.focus();
                        reconnectAttempts = 0;
                        shouldFollowTerminalOutput = true;
                        scheduleTerminalScrollToBottom();
                        resolve(ws);
                        break;
                    case 'data':
                        writeTerminalData(msg.data);
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        reject(new Error(msg.message));
                        break;
                    case 'close':
                        setStatus('disconnected', msg.message || '会话已关闭');
                        break;
                    case 'banner':
                        writeTerminalData(msg.data);
                        break;
                }
            } catch (_) {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            wsConnection = null;
            if (isConnected) setStatus('disconnected', `断开 (${e.code})`);
            if (term) { try { term.destroy?.(); } catch (_) {} term = null; }
        });

        wsConnection = ws;
    });
}

function disconnect() {
    if (wsConnection) {
        try { wsConnection.send(JSON.stringify({ type: 'disconnect' })); } catch (_) {}
        wsConnection.close(1000, '用户主动断开');
        wsConnection = null;
    }
    stopTerminalAutoScrollObserver();
    if (term) { try { term.destroy?.(); } catch (_) {} term = null; }
    setStatus('disconnected', '已断开');
    isConnected = false;
}

async function reconnect() {
    disconnect();
    wtermWrapper.innerHTML = '';
    reconnectAttempts = 0;
    setStatus('connecting', '正在重连...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message);
    }
}

async function main() {
    setStatus('connecting', '正在初始化终端...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message);
        if (reconnectAttempts++ < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => { if (!isConnected) main(); }, 2000);
        }
    }
}

reconnectBtn.addEventListener('click', reconnect);
disconnectBtn.addEventListener('click', () => {
    disconnect();
    sessionStorage.removeItem('zephyr_ssh_params');
    window.location.href = '/';
});
window.addEventListener('beforeunload', disconnect);

main();