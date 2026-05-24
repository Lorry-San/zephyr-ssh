import {basicSetup, EditorView} from 'codemirror';
import {EditorState, Compartment, StateEffect, StateField} from '@codemirror/state';
import {keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, toggleComment, moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, selectLine, selectParentSyntax, insertBlankLine, deleteTrailingWhitespace} from '@codemirror/commands';
import {searchKeymap, highlightSelectionMatches, openSearchPanel, findNext, findPrevious, selectNextOccurrence, gotoLine} from '@codemirror/search';
import {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion} from '@codemirror/autocomplete';
import {bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, StreamLanguage, foldAll, unfoldAll} from '@codemirror/language';
import {lintGutter} from '@codemirror/lint';
import {yaml} from '@codemirror/lang-yaml';
import {json} from '@codemirror/lang-json';
import {javascript} from '@codemirror/lang-javascript';
import {html} from '@codemirror/lang-html';
import {css} from '@codemirror/lang-css';
import {markdown} from '@codemirror/lang-markdown';
import {python} from '@codemirror/lang-python';
import {sql} from '@codemirror/lang-sql';
import {php} from '@codemirror/lang-php';
import {rust} from '@codemirror/lang-rust';
import {java} from '@codemirror/lang-java';
import {cpp} from '@codemirror/lang-cpp';
import {xml} from '@codemirror/lang-xml';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {toml} from '@codemirror/legacy-modes/mode/toml';
import {dockerFile} from '@codemirror/legacy-modes/mode/dockerfile';
import {oneDark} from '@codemirror/theme-one-dark';
import {githubLight, githubDark} from '@uiw/codemirror-theme-github';
import {showMinimap} from '@replit/codemirror-minimap';
import {LSPClient, languageServerExtensions} from '@codemirror/lsp-client';
import {MergeView} from '@codemirror/merge';
import {format as prettierFormat} from 'prettier/standalone';
import * as prettierYaml from 'prettier/plugins/yaml';
import * as prettierBabel from 'prettier/plugins/babel';
import * as prettierEstree from 'prettier/plugins/estree';

const LARGE_FILE_LIMIT = 5 * 1024 * 1024;
const MEDIUM_FILE_LIMIT = 1024 * 1024;
const SAVE_DEBOUNCE_MS = 800; // 可由调用方开启 autoSave，SFTP 远程编辑默认关闭，避免误写远端文件。
const LSP_LANGUAGES = new Set(['yaml', 'json']);
const MOBILE_QUERY = '(max-width: 720px), (pointer: coarse)';

const languageConfig = new Compartment();
const tabConfig = new Compartment();
const wrapConfig = new Compartment();
const editableConfig = new Compartment();
const lspConfig = new Compartment();
const themeConfig = new Compartment();
const minimapConfig = new Compartment();
const compactConfig = new Compartment();

let yamlLspClient = null;
let jsonLspClient = null;
let lspConnecting = false;

const languageLabels = {
  plain: 'Plain Text', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', html: 'HTML/XML', css: 'CSS',
  python: 'Python', shell: 'Shell', yaml: 'YAML', markdown: 'Markdown', sql: 'SQL', php: 'PHP', rust: 'Rust', java: 'Java',
  cpp: 'C++', c: 'C', xml: 'XML', dockerfile: 'Dockerfile', toml: 'TOML', go: 'Go', makefile: 'Makefile', ini: 'INI'
};

const schemaHints = {
  'compose.y': 'Docker Compose Schema',
  'docker-compose.y': 'Docker Compose Schema',
  '.github/workflows/': 'GitHub Actions Schema',
  'kubernetes': 'Kubernetes Schema',
  'k8s': 'Kubernetes Schema',
  'mihomo': 'Mihomo/Clash Schema',
  'clash': 'Mihomo/Clash Schema',
};

