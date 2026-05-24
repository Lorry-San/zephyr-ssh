import {basicSetup, EditorView} from 'codemirror';
import {EditorState, Compartment, Prec} from '@codemirror/state';
import {keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab, undo, redo} from '@codemirror/commands';
import {searchKeymap, highlightSelectionMatches} from '@codemirror/search';
import {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap} from '@codemirror/autocomplete';
import {bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, StreamLanguage} from '@codemirror/language';
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

const languageConfig = new Compartment();
const tabConfig = new Compartment();
const wrapConfig = new Compartment();
const editableConfig = new Compartment();
const lspConfig = new Compartment();

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

function statusParts(instance) {
  const text = instance.view?.state.doc.toString() || '';
  const bytes = new TextEncoder().encode(text).length;
  const lineCount = instance.view?.state.doc.lines || 1;
  const label = languageLabels[instance.language] || languageLabels.plain;
  const dirty = instance.dirty ? '● 未保存' : '已保存';
  const perf = instance.largeFile ? '大文件降级' : instance.mediumFile ? '性能模式' : 'IDE';
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
    oneDark,
    EditorView.lineWrapping,
    lintGutter(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        instance.dirty = instance.view ? update.state.doc.toString() !== instance.originalText : true;
        scheduleAutoSave(instance);
      }
      if (update.docChanged || update.selectionSet) updateStatus(instance);
    }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    Prec.highest(keymap.of([
      {key: 'Mod-s', run: () => { instance.requestSave?.(); return true; }},
      {key: 'Mod-Shift-f', run: () => { formatDocument(instance); return true; }},
      {key: 'Escape', run: () => { instance.view?.contentDOM.blur(); return false; }}
    ])),
    EditorView.theme({
      '&': {height: '100%', fontSize: '13px'},
      '.cm-scroller': {fontFamily: 'var(--font-mono)'},
      '.cm-content': {caretColor: 'var(--accent)'},
      '.cm-activeLine': {backgroundColor: 'rgba(255,255,255,0.055)'},
      '.cm-gutters': {backgroundColor: 'rgba(0,0,0,0.16)', borderRight: '1px solid var(--border)'},
      '.cm-tooltip': {zIndex: 9999},
      '.cm-diagnosticText': {fontFamily: 'var(--font-mono)'}
    }),
    languageConfig.of(extensionFor(instance.language)),
    tabConfig.of(EditorState.tabSize.of(instance.tabSize || 4)),
    wrapConfig.of(instance.wrap ? EditorView.lineWrapping : []),
    editableConfig.of(EditorView.editable.of(true)),
    lspConfig.of(lspExtensionFor(instance))
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
  view.dispatch(view.state.replaceSelection(text));
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
  ['TAB', '{}', '[]', '()', '<>', ':', ';', '$', '/', 'ESC'].forEach((label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (label === 'TAB') insertSnippet(instance, ' '.repeat(instance.tabSize || 4));
      else if (label === 'ESC') instance.view?.contentDOM.blur();
      else if (label.length === 2 && label !== '$/' ) insertSnippet(instance, label[0] + label[1]);
      else insertSnippet(instance, label);
    });
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
    panel: options.panel,
    titleEl: options.titleEl,
    statusEl: options.statusEl,
    notify: options.notify,
    requestSave: options.onSave,
  };
  const parent = options.parent;
  parent.innerHTML = '';
  const view = new EditorView({
    state: EditorState.create({doc: instance.originalText, extensions: buildExtensions(instance)}),
    parent
  });
  instance.view = view;
  createMobileToolbar(instance, options.panel || parent);
  installViewportAdapter(instance);
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
  instance.viewportCleanup?.();
  instance.view?.destroy();
}

export function undoZephyrEditor(instance) { undo(instance?.view); updateStatus(instance); }
export function redoZephyrEditor(instance) { redo(instance?.view); updateStatus(instance); }
export function formatZephyrEditor(instance) { return formatDocument(instance); }
export function focusZephyrEditor(instance) { instance?.view?.focus(); }
export function isZephyrEditorDirty(instance) { return !!instance?.dirty; }

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
  MergeView
};