function extensionFor(language) {
  switch (language) {
    case 'yaml': return yaml();
    case 'json': return json();
    case 'javascript': return javascript({jsx: true});
    case 'typescript': return javascript({typescript: true, jsx: true});
    case 'html': return html();
    case 'xml': return xml();
    case 'css': return css();
    case 'markdown': return markdown();
    case 'python': return python();
    case 'sql': return sql();
    case 'php': return php();
    case 'rust': return rust();
    case 'java': return java();
    case 'cpp': case 'c': return cpp();
    case 'shell': return StreamLanguage.define(shell);
    case 'toml': return StreamLanguage.define(toml);
    case 'dockerfile': return StreamLanguage.define(dockerFile);
    default: return [];
  }
}

function fileUri(path) {
  const safe = String(path || 'untitled').split('/').map(encodeURIComponent).join('/');
  return `file://${safe.startsWith('/') ? '' : '/'}${safe}`;
}

function languageId(language) {
  if (language === 'shell') return 'shellscript';
  if (language === 'dockerfile') return 'dockerfile';
  if (language === 'typescript') return 'typescript';
  if (language === 'javascript') return 'javascript';
  return language || 'plaintext';
}

function simpleWebSocketTransport(url) {
  let socket;
  let handlers = [];
  return new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('LSP 连接超时')), 5000);
    socket.onmessage = (event) => handlers.forEach((handler) => handler(String(event.data || '')));
    socket.onerror = () => reject(new Error('LSP WebSocket 连接失败'));
    socket.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(message) { if (socket.readyState === WebSocket.OPEN) socket.send(message); },
        subscribe(handler) { handlers.push(handler); },
        unsubscribe(handler) { handlers = handlers.filter((item) => item !== handler); }
      });
    };
  });
}

async function ensureLspClient(kind) {
  if (kind === 'yaml' && yamlLspClient?.connected) return yamlLspClient;
  if (kind === 'json' && jsonLspClient?.connected) return jsonLspClient;
  if (lspConnecting) return null;
  lspConnecting = true;
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const transport = await simpleWebSocketTransport(`${protocol}//${location.host}/editor-lsp?language=${encodeURIComponent(kind)}`);
    const client = new LSPClient({
      rootUri: 'file:///',
      timeout: 5000,
      sanitizeHTML: (html) => String(html || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ''),
      extensions: languageServerExtensions()
    }).connect(transport);
    if (kind === 'yaml') yamlLspClient = client;
    else jsonLspClient = client;
    return client;
  } catch (error) {
    console.warn('[editor-lsp]', error);
    return null;
  } finally {
    lspConnecting = false;
  }
}

function lspExtensionFor(instance) {
  if (!instance || !LSP_LANGUAGES.has(instance.language) || instance.largeFile) return [];
  const client = instance.language === 'yaml' ? yamlLspClient : jsonLspClient;
  if (!client?.connected) return [];
  return client.plugin(fileUri(instance.path), languageId(instance.language));
}

function isLightTheme() {
  return document.documentElement.dataset.theme === 'light';
}

function editorThemeExtension(instance) {
  const extensions = [isLightTheme() ? githubLight : githubDark, zephyrEditorTheme];
  if (instance.themeName === 'onedark') extensions.unshift(oneDark);
  return extensions;
}

const zephyrEditorTheme = EditorView.theme({
  '&': {height: '100%', fontSize: 'var(--cm-editor-font-size, 13px)', backgroundColor: 'var(--cm-editor-bg)', color: 'var(--cm-editor-fg)'},
  '.cm-scroller': {fontFamily: 'var(--font-mono)', lineHeight: '1.48', overscrollBehavior: 'contain'},
  '.cm-content': {caretColor: 'var(--accent)', padding: '8px 0', minHeight: '100%'},
  '.cm-line': {padding: '0 10px'},
  '.cm-activeLine': {backgroundColor: 'var(--cm-active-line)'},
  '.cm-activeLineGutter': {backgroundColor: 'var(--cm-active-gutter)'},
  '.cm-gutters': {backgroundColor: 'var(--cm-gutter-bg)', color: 'var(--cm-gutter-fg)', borderRight: '1px solid var(--cm-gutter-border)'},
  '.cm-foldGutter .cm-gutterElement': {cursor: 'pointer'},
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {backgroundColor: 'var(--cm-selection) !important'},
  '.cm-cursor': {borderLeftColor: 'var(--accent)'},
  '.cm-panels': {background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)'},
  '.cm-search label': {color: 'var(--text-secondary)'},
  '.cm-panel input': {background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '5px 8px'},
  '.cm-panel button': {background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '5px 8px'},
  '.cm-tooltip': {zIndex: 9999, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: '0 16px 48px rgba(0,0,0,.28)'},
  '.cm-tooltip-autocomplete ul li[aria-selected]': {background: 'var(--accent)', color: '#fff'},
  '.cm-diagnosticText': {fontFamily: 'var(--font-mono)'},
  '.cm-minimap': {borderLeft: '1px solid var(--border)', background: 'var(--cm-minimap-bg)'},
  '.cm-minimap-overlay': {background: 'var(--cm-minimap-overlay)', outline: '1px solid var(--accent)'},
});

function compactExtension(instance) {
  return EditorView.theme({
    '&': {fontSize: instance.compact ? '12px' : '13px'},
    '.cm-content': {padding: instance.compact ? '5px 0' : '8px 0'},
    '.cm-line': {padding: instance.compact ? '0 7px' : '0 10px'},
    '.cm-scroller': {lineHeight: instance.compact ? '1.36' : '1.48'},
  });
}

function createMinimapExtension(instance) {
  if (instance.largeFile || !instance.minimap || instance.compact) return [];
  const create = () => {
    const dom = document.createElement('div');
    dom.className = 'zephyr-cm-minimap';
    return {dom};
  };
  return showMinimap.compute(['doc'], () => ({create, displayText: 'blocks', showOverlay: 'always'}));
}

function statusParts(instance) {
  const text = instance.view?.state.doc.toString() || '';
  const bytes = new TextEncoder().encode(text).length;
  const lineCount = instance.view?.state.doc.lines || 1;
  const label = languageLabels[instance.language] || languageLabels.plain;
  const dirty = instance.dirty ? '● 未保存' : '已保存';
  const perf = instance.largeFile ? '大文件降级' : instance.mediumFile ? '性能模式' : instance.compact ? '紧凑' : 'IDE';
  const lsp = LSP_LANGUAGES.has(instance.language) && !instance.largeFile ? 'LSP' : '';
  const schema = schemaHint(instance.path);
  return [dirty, `${lineCount} 行`, `${text.length} 字符`, `${bytes} bytes`, label, perf, lsp, schema].filter(Boolean);
}

function schemaHint(path = '') {
  const lower = String(path).toLowerCase();
  for (const [needle, label] of Object.entries(schemaHints)) if (lower.includes(needle)) return label;
  return '';
}

function updateStatus(instance) {
  if (!instance?.statusEl) return;
  instance.statusEl.textContent = statusParts(instance).join(' · ');
  if (instance.titleEl) {
    const name = instance.path || '未命名文件';
    instance.titleEl.textContent = `${instance.dirty ? '● ' : ''}编辑: ${name}`;
  }
}

const addSnippetEffect = StateEffect.define();
const snippetMark = Decoration.mark({class: 'cm-snippet-placeholder'});
const snippetField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addSnippetEffect)) value = value.update({add: [snippetMark.range(effect.value.from, effect.value.to)]});
    }
    if (tr.selection || tr.docChanged) {
      const pos = tr.state.selection.main.head;
      value = value.update({filter: (from, to) => pos >= from && pos <= to});
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildExtensions(instance) {
  const extensions = [
    basicSetup,
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    lintGutter(),
    snippetField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        instance.dirty = instance.view ? update.state.doc.toString() !== instance.originalText : true;
        scheduleAutoSave(instance);
      }
      if (update.docChanged || update.selectionSet) updateStatus(instance);
    }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
      {key: 'Mod-s', run: () => { instance.requestSave?.(); return true; }},
      {key: 'Mod-Shift-f', run: () => { formatDocument(instance); return true; }},
      {key: 'Mod-/', run: toggleComment},
      {key: 'Alt-ArrowUp', run: moveLineUp},
      {key: 'Alt-ArrowDown', run: moveLineDown},
      {key: 'Shift-Alt-ArrowUp', run: copyLineUp},
      {key: 'Shift-Alt-ArrowDown', run: copyLineDown},
      {key: 'Mod-Shift-k', run: deleteLine},
      {key: 'Mod-l', run: selectLine},
      {key: 'Mod-Shift-o', run: selectParentSyntax},
      {key: 'Mod-Enter', run: insertBlankLine},
      {key: 'Mod-Shift-l', run: selectNextOccurrence},
      {key: 'F1', run: () => openCommandPalette(instance)},
      {key: 'Mod-p', run: () => openCommandPalette(instance)},
      {key: 'Mod-g', run: gotoLine},
      {key: 'Escape', run: () => { closeCommandPalette(instance); instance.view?.contentDOM.blur(); return false; }}
    ]),
    languageConfig.of(extensionFor(instance.language)),
    tabConfig.of(EditorState.tabSize.of(instance.tabSize || 4)),
    wrapConfig.of(instance.wrap ? EditorView.lineWrapping : []),
    editableConfig.of(EditorView.editable.of(true)),
    lspConfig.of(lspExtensionFor(instance)),
    themeConfig.of(editorThemeExtension(instance)),
    minimapConfig.of(createMinimapExtension(instance)),
    compactConfig.of(compactExtension(instance)),
  ];
  if (!instance.largeFile) extensions.push(autocompletion({activateOnTyping: true, maxRenderedOptions: 80}));
  return extensions;
}

function scheduleAutoSave(instance) {
  clearTimeout(instance.saveTimer);
  if (!instance.dirty || !instance.autoSave) return;
  instance.saveTimer = setTimeout(() => instance.requestSave?.({silent: true}), SAVE_DEBOUNCE_MS);
}

async function formatDocument(instance) {
  if (!instance?.view || instance.largeFile) return false;
  const language = instance.language;
  const text = instance.view.state.doc.toString();
  let parser = '';
  let plugins = [];
  if (language === 'yaml') { parser = 'yaml'; plugins = [prettierYaml]; }
  else if (language === 'json') { parser = 'json'; plugins = [prettierBabel, prettierEstree]; }
  else if (language === 'javascript') { parser = 'babel'; plugins = [prettierBabel, prettierEstree]; }
  else return false;
  try {
    const formatted = await prettierFormat(text, {parser, plugins, tabWidth: instance.tabSize || 2, printWidth: 100});
    if (formatted !== text) instance.view.dispatch({changes: {from: 0, to: instance.view.state.doc.length, insert: formatted}});
    return true;
  } catch (error) {
    instance.notify?.(`格式化失败: ${error.message || error}`, 'error');
    return false;
  }
}

function insertSnippet(instance, text) {
  const view = instance?.view;
  if (!view) return;
  view.focus();
  const from = view.state.selection.main.from;
  view.dispatch(view.state.replaceSelection(text));
  const cursor = from + text.length;
  const pair = text.length === 2 && '{}[]()<>'.includes(text[0]) && '{}[]()<>'.includes(text[1]);
  if (pair) view.dispatch({selection: {anchor: from + 1}, effects: addSnippetEffect.of({from: from + 1, to: from + 1})});
  else view.dispatch({selection: {anchor: cursor}});
}

function commandList(instance) {
  return [
    ['查找', openSearchPanel], ['查找下一个', findNext], ['查找上一个', findPrevious], ['跳转到行', gotoLine],
    ['格式化文档', () => formatDocument(instance)], ['删除尾随空格', deleteTrailingWhitespace], ['触发补全', startCompletion],
    ['折叠全部', foldAll], ['展开全部', unfoldAll], ['切换注释', toggleComment], ['上移行', moveLineUp], ['下移行', moveLineDown],
    ['向上复制行', copyLineUp], ['向下复制行', copyLineDown], ['删除行', deleteLine], ['选择当前行', selectLine],
    ['切换概览', () => { toggleMinimap(instance); return true; }], ['切换紧凑模式', () => { toggleCompact(instance); return true; }],
  ];
}

function openCommandPalette(instance) {
  if (!instance?.panel) return false;
  let palette = instance.panel.querySelector('[data-editor-role="commandPalette"]');
  if (!palette) {
    palette = document.createElement('div');
    palette.className = 'cm-command-palette';
    palette.dataset.editorRole = 'commandPalette';
    palette.innerHTML = '<input placeholder="输入命令 / Command Palette"><div class="cm-command-list"></div>';
    instance.panel.appendChild(palette);
  }
  const input = palette.querySelector('input');
  const list = palette.querySelector('.cm-command-list');
  const render = () => {
    const query = input.value.trim().toLowerCase();
    list.innerHTML = '';
    commandList(instance).filter(([name]) => !query || name.toLowerCase().includes(query)).slice(0, 12).forEach(([name, run]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => { run(instance.view); closeCommandPalette(instance); instance.view.focus(); });
      list.appendChild(button);
    });
  };
  input.oninput = render;
  input.onkeydown = (event) => {
    if (event.key === 'Escape') { closeCommandPalette(instance); instance.view.focus(); }
    if (event.key === 'Enter') list.querySelector('button')?.click();
  };
  palette.classList.add('open');
  input.value = '';
  render();
  setTimeout(() => input.focus(), 0);
  return true;
}

function closeCommandPalette(instance) {
  instance?.panel?.querySelector('[data-editor-role="commandPalette"]')?.classList.remove('open');
}

function createMobileToolbar(instance, parent) {
  let toolbar = parent.querySelector('[data-editor-role="mobileToolbar"]');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'cm-mobile-toolbar';
    toolbar.dataset.editorRole = 'mobileToolbar';
    parent.appendChild(toolbar);
  }
  toolbar.innerHTML = '';
  const items = [
    ['TAB', () => insertSnippet(instance, ' '.repeat(instance.tabSize || 4))], ['{}', () => insertSnippet(instance, '{}')],
    ['[]', () => insertSnippet(instance, '[]')], ['()', () => insertSnippet(instance, '()')], ['<>', () => insertSnippet(instance, '<>')],
    [':', () => insertSnippet(instance, ':')], [';', () => insertSnippet(instance, ';')], ['$', () => insertSnippet(instance, '$')],
    ['/', () => insertSnippet(instance, '/')], ['⌘', () => openCommandPalette(instance)], ['ESC', () => instance.view?.contentDOM.blur()],
  ];
  items.forEach(([label, run]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', run);
    toolbar.appendChild(button);
  });
  return toolbar;
}

function installViewportAdapter(instance) {
  const panel = instance.panel;
  const apply = () => {
    const vv = window.visualViewport;
    if (!vv || !panel?.classList.contains('fullscreen')) return;
    panel.style.setProperty('--editor-visual-height', `${Math.max(280, vv.height)}px`);
    panel.style.setProperty('--editor-visual-top', `${vv.offsetTop || 0}px`);
  };
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  apply();
  instance.viewportCleanup = () => {
    window.visualViewport?.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('scroll', apply);
  };
}

function installThemeObserver(instance) {
  const observer = new MutationObserver(() => {
    if (!instance.view || instance.destroyed) return;
    instance.view.dispatch({effects: themeConfig.reconfigure(editorThemeExtension(instance))});
  });
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  instance.themeObserver = observer;
}

function setPanelFlags(instance) {
  instance.panel?.classList.toggle('cm-editor-compact', !!instance.compact);
  instance.panel?.classList.toggle('cm-editor-minimap-on', !!instance.minimap && !instance.compact && !instance.largeFile);
}

export function createZephyrEditor(options) {
  const instance = {
    path: options.path || '',
    language: options.language || 'plain',
    originalText: options.text || '',
    dirty: false,
    largeFile: (options.size || 0) > LARGE_FILE_LIMIT,
    mediumFile: (options.size || 0) > MEDIUM_FILE_LIMIT,
    tabSize: Number(options.tabSize || 4),
    wrap: options.wrap !== false,
    autoSave: options.autoSave === true,
    minimap: options.minimap === true,
    compact: options.compact === true || matchMedia(MOBILE_QUERY).matches,
    themeName: options.themeName || 'auto',
    panel: options.panel,
    titleEl: options.titleEl,
    statusEl: options.statusEl,
    notify: options.notify,
    requestSave: options.onSave,
  };
  if (instance.largeFile) instance.minimap = false;
  const parent = options.parent;
  parent.innerHTML = '';
  const view = new EditorView({
    state: EditorState.create({doc: instance.originalText, extensions: buildExtensions(instance)}),
    parent
  });
  instance.view = view;
  createMobileToolbar(instance, options.panel || parent);
  installViewportAdapter(instance);
  installThemeObserver(instance);
  setPanelFlags(instance);
  updateStatus(instance);
  if (LSP_LANGUAGES.has(instance.language) && !instance.largeFile) {
    ensureLspClient(instance.language).then((client) => {
      if (!client || instance.destroyed) return;
      view.dispatch({effects: lspConfig.reconfigure(lspExtensionFor(instance))});
      updateStatus(instance);
    });
  }
  return instance;
}

export function updateZephyrEditorOptions(instance, options = {}) {
  if (!instance?.view) return;
  if (options.language && options.language !== instance.language) {
    instance.language = options.language;
    instance.view.dispatch({effects: languageConfig.reconfigure(extensionFor(instance.language))});
  }
  if (options.tabSize) {
    instance.tabSize = Number(options.tabSize) || 4;
    instance.view.dispatch({effects: tabConfig.reconfigure(EditorState.tabSize.of(instance.tabSize))});
  }
  if (typeof options.wrap === 'boolean') {
    instance.wrap = options.wrap;
    instance.view.dispatch({effects: wrapConfig.reconfigure(instance.wrap ? EditorView.lineWrapping : [])});
  }
  if (typeof options.minimap === 'boolean') {
    instance.minimap = options.minimap && !instance.largeFile;
    instance.view.dispatch({effects: minimapConfig.reconfigure(createMinimapExtension(instance))});
    setPanelFlags(instance);
  }
  if (typeof options.compact === 'boolean') {
    instance.compact = options.compact;
    instance.view.dispatch({effects: [compactConfig.reconfigure(compactExtension(instance)), minimapConfig.reconfigure(createMinimapExtension(instance))]});
    setPanelFlags(instance);
  }
  updateStatus(instance);
}

export function getZephyrEditorText(instance) {
  return instance?.view?.state.doc.toString() || '';
}

export function setZephyrEditorText(instance, text) {
  if (!instance?.view) return;
  instance.originalText = String(text || '');
  instance.dirty = false;
  instance.view.dispatch({changes: {from: 0, to: instance.view.state.doc.length, insert: instance.originalText}});
  updateStatus(instance);
}

export function destroyZephyrEditor(instance) {
  if (!instance || instance.destroyed) return;
  instance.destroyed = true;
  clearTimeout(instance.saveTimer);
  instance.themeObserver?.disconnect();
  instance.viewportCleanup?.();
  closeCommandPalette(instance);
  instance.view?.destroy();
}

export function undoZephyrEditor(instance) { undo(instance?.view); updateStatus(instance); }
export function redoZephyrEditor(instance) { redo(instance?.view); updateStatus(instance); }
export function formatZephyrEditor(instance) { return formatDocument(instance); }
export function focusZephyrEditor(instance) { instance?.view?.focus(); }
export function isZephyrEditorDirty(instance) { return !!instance?.dirty; }
export function toggleMinimap(instance) { updateZephyrEditorOptions(instance, {minimap: !instance?.minimap}); return true; }
export function toggleCompact(instance) { updateZephyrEditorOptions(instance, {compact: !instance?.compact}); return true; }
export function openPalette(instance) { return openCommandPalette(instance); }

window.ZephyrCodeEditor = {
  create: createZephyrEditor,
  updateOptions: updateZephyrEditorOptions,
  getText: getZephyrEditorText,
  setText: setZephyrEditorText,
  destroy: destroyZephyrEditor,
  undo: undoZephyrEditor,
  redo: redoZephyrEditor,
  format: formatZephyrEditor,
  focus: focusZephyrEditor,
  dirty: isZephyrEditorDirty,
  toggleMinimap,
  toggleCompact,
  openPalette,
  MergeView
};
