const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { browserService, SHOT_DIR } = require('./ai-browser-service');
const { DEFAULT_ZEPHYR_SYSTEM_PROMPT, DEFAULT_ZEPHYR_SKILLS } = require('./ai-defaults');

const OPENAI_TOOL_LIMIT = 4;
const MAX_TOOL_TEXT = 60 * 1024;
const MAX_REMOTE_READ = 512 * 1024;
const MAX_REMOTE_WRITE = 1024 * 1024;
const pendingActions = new Map();

function aiAbortError() {
    const err = new Error('AI 请求已停止');
    err.name = 'AbortError';
    return err;
}
function delay(ms, signal = null) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(aiAbortError());
        let timer = null;
        const done = () => {
            try { signal?.removeEventListener?.('abort', abort); } catch {}
            resolve();
        };
        const abort = () => {
            if (timer) clearTimeout(timer);
            reject(aiAbortError());
        };
        signal?.addEventListener?.('abort', abort, { once: true });
        timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    });
}
function clampNumber(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function safeJsonParse(value, fallback = null) { try { return JSON.parse(String(value || '').trim()); } catch { return fallback; } }
function htmlDecode(value = '') {
    return String(value)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 0));
}
function stripHtml(html = '') {
    return htmlDecode(String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}
function clipText(value, max = MAX_TOOL_TEXT) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}\n...[已截断 ${text.length - max} 字符]` : text;
}
function publicError(err) { return err?.message || String(err || '执行失败'); }
function throwIfAborted(signal) {
    if (signal?.aborted) throw aiAbortError();
}
function normalizeRole(role) {
    const value = String(role || '').toLowerCase();
    if (value === 'ai') return 'assistant';
    if (['system', 'user', 'assistant', 'tool'].includes(value)) return value;
    return 'user';
}
function normalizeContextLimits(ai = {}, provider = {}) {
    const global = ai.context || {};
    const providerContext = provider.options?.context || {};
    const raw = { ...global, ...providerContext };
    const windowTokens = clampNumber(raw.windowTokens, 1024, 1000000, 128000);
    return {
        windowTokens,
        keepMessages: clampNumber(raw.keepMessages, 4, 160, 40),
        maxInputChars: clampNumber(raw.maxInputChars || Math.floor(windowTokens * 3.2), 8000, 1200000, 180000),
        perMessageChars: clampNumber(raw.perMessageChars || Math.floor(windowTokens * 1.2), 1000, 300000, 60000),
        toolResultChars: clampNumber(raw.toolResultChars, 1000, 240000, 60000),
        memoryItems: clampNumber(raw.memoryItems, 0, 80, 28),
    };
}
function sanitizeMessages(messages = [], limits = {}) {
    const keepMessages = clampNumber(limits.keepMessages, 4, 160, 40);
    const perMessageChars = clampNumber(limits.perMessageChars, 1000, 300000, 60000);
    const maxInputChars = clampNumber(limits.maxInputChars, 8000, 1200000, 180000);
    const raw = (Array.isArray(messages) ? messages : [])
        .filter((item) => !['trace'].includes(String(item?.role || '').toLowerCase()))
        .slice(-keepMessages)
        .map((item) => ({ role: normalizeRole(item.role), content: clipText(item.content || '', perMessageChars) }))
        .filter((item) => item.content || item.role === 'assistant');
    let total = raw.reduce((sum, item) => sum + String(item.content || '').length, 0);
    while (raw.length > 2 && total > maxInputChars) {
        const removed = raw.shift();
        total -= String(removed?.content || '').length;
    }
    return raw;
}
function parseExtraObject(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    const parsed = safeJsonParse(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}
function normalizeOptions(provider = {}, requestOptions = {}, mode = 'chat') {
    const raw = { ...(provider.options || {}), ...(requestOptions || {}) };
    const extra = parseExtraObject(raw.extraJson);
    const out = {};
    const numberFields = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'];
    numberFields.forEach((field) => { if (raw[field] !== '' && raw[field] !== undefined && raw[field] !== null) out[field] = Number(raw[field]); });
    if (raw.max_tokens !== '' && raw.max_tokens !== undefined && raw.max_tokens !== null) out.max_tokens = Math.max(1, Number(raw.max_tokens) || 4096);
    if (raw.max_output_tokens !== '' && raw.max_output_tokens !== undefined && raw.max_output_tokens !== null) out.max_output_tokens = Math.max(1, Number(raw.max_output_tokens) || 4096);
    if (raw.reasoning_effort) out.reasoning_effort = String(raw.reasoning_effort);
    if (raw.use_previous_response_id || raw.usePreviousResponseId) out.use_previous_response_id = true;
    if (raw.reasoning && typeof raw.reasoning === 'object') out.reasoning = raw.reasoning;
    if (raw.text && typeof raw.text === 'object') out.text = raw.text;
    if (raw.response_format) {
        const rf = parseExtraObject(raw.response_format);
        out.response_format = Object.keys(rf).length ? rf : { type: String(raw.response_format) };
    }
    const merged = { ...out, ...extra };
    const apiMode = String(mode || 'chat').toLowerCase();
    ['context', 'windowTokens', 'maxInputChars', 'keepMessages', 'toolResultChars', 'memoryItems'].forEach((key) => delete merged[key]);
    if (apiMode === 'responses') {
        if (merged.max_tokens && !merged.max_output_tokens) merged.max_output_tokens = merged.max_tokens;
        delete merged.max_tokens;
        if (merged.reasoning_effort && !merged.reasoning) merged.reasoning = { effort: merged.reasoning_effort };
        delete merged.reasoning_effort;
        delete merged.response_format;
    } else {
        if (merged.max_output_tokens && !merged.max_tokens) merged.max_tokens = merged.max_output_tokens;
        delete merged.max_output_tokens;
        delete merged.text;
        delete merged.reasoning;
        delete merged.use_previous_response_id;
    }
    return merged;
}
function aiModelNames(provider = {}) {
    return String(provider.models || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}
function openAiApiMode(provider = {}) {
    const mode = String(provider.apiMode || provider.api || provider.endpointMode || 'auto').toLowerCase();
    const base = String(provider.baseUrl || '').toLowerCase();
    if (mode === 'responses' || /\/responses\/?$/.test(base)) return 'responses';
    if (mode === 'chat' || /\/chat\/completions\/?$/.test(base)) return 'chat';
    return 'chat';
}
function joinApiUrl(base, suffix) {
    const raw = String(base || '').trim().replace(/\/+$/, '');
    if (!raw) return suffix;
    if (/\/chat\/completions$/i.test(raw) || /\/responses$/i.test(raw) || /\/messages$/i.test(raw) || /:generateContent$/i.test(raw)) return raw;
    return `${raw}${suffix}`;
}
function providerType(provider = {}) { return String(provider.type || 'openai-compatible').toLowerCase(); }
function providerSupportsTools(provider = {}) { return ['openai-compatible', 'anthropic', 'gemini'].includes(providerType(provider)); }
function selectProvider(ai = {}, body = {}) {
    const providers = Array.isArray(ai.providers) ? ai.providers.filter((p) => p && p.enabled !== false) : [];
    if (!providers.length) throw new Error('AI 助理尚未配置可用模型供应商');
    const id = String(body.providerId || ai.defaultProviderId || '').trim();
    const provider = providers.find((p) => p.id === id) || providers[0];
    const models = aiModelNames(provider);
    const model = String(body.model || provider.defaultModel || ai.defaultModel || models[0] || '').trim();
    provider._selectedModel = model;
    if (!model) throw new Error('请选择模型；可在供应商设置中点击“获取模型”自动填充');
    return { provider, model };
}
function providerHeaders(provider = {}, contentType = 'application/json') {
    const type = providerType(provider);
    const extraHeaders = parseExtraObject(provider.extraHeaders || provider.headers);
    const headers = { 'Content-Type': contentType, ...extraHeaders };
    if (type === 'anthropic') {
        if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = provider.anthropicVersion || '2023-06-01';
    } else if (provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    if (provider.organization) {
        if (/^proj[_-]/i.test(String(provider.organization))) headers['OpenAI-Project'] = provider.organization;
        else headers['OpenAI-Organization'] = provider.organization;
    }
    return headers;
}
async function listProviderModels(provider = {}) {
    const type = providerType(provider);
    if (type === 'anthropic') {
        if (!provider.baseUrl && provider.apiKey) {
            try {
                const data = await fetchJson('https://api.anthropic.com/v1/models', { method: 'GET', headers: providerHeaders(provider) });
                return (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })).filter((m) => m.id);
            } catch (_) {}
        }
        return ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest'].map((id) => ({ id }));
    }
    if (type === 'gemini') {
        const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        const keyParam = provider.apiKey ? `?key=${encodeURIComponent(provider.apiKey)}` : '';
        const data = await fetchJson(`${base}/models${keyParam}`, { method: 'GET', headers: providerHeaders({ ...provider, apiKey: '' }) });
        return (data.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || m.name })).filter((m) => m.id && /generateContent/.test((m.supportedGenerationMethods || []).join(' ')));
    }
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base.replace(/\/(chat\/completions|responses)$/i, ''), '/models');
    const data = await fetchJson(url, { method: 'GET', headers: providerHeaders(provider) });
    return (data.data || data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id })).filter((m) => m.id);
}
async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    const data = safeJsonParse(text, null);
    if (!res.ok) {
        const message = data?.error?.message || data?.message || text.slice(0, 500) || `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data ?? {};
}
function mergeZephyrDefaultSkills(skills = []) {
    const list = Array.isArray(skills) ? skills.slice() : [];
    DEFAULT_ZEPHYR_SKILLS.forEach((skill) => {
        const exists = list.some((item) => item?.id === skill.id || item?.name === skill.name);
        if (!exists) list.unshift({ ...skill, updatedAt: Date.now() });
    });
    return list;
}
function buildSystemPrompt(ai = {}, context = {}, limits = {}) {
    const enabledSkills = mergeZephyrDefaultSkills(ai.skills).filter((s) => s?.enabled !== false && (s.prompt || s.description || s.name));
    const skillsText = enabledSkills.length
        ? `\n\n已启用 Skills：\n${enabledSkills.map((s, i) => `# Skill ${i + 1}: ${s.name || '未命名'}\n${s.description ? `说明：${s.description}\n` : ''}${s.prompt || ''}`).join('\n\n')}`
        : '';
    const relatedMemories = ai.memory?.enabled !== false ? selectPromptMemories(ai, context, clampNumber(limits.memoryItems, 0, 80, 28)) : [];
    const memoryText = relatedMemories.length
        ? `\n\n长期 Memory / 项目记忆（已按当前连接、项目、标签自动关联；按需参考，不要泄露敏感信息）：\n${relatedMemories.map((m) => `- ${memoryLabel(m)}: ${m.content || ''}`).join('\n')}`
        : '';
    const contextText = formatAiContextForPrompt(context);
    const envNames = Array.isArray(ai.envVars) ? ai.envVars.filter((e) => e?.enabled !== false && e.name).map((e) => e.name).join(', ') : '';
    const envText = envNames ? `\n\n可用 AI 环境变量名（值需通过 get_env_var 工具并经敏感确认后读取）：${envNames}` : '';
    const defaultPrompt = String(ai.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT || '').trim();
    const customPrompt = String(ai.systemPrompt || '').trim();
    return [
        `你是 ${ai.assistantName || 'Zephyr AI 助理'}，运行在 Zephyr SSH 管理平台内。`,
        defaultPrompt,
        `当前时间：${new Date().toISOString()}`,
        contextText,
        customPrompt ? `\n用户自定义系统提示：\n${customPrompt}` : '',
        skillsText,
        memoryText,
        envText,
    ].filter(Boolean).join('\n');
}
function toolDefinitions(ai = {}) {
    const p = ai.permissions || {};
    const tools = [];
    tools.push({ type: 'function', function: { name: 'list_connections', description: '列出 Zephyr 中可用的 SSH/RDP/VNC 连接（不含密码/私钥）；只有 SSH 支持远程命令和文件工具。', parameters: { type: 'object', properties: {}, additionalProperties: false } } });
    if (p.webSearch !== false) tools.push({ type: 'function', function: { name: 'web_search', description: '在网页上搜索实时信息，返回标题、链接和摘要。', parameters: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] } } });
    if (p.webFetch !== false) tools.push({ type: 'function', function: { name: 'fetch_url', description: '读取一个网页 URL 的正文文本。', parameters: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number' } }, required: ['url'] } } });
    if (p.browser !== false) {
        tools.push({ type: 'function', function: { name: 'browser_navigate', description: '用内置 Chromium 打开 URL，并在 AI 浮窗里显示页面预览，像用户打开网页一样继续代操作。', parameters: { type: 'object', properties: { url: { type: 'string' }, session: { type: 'string' }, waitMs: { type: 'number' } }, required: ['url'] } } });
        tools.push({ type: 'function', function: { name: 'browser_inspect', description: '列出当前页面可见的按钮、链接、输入框等可交互元素及 selector/坐标。点击或输入前优先调用它，避免盲点。', parameters: { type: 'object', properties: { session: { type: 'string' }, max: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_screenshot', description: '截取内置 Chromium 当前页面截图。', parameters: { type: 'object', properties: { session: { type: 'string' }, fullPage: { type: 'boolean' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_click', description: '点击当前页面中的 CSS 选择器或坐标。', parameters: { type: 'object', properties: { session: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_type', description: '向当前页面表单元素输入文本。', parameters: { type: 'object', properties: { session: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' } }, required: ['selector', 'text'] } } });
        tools.push({ type: 'function', function: { name: 'browser_scroll', description: '滚动当前页面。', parameters: { type: 'object', properties: { session: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_text', description: '读取当前浏览器页面可见/正文文本。', parameters: { type: 'object', properties: { session: { type: 'string' }, maxChars: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_key', description: '向当前页面发送键盘按键（Enter/Tab/Escape/方向键等），用于像用户一样操作页面。', parameters: { type: 'object', properties: { session: { type: 'string' }, key: { type: 'string' } }, required: ['key'] } } });
        tools.push({ type: 'function', function: { name: 'browser_wait', description: '等待页面加载或交互完成，然后返回页面状态和截图预览。', parameters: { type: 'object', properties: { session: { type: 'string' }, ms: { type: 'number' } } } } });
    }
    if (p.memory !== false) {
        tools.push({ type: 'function', function: { name: 'memory_search', description: '搜索长期 Memory / 项目记忆；会结合当前连接、项目、标签进行自动关联排序。', parameters: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, connectionIds: { type: 'array', items: { type: 'string' } }, maxResults: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'memory_save', description: '保存长期 Memory 或项目记忆；优先填写 connectionIds/project/projects/tags 以便自动关联。', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string' }, projects: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, connectionIds: { type: 'array', items: { type: 'string' } } }, required: ['content'] } } });
    }
    if (p.env !== false) {
        tools.push({ type: 'function', function: { name: 'list_env_vars', description: '列出 AI 专用环境变量名称和说明，不返回值。', parameters: { type: 'object', properties: {} } } });
        tools.push({ type: 'function', function: { name: 'get_env_var', description: '读取 AI 专用环境变量的值。敏感操作，需要用户确认。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
    }
    tools.push({ type: 'function', function: { name: 'open_connection', description: '在用户当前 Zephyr 页面里直接打开一个 SSH/RDP/VNC 连接，相当于用户点击连接卡片。用于需要 AI 代用户打开页面/会话时。', parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] } } });
    tools.push({ type: 'function', function: { name: 'plan_task', description: '创建执行计划，返回 planId；后续用 plan_update 更新步骤状态。', parameters: { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risk: { type: 'string' } }, required: ['title', 'steps'] } } });
    tools.push({ type: 'function', function: { name: 'plan_update', description: '更新任务计划：步骤状态、暂停/继续、失败重试、追加日志。', parameters: { type: 'object', properties: { planId: { type: 'string' }, status: { type: 'string', enum: ['planned', 'running', 'paused', 'completed', 'failed', 'cancelled'] }, pause: { type: 'boolean' }, resume: { type: 'boolean' }, retryFailed: { type: 'boolean' }, note: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, index: { type: 'number' }, status: { type: 'string', enum: ['pending', 'running', 'paused', 'completed', 'failed', 'skipped', 'retrying'] }, note: { type: 'string' }, error: { type: 'string' } } } } }, required: ['planId'] } } });
    tools.push({ type: 'function', function: { name: 'plan_delete', description: '删除一个任务计划。', parameters: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] } } });
    if (p.remoteExecute !== false) tools.push({ type: 'function', function: { name: 'remote_execute', description: '在一个或多个 SSH 连接上执行 shell 命令。敏感操作需要用户确认。', parameters: { type: 'object', properties: { connectionIds: { type: 'array', items: { type: 'string' } }, command: { type: 'string' }, timeoutSeconds: { type: 'number' } }, required: ['connectionIds', 'command'] } } });
    if (p.fileRead !== false) tools.push({ type: 'function', function: { name: 'remote_read_file', description: '读取远程 SSH 主机上的文本文件。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, path: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['connectionId', 'path'] } } });
    if (p.fileWrite !== false) tools.push({ type: 'function', function: { name: 'remote_write_file', description: '写入或追加远程 SSH 主机文件。敏感操作需要用户确认。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, append: { type: 'boolean' } }, required: ['connectionId', 'path', 'content'] } } });
    return tools;
}
function convertMessagesForProvider(messages = [], systemPrompt = '', limits = {}) {
    const sanitized = sanitizeMessages(messages, limits);
    return [{ role: 'system', content: systemPrompt }, ...sanitized];
}
function normalizeOpenAiMessage(message = {}) {
    return {
        role: message.role || 'assistant',
        content: typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p) => p?.text || '').join('\n') : '',
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
}
function toAnthropicTools(tools = []) {
    return tools.map((tool) => ({
        name: tool.function?.name,
        description: tool.function?.description || '',
        input_schema: tool.function?.parameters || { type: 'object', properties: {} },
    })).filter((tool) => tool.name);
}
function anthropicMessages(messages = []) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || m.name || 'tool', content: String(m.content || '') }] });
        } else if (m.role === 'assistant') {
            const content = [];
            if (m.content) content.push({ type: 'text', text: String(m.content) });
            (m.tool_calls || []).forEach((call) => {
                const parsed = parseToolCall(call);
                if (parsed.name) content.push({ type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.args || {} });
            });
            out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
        } else {
            out.push({ role: 'user', content: String(m.content || '') });
        }
    }
    return out;
}
function geminiSchema(schema = {}) {
    if (!schema || typeof schema !== 'object') return schema;
    const out = { ...schema };
    if (typeof out.type === 'string') out.type = out.type.toUpperCase();
    if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, geminiSchema(v)]));
    if (out.items) out.items = geminiSchema(out.items);
    delete out.additionalProperties;
    return out;
}
function toGeminiTools(tools = []) {
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function?.name,
        description: tool.function?.description || '',
        parameters: geminiSchema(tool.function?.parameters || { type: 'object', properties: {} }),
    })).filter((tool) => tool.name);
    return functionDeclarations.length ? [{ functionDeclarations }] : [];
}
function geminiContents(messages = []) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            const response = safeJsonParse(m.content, { result: String(m.content || '') });
            out.push({ role: 'function', parts: [{ functionResponse: { name: m.name || m.tool_call_id || 'tool', response } }] });
        } else if (m.role === 'assistant') {
            const parts = [];
            if (m.content) parts.push({ text: String(m.content) });
            (m.tool_calls || []).forEach((call) => {
                const parsed = parseToolCall(call);
                if (parsed.name) parts.push({ functionCall: { name: parsed.name, args: parsed.args || {} } });
            });
            out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
        } else {
            out.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
        }
    }
    return out;
}
function responseOutputText(data = {}) {
    if (typeof data.output_text === 'string') return data.output_text;
    const chunks = [];
    (Array.isArray(data.output) ? data.output : []).forEach((item) => {
        (Array.isArray(item.content) ? item.content : []).forEach((part) => {
            if (typeof part.text === 'string') chunks.push(part.text);
            if (typeof part.output_text === 'string') chunks.push(part.output_text);
        });
    });
    return chunks.join('\n');
}
function responseToolCalls(data = {}) {
    const out = [];
    (Array.isArray(data.output) ? data.output : []).forEach((item) => {
        const name = item.name || item.function?.name;
        if (item.type === 'function_call' && name) {
            out.push({ id: item.call_id || item.id || crypto.randomUUID(), type: 'function', function: { name, arguments: item.arguments || item.function?.arguments || '{}' } });
        }
    });
    return out;
}
function toResponsesInput(messages = []) {
    const out = [];
    for (const m of messages.filter((item) => item.role !== 'system')) {
        if (m.role === 'tool') {
            out.push({ type: 'function_call_output', call_id: m.tool_call_id || m.name || 'tool', output: String(m.content || '') });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            if (m.content) out.push({ role: 'assistant', content: String(m.content || '') });
            m.tool_calls.map(parseToolCall).filter((call) => call.name).forEach((call) => out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args || {}) }));
            continue;
        }
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        out.push({ role, content: String(m.content || '') });
    }
    return out;
}
function toResponsesTools(tools = []) {
    return tools.map((tool) => ({ type: 'function', name: tool.function?.name, description: tool.function?.description || '', parameters: tool.function?.parameters || { type: 'object', properties: {} } })).filter((tool) => tool.name);
}
async function callOpenAiResponses(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base, '/responses');
    const opts = normalizeOptions(provider, options, 'responses');
    const usePreviousResponseId = !!opts.use_previous_response_id;
    delete opts.use_previous_response_id;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    let previousResponseId = '';
    let startIndex = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.response_id || messages[i]?._response_id) {
            previousResponseId = messages[i].response_id || messages[i]._response_id;
            startIndex = i + 1;
            break;
        }
    }
    const inputMessages = previousResponseId && usePreviousResponseId ? messages.slice(startIndex).filter((m) => m.role === 'tool') : messages;
    const payload = { model, input: toResponsesInput(inputMessages), ...opts };
    if (previousResponseId && usePreviousResponseId) payload.previous_response_id = previousResponseId;
    if (system) payload.instructions = system;
    const responseTools = toResponsesTools(tools);
    if (responseTools.length) { payload.tools = responseTools; payload.tool_choice = 'auto'; }
    const run = async (body) => fetchJson(url, { method: 'POST', headers: providerHeaders(provider), body: JSON.stringify(body), signal });
    let data;
    try {
        data = await run(payload);
    } catch (err) {
        if (payload.previous_response_id && /previous_response_id/i.test(String(err.message || ''))) {
            const retryPayload = { ...payload, input: toResponsesInput(messages) };
            delete retryPayload.previous_response_id;
            data = await run(retryPayload);
        } else {
            throw err;
        }
    }
    return { role: 'assistant', content: responseOutputText(data), tool_calls: responseToolCalls(data), response_id: data.id || '' };
}
async function callOpenAiCompatible(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base, '/chat/completions');
    const payload = { model, messages, stream: false, ...normalizeOptions(provider, options, 'chat') };
    if (tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    const data = await fetchJson(url, { method: 'POST', headers: providerHeaders(provider), body: JSON.stringify(payload), signal });
    if (openAiApiMode(provider) === 'responses' && Array.isArray(data.output)) {
        return { role: 'assistant', content: responseOutputText(data), tool_calls: responseToolCalls(data), response_id: data.id || '' };
    }
    return normalizeOpenAiMessage(data?.choices?.[0]?.message || { content: '' });
}
async function callAnthropic(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.anthropic.com/v1';
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const normal = anthropicMessages(messages);
    const opts = normalizeOptions(provider, options, 'chat');
    const payload = { model, system, messages: normal.length ? normal : [{ role: 'user', content: '你好' }], max_tokens: opts.max_tokens || 4096, temperature: opts.temperature, top_p: opts.top_p };
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length) payload.tools = anthropicTools;
    const data = await fetchJson(joinApiUrl(base, '/messages'), { method: 'POST', headers: providerHeaders(provider), body: JSON.stringify(payload), signal });
    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    const toolCalls = blocks.filter((b) => b.type === 'tool_use' && b.name).map((b) => ({ id: b.id || crypto.randomUUID(), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
    return { role: 'assistant', content, tool_calls: toolCalls };
}
async function callGemini(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const keyParam = provider.apiKey ? `?key=${encodeURIComponent(provider.apiKey)}` : '';
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = geminiContents(messages);
    const opts = normalizeOptions(provider, options, 'chat');
    const generationConfig = { temperature: opts.temperature, topP: opts.top_p, maxOutputTokens: opts.max_tokens };
    Object.keys(generationConfig).forEach((k) => generationConfig[k] === undefined && delete generationConfig[k]);
    const body = { contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '你好' }] }], generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const geminiTools = toGeminiTools(tools);
    if (geminiTools.length) body.tools = geminiTools;
    const data = await fetchJson(`${base}/models/${encodeURIComponent(model)}:generateContent${keyParam}`, { method: 'POST', headers: providerHeaders({ ...provider, apiKey: '' }), body: JSON.stringify(body), signal });
    const parts = (data.candidates || []).flatMap((c) => c.content?.parts || []);
    const content = parts.filter((p) => p.text).map((p) => p.text || '').join('\n');
    const toolCalls = parts.filter((p) => p.functionCall?.name).map((p) => ({ id: crypto.randomUUID(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }));
    return { role: 'assistant', content, tool_calls: toolCalls };
}
async function callProvider(provider, model, messages, options = {}, tools = [], signal = null) {
    throwIfAborted(signal);
    const type = providerType(provider);
    if (type === 'anthropic') return callAnthropic(provider, model, messages, options, tools, signal);
    if (type === 'gemini') return callGemini(provider, model, messages, options, tools, signal);
    if (openAiApiMode(provider) === 'responses') return callOpenAiResponses(provider, model, messages, options, tools, signal);
    return callOpenAiCompatible(provider, model, messages, options, tools, signal);
}
async function duckDuckGoSearch(query, maxResults = 6) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 ZephyrAI/1.0' } });
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxResults) {
        let link = htmlDecode(m[1]);
        try { const u = new URL(link, 'https://duckduckgo.com'); if (u.searchParams.get('uddg')) link = u.searchParams.get('uddg'); } catch {}
        out.push({ title: stripHtml(m[2]), url: link, snippet: stripHtml(m[3]) });
    }
    if (!out.length) {
        const simple = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{5,220}?)<\/a>/gi;
        while ((m = simple.exec(html)) && out.length < maxResults) {
            const title = stripHtml(m[2]);
            const link = htmlDecode(m[1]);
            if (/^https?:/i.test(link) && title) out.push({ title, url: link, snippet: '' });
        }
    }
    return out;
}
async function fetchUrlText(url, maxChars = MAX_TOOL_TEXT) {
    const parsed = new URL(String(url || ''));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https URL');
    const res = await fetch(parsed.href, { headers: { 'User-Agent': 'Mozilla/5.0 ZephyrAI/1.0' } });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    const body = /html/i.test(contentType) ? stripHtml(text) : text;
    return clipText(body, clampNumber(maxChars, 1000, 120000, MAX_TOOL_TEXT));
}
function connectionSummary(conn) {
    return { id: conn.id, name: conn.name, protocol: conn.protocol, host: conn.host, port: conn.port, username: conn.username, tags: conn.tags || [], remark: conn.remark || '', lastConnectedAt: conn.lastConnectedAt || null };
}
function getAllConnections(deps) {
    return (deps.readJSON(deps.CONNECTIONS_FILE, { connections: [] }).connections || []);
}
function getSshConnections(deps) {
    return getAllConnections(deps).filter((c) => String(c.protocol || '').toUpperCase() === 'SSH');
}
function aiEnvList(ai = {}) {
    return (Array.isArray(ai.envVars) ? ai.envVars : []).filter((item) => item?.enabled !== false && item.name);
}
function publicEnvVar(item = {}) {
    return { name: item.name, description: item.description || '', enabled: item.enabled !== false, hasValue: !!item.value, updatedAt: item.updatedAt || null };
}
function searchMemories(ai = {}, query = '', scope = '', maxResults = 10, context = {}) {
    const q = String(query || '').toLowerCase();
    const wantedScope = String(scope || '').toLowerCase();
    const enriched = rankMemories(ai, context)
        .filter((m) => !wantedScope || [m.scope, m.project, ...(m.projects || []), ...(m.tags || [])].join(' ').toLowerCase().includes(wantedScope))
        .filter((m) => !q || memorySearchHaystack(m).includes(q));
    return enriched.slice(0, clampNumber(maxResults, 1, 50, 10));
}
function stringList(value) {
    if (Array.isArray(value)) return value.map((x) => String(x || '').trim()).filter(Boolean);
    return String(value || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean);
}
function uniqueStrings(list = []) {
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
        const text = String(item || '').trim();
        const key = text.toLowerCase();
        if (text && !seen.has(key)) { seen.add(key); out.push(text); }
    });
    return out;
}
function normalizeAiContext(context = {}) {
    const connections = Array.isArray(context.connections) ? context.connections : [];
    const activeConnectionIds = uniqueStrings([
        ...stringList(context.activeConnectionIds),
        ...connections.map((c) => c.id),
    ]);
    const projects = uniqueStrings([context.project, ...stringList(context.projects)]);
    const tags = uniqueStrings([...stringList(context.tags), ...connections.flatMap((c) => Array.isArray(c.tags) ? c.tags : stringList(c.tags))]);
    return { ...context, activeConnectionIds, projects, tags, connections };
}
function formatAiContextForPrompt(context = {}) {
    const c = normalizeAiContext(context);
    const lines = [];
    if (c.view) lines.push(`当前视图：${c.view}`);
    if (c.activeChatTitle) lines.push(`当前 AI 对话：${c.activeChatTitle}`);
    if (c.projects.length) lines.push(`关联项目：${c.projects.join(', ')}`);
    if (c.tags.length) lines.push(`关联标签：${c.tags.join(', ')}`);
    if (c.connections.length) lines.push(`当前连接上下文：${c.connections.slice(0, 12).map((x) => `${x.protocol || 'SSH'}:${x.name || x.id}(${x.username || '-'}@${x.host || '-'})${Array.isArray(x.tags) && x.tags.length ? `[${x.tags.join(',')}]` : ''}`).join('; ')}`);
    if (!lines.length) return '';
    return `\n当前 Zephyr 上下文（用于选择连接、项目和 Memory）：\n${lines.map((x) => `- ${x}`).join('\n')}`;
}
function memoryLabel(m = {}) {
    const bits = [];
    const scopes = uniqueStrings([m.scope, m.project, ...(m.projects || [])]);
    if (scopes.length) bits.push(scopes.join('/'));
    if (Array.isArray(m.connectionIds) && m.connectionIds.length) bits.push(`连接:${m.connectionIds.join(',')}`);
    if (Array.isArray(m.tags) && m.tags.length) bits.push(`标签:${m.tags.join(',')}`);
    return `[${bits.join(' · ') || 'global'}] ${m.title || m.key || 'memory'}`;
}
function memorySearchHaystack(m = {}) {
    return [m.title, m.key, m.content, m.scope, m.project, ...(m.projects || []), ...(m.tags || []), ...(m.connectionIds || []), ...(m.connectionNames || [])].join(' ').toLowerCase();
}
function rankMemories(ai = {}, context = {}) {
    const c = normalizeAiContext(context);
    const projectSet = new Set(c.projects.map((x) => x.toLowerCase()));
    const tagSet = new Set(c.tags.map((x) => x.toLowerCase()));
    const connSet = new Set(c.activeConnectionIds.map((x) => x.toLowerCase()));
    return (Array.isArray(ai.memories) ? ai.memories : [])
        .filter((m) => m?.enabled !== false)
        .map((m) => {
            const connectionIds = stringList(m.connectionIds);
            const projects = uniqueStrings([m.project, ...stringList(m.projects)]);
            const tags = stringList(m.tags);
            let score = 0;
            if (connectionIds.some((id) => connSet.has(id.toLowerCase()))) score += 120;
            if (projects.some((p) => projectSet.has(p.toLowerCase()))) score += 70;
            if (tags.some((t) => tagSet.has(t.toLowerCase()))) score += 45;
            if (String(m.scope || '').toLowerCase() === 'global') score += 5;
            return { ...m, connectionIds, projects, tags, _score: score };
        })
        .sort((a, b) => (b._score - a._score) || (Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)));
}
function selectPromptMemories(ai = {}, context = {}, max = 28) {
    const ranked = rankMemories(ai, context);
    const relevant = ranked.filter((m) => m._score > 0);
    const globals = ranked.filter((m) => String(m.scope || '').toLowerCase() === 'global' && !relevant.some((x) => x.id === m.id)).slice(0, 6);
    return [...relevant, ...globals].slice(0, max);
}
function findConnection(deps, id) {
    const conn = getSshConnections(deps).find((c) => c.id === String(id || ''));
    if (!conn) throw new Error('SSH 连接不存在或不可用');
    return conn;
}
function sftpOpen(client) { return new Promise((resolve, reject) => client.sftp((err, sftp) => err ? reject(err) : resolve(sftp))); }
function sftpStat(sftp, targetPath) { return new Promise((resolve, reject) => sftp.stat(targetPath, (err, stat) => err ? reject(err) : resolve(stat))); }
function sftpReadFile(sftp, targetPath) { return new Promise((resolve, reject) => sftp.readFile(targetPath, (err, data) => err ? reject(err) : resolve(data))); }
function sftpWriteFile(sftp, targetPath, buffer, append = false) {
    return new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(targetPath, { flags: append ? 'a' : 'w' });
        stream.on('error', reject);
        stream.on('finish', resolve);
        stream.end(buffer);
    });
}
async function withRemoteSftp(deps, conn, fn) {
    const routed = await deps.createRoutedSSHConnection(conn, 10000);
    try {
        const sftp = await sftpOpen(routed.client);
        return await fn(sftp);
    } finally {
        (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
    }
}
function isSensitiveTool(name) { return ['remote_execute', 'remote_write_file', 'get_env_var'].includes(String(name || '')); }
function publicToolArgs(toolName, args) {
    const copy = JSON.parse(JSON.stringify(args || {}));
    if (copy.content && String(copy.content).length > 1200) copy.content = `${String(copy.content).slice(0, 1200)}\n...[内容已截断]`;
    if (toolName === 'get_env_var') delete copy.nameValue;
    return copy;
}
function confirmationSummary(toolName, args, deps) {
    if (toolName === 'remote_execute') return `在 ${(args.connectionIds || []).length} 台服务器执行：${String(args.command || '').slice(0, 200)}`;
    if (toolName === 'remote_write_file') {
        let connName = args.connectionId;
        try { connName = findConnection(deps, args.connectionId).name || connName; } catch {}
        return `写入远程文件：${connName}:${args.path}${args.append ? '（追加）' : ''}`;
    }
    if (toolName === 'get_env_var') return `读取 AI 环境变量：${String(args.name || '').slice(0, 120)}`;
    return `执行工具：${toolName}`;
}
async function browserResultWithPreview(action, result, session = 'default', includePreview = true) {
    if (!includePreview) return result;
    try {
        const preview = await browserService.screenshot({ session, fullPage: false });
        return { ...result, preview };
    } catch (err) {
        return { ...result, previewError: err.message || String(err) };
    }
}
function normalizePlanStep(step, index = 0) {
    const isPlain = typeof step === 'string';
    const text = isPlain ? step : (step?.text || '');
    return {
        id: String(isPlain ? `step-${index + 1}` : (step?.id || `step-${index + 1}`)).slice(0, 80),
        text: String(text || '').slice(0, 500),
        status: String(isPlain ? 'pending' : (step?.status || 'pending')).slice(0, 40),
        note: String(isPlain ? '' : (step?.note || '')).slice(0, 1000),
        error: String(isPlain ? '' : (step?.error || '')).slice(0, 1000),
        attempts: Number(isPlain ? 0 : (step?.attempts || 0)),
        updatedAt: Number(isPlain ? Date.now() : (step?.updatedAt || Date.now())),
    };
}
function updateStoredPlan(ai = {}, planId = '', updater) {
    const plans = Array.isArray(ai.plans) ? ai.plans.slice(0, 100) : [];
    const idx = plans.findIndex((p) => p.id === String(planId || ''));
    if (idx < 0) throw new Error('任务计划不存在');
    const plan = { ...plans[idx], steps: Array.isArray(plans[idx].steps) ? plans[idx].steps.map(normalizePlanStep) : [] };
    const next = updater(plan) || plan;
    next.updatedAt = Date.now();
    plans[idx] = next;
    return { plans, plan: next };
}
function inferPlanStatus(plan = {}) {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (!steps.length) return plan.status || 'planned';
    if (steps.some((s) => s.status === 'failed')) return 'failed';
    if (steps.some((s) => s.status === 'paused')) return 'paused';
    if (steps.some((s) => s.status === 'running' || s.status === 'retrying')) return 'running';
    if (steps.every((s) => ['completed', 'skipped'].includes(s.status))) return 'completed';
    if (steps.some((s) => ['completed', 'skipped'].includes(s.status))) return 'running';
    return plan.status || 'planned';
}
async function maybeRequireConfirmation(toolName, args, ctx, run, deps) {
    const ai = deps.storage.getSettings().ai || {};
    const sensitive = ai.sensitive || {};
    if (!isSensitiveTool(toolName) || ctx.confirmed || sensitive.requireConfirmation === false) return run();
    if (sensitive.autoConfirm) {
        await delay(clampNumber(sensitive.autoConfirmDelayMs, 0, 60000, 2500), ctx.signal);
        return run();
    }
    const id = crypto.randomUUID();
    const confirmation = { id, toolName, summary: confirmationSummary(toolName, args, deps), args: publicToolArgs(toolName, args), createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 };
    pendingActions.set(id, { ...confirmation, username: ctx.req.session.username, rawArgs: args, context: ctx.context || {} });
    return { confirmationRequired: true, confirmation };
}
async function executeAiTool(toolName, args = {}, ctx, deps) {
    const ai = deps.storage.getSettings().ai || {};
    const p = ai.permissions || {};
    switch (toolName) {
        case 'list_connections':
            return { connections: getAllConnections(deps).map(connectionSummary) };
        case 'web_search':
            if (p.webSearch === false) throw new Error('网页搜索权限未开启');
            return { results: await duckDuckGoSearch(String(args.query || ''), clampNumber(args.maxResults, 1, 10, 6)) };
        case 'fetch_url':
            if (p.webFetch === false) throw new Error('网页读取权限未开启');
            return { url: String(args.url || ''), text: await fetchUrlText(args.url, args.maxChars) };
        case 'browser_navigate': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('navigate', await browserService.navigate({ url: args.url, session, waitMs: args.waitMs }), session);
        }
        case 'browser_screenshot':
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            return browserService.screenshot({ session: args.session || 'default', fullPage: !!args.fullPage });
        case 'browser_inspect': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('inspect', await browserService.inspect({ session, max: args.max || 80 }), session);
        }
        case 'browser_click': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('click', await browserService.click({ session, selector: args.selector || '', x: args.x, y: args.y }), session);
        }
        case 'browser_type': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('type', await browserService.type({ session, selector: args.selector || '', text: args.text || '', clear: !!args.clear }), session);
        }
        case 'browser_scroll': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('scroll', await browserService.scroll({ session, direction: args.direction || 'down', amount: args.amount }), session);
        }
        case 'browser_text': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('text', { session, text: await browserService.text(session, clampNumber(args.maxChars, 1000, 120000, MAX_TOOL_TEXT)) }, session);
        }
        case 'browser_key': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('key', await browserService.key({ session, key: args.key || 'Enter' }), session);
        }
        case 'browser_wait': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = args.session || 'default';
            return browserResultWithPreview('wait', await browserService.wait({ session, ms: args.ms || 1000 }), session);
        }
        case 'open_connection': {
            const connectionId = String(args.connectionId || '').trim();
            const conn = getAllConnections(deps).find((c) => c.id === connectionId);
            if (!conn) throw new Error('连接不存在');
            deps.addActivity?.(`AI 请求打开连接：${conn.name || conn.id}`);
            return { uiAction: 'open_connection', connectionId: conn.id, connection: connectionSummary(conn), message: `准备在页面打开 ${conn.protocol || 'SSH'} 连接：${conn.name || conn.host}` };
        }
        case 'memory_search':
            if (p.memory === false || ai.memory?.enabled === false) throw new Error('长期 Memory 权限未开启');
            return { memories: searchMemories(ai, args.query || '', args.scope || args.project || '', args.maxResults || 10, { ...(ctx.context || {}), activeConnectionIds: uniqueStrings([...stringList(ctx.context?.activeConnectionIds), ...stringList(args.connectionIds)]), projects: uniqueStrings([...stringList(ctx.context?.projects), args.project].filter(Boolean)), tags: uniqueStrings([...stringList(ctx.context?.tags), ...stringList(args.tags)]) }) };
        case 'memory_save': {
            if (p.memory === false || ai.memory?.enabled === false) throw new Error('长期 Memory 权限未开启');
            const memories = Array.isArray(ai.memories) ? ai.memories.slice(0, 1000) : [];
            const context = normalizeAiContext(ctx.context || {});
            const connectionIds = uniqueStrings([...context.activeConnectionIds, ...stringList(args.connectionIds)]);
            const projects = uniqueStrings([...(context.projects || []), args.project, ...stringList(args.projects)]);
            const tags = uniqueStrings([...(context.tags || []), ...stringList(args.tags)]);
            const item = {
                id: crypto.randomUUID(),
                title: String(args.title || args.key || 'AI Memory').slice(0, 120),
                content: String(args.content || '').slice(0, 20000),
                scope: String(args.scope || projects[0] || (connectionIds.length ? 'connection' : 'global')).slice(0, 80),
                project: String(args.project || projects[0] || '').slice(0, 120),
                projects: projects.slice(0, 20),
                tags: tags.slice(0, 30),
                connectionIds: connectionIds.slice(0, 50),
                enabled: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            if (!item.content.trim()) throw new Error('Memory 内容不能为空');
            memories.unshift(item);
            deps.storage.updateSettings({ ai: { memories: memories.slice(0, clampNumber(ai.memory?.maxItems, 1, 2000, 500)) } });
            deps.addActivity?.(`AI 保存 Memory：${item.title}`);
            return { memory: item };
        }
        case 'list_env_vars':
            if (p.env === false) throw new Error('AI 环境变量权限未开启');
            return { envVars: aiEnvList(ai).map(publicEnvVar) };
        case 'get_env_var':
            if (p.env === false) throw new Error('AI 环境变量权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const name = String(args.name || '').trim();
                const item = aiEnvList(ai).find((envVar) => envVar.name === name);
                if (!item) throw new Error('环境变量不存在或未启用');
                return { name: item.name, value: item.value || '', description: item.description || '' };
            }, deps);
        case 'plan_task': {
            const steps = Array.isArray(args.steps) ? args.steps.map((s) => String(s).slice(0, 500)).filter(Boolean) : [];
            if (!steps.length) throw new Error('计划至少需要一个步骤');
            const plans = Array.isArray(ai.plans) ? ai.plans.slice(0, 100) : [];
            const plan = {
                id: crypto.randomUUID(),
                title: String(args.title || 'AI 任务计划').slice(0, 160),
                steps: steps.map((text, index) => normalizePlanStep({ id: `step-${index + 1}`, text, status: 'pending' }, index)),
                risk: String(args.risk || '').slice(0, 2000),
                status: 'planned',
                logs: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            plans.unshift(plan);
            deps.storage.updateSettings({ ai: { plans: plans.slice(0, 100) } });
            return { plan };
        }
        case 'plan_update': {
            const planId = String(args.planId || '').trim();
            if (!planId) throw new Error('planId 不能为空');
            const { plans, plan } = updateStoredPlan(ai, planId, (draft) => {
                const logs = Array.isArray(draft.logs) ? draft.logs.slice(-80) : [];
                if (args.note) logs.push({ time: Date.now(), text: String(args.note).slice(0, 2000) });
                draft.logs = logs;
                if (args.pause) { draft.status = 'paused'; draft.steps = draft.steps.map((s) => s.status === 'running' || s.status === 'retrying' ? { ...s, status: 'paused', updatedAt: Date.now() } : s); }
                if (args.resume) { draft.status = 'running'; const first = draft.steps.find((s) => s.status === 'paused') || draft.steps.find((s) => s.status === 'pending'); if (first) { first.status = 'running'; first.updatedAt = Date.now(); } }
                if (args.retryFailed) { draft.status = 'running'; draft.steps = draft.steps.map((s) => s.status === 'failed' ? { ...s, status: 'retrying', attempts: Number(s.attempts || 0) + 1, error: '', updatedAt: Date.now() } : s); }
                if (Array.isArray(args.steps)) {
                    args.steps.forEach((patch) => {
                        const idx = patch.id ? draft.steps.findIndex((s) => s.id === patch.id) : Number(patch.index) - 1;
                        if (idx < 0 || idx >= draft.steps.length) return;
                        const old = draft.steps[idx];
                        draft.steps[idx] = { ...old, status: patch.status ? String(patch.status).slice(0, 40) : old.status, note: patch.note !== undefined ? String(patch.note).slice(0, 1000) : old.note, error: patch.error !== undefined ? String(patch.error).slice(0, 1000) : old.error, updatedAt: Date.now() };
                    });
                }
                if (args.status) draft.status = String(args.status).slice(0, 40);
                else draft.status = inferPlanStatus(draft);
                return draft;
            });
            deps.storage.updateSettings({ ai: { plans } });
            return { plan };
        }
        case 'plan_delete': {
            const planId = String(args.planId || '').trim();
            if (!planId) throw new Error('planId 不能为空');
            const plans = (Array.isArray(ai.plans) ? ai.plans : []).filter((plan) => plan.id !== planId);
            deps.storage.updateSettings({ ai: { plans } });
            return { deleted: true, planId, plans };
        }
        case 'remote_execute':
            if (p.remoteExecute === false) throw new Error('远程执行权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const ids = Array.isArray(args.connectionIds) ? args.connectionIds.map(String) : [];
                if (!ids.length) throw new Error('请选择 SSH 连接');
                const command = String(args.command || '').trim();
                if (!command) throw new Error('命令不能为空');
                const targets = getSshConnections(deps).filter((c) => ids.includes(c.id));
                if (!targets.length) throw new Error('远程执行仅支持 SSH 连接；RDP/VNC 只能作为资产上下文或通过连接入口打开');
                const results = await Promise.all(targets.map((conn) => deps.runRemoteCommand(conn, command, clampNumber(args.timeoutSeconds, 1, 300, 30), { signal: ctx.signal })));
                deps.addActivity?.(`AI 助理远程执行：${targets.length} 台服务器，命令 ${command.slice(0, 40)}`);
                return { results };
            }, deps);
        case 'remote_read_file':
            if (p.fileRead === false) throw new Error('远程文件读取权限未开启');
            return withRemoteSftp(deps, findConnection(deps, args.connectionId), async (sftp) => {
                const targetPath = String(args.path || '');
                const maxBytes = clampNumber(args.maxBytes, 1, MAX_REMOTE_READ, MAX_REMOTE_READ);
                const stat = await sftpStat(sftp, targetPath);
                if (Number(stat.size) > maxBytes) throw new Error(`文件过大（${stat.size} bytes），当前上限 ${maxBytes} bytes`);
                const data = await sftpReadFile(sftp, targetPath);
                return { path: targetPath, size: data.length, content: data.toString('utf8') };
            });
        case 'remote_write_file':
            if (p.fileWrite === false) throw new Error('远程文件写入权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => withRemoteSftp(deps, findConnection(deps, args.connectionId), async (sftp) => {
                const targetPath = String(args.path || '');
                const buffer = args.encoding === 'base64' ? Buffer.from(String(args.content || ''), 'base64') : Buffer.from(String(args.content || ''), 'utf8');
                if (buffer.length > MAX_REMOTE_WRITE) throw new Error(`写入内容过大，当前上限 ${MAX_REMOTE_WRITE} bytes`);
                await sftpWriteFile(sftp, targetPath, buffer, !!args.append);
                deps.addActivity?.(`AI 助理写入远程文件：${targetPath}`);
                return { path: targetPath, bytes: buffer.length, append: !!args.append };
            }), deps);
        default:
            throw new Error(`未知工具：${toolName}`);
    }
}
function parseToolCall(call = {}) {
    const fn = call.function || {};
    return { id: call.id || crypto.randomUUID(), name: fn.name || call.name || '', args: safeJsonParse(fn.arguments || call.arguments || '{}', {}) || {} };
}
function toolResultMessage(call, result, mode = 'chat', limits = {}) {
    const max = clampNumber(limits.toolResultChars, 1000, 240000, 60000);
    if (mode === 'responses') return { role: 'tool', tool_call_id: call.id, name: call.name, content: clipText(JSON.stringify(result), max) };
    return { role: 'tool', tool_call_id: call.id, name: call.name, content: clipText(JSON.stringify(result, null, 2), max) };
}
async function completeWithProvider(ai, body) {
    const { provider, model } = selectProvider(ai, body);
    const language = String(body.language || 'plain');
    const path = String(body.path || 'untitled');
    const prefix = String(body.prefix || '').slice(-5000);
    const suffix = String(body.suffix || '').slice(0, 2000);
    const prompt = `你是代码补全引擎。只返回应插入光标处的代码，不要解释，不要 Markdown。\n文件: ${path}\n语言: ${language}\n\n<光标前>\n${prefix}\n</光标前>\n<光标后>\n${suffix}\n</光标后>`;
    const messages = [{ role: 'system', content: '你只输出代码补全内容。' }, { role: 'user', content: prompt }];
    const message = await callProvider(provider, model, messages, { temperature: 0.2, max_tokens: clampNumber(body.maxTokens, 16, 1024, 160) }, []);
    const text = String(message.content || '').replace(/^```[\w-]*\n?/, '').replace(/```$/, '').slice(0, 8000);
    return { suggestions: text.trim() ? [{ label: text.split(/\r?\n/)[0].slice(0, 80) || 'AI 补全', detail: `${provider.name || provider.type} / ${model}`, apply: text }] : [] };
}
function normalizeAiSettingsInput(currentAi = {}, ai = {}) {
    const currentProviders = Array.isArray(currentAi.providers) ? currentAi.providers : [];
    const partial = arguments.length >= 2 && ai && typeof ai === 'object' ? ai : {};
    const pick = (key, fallback) => Object.prototype.hasOwnProperty.call(partial, key) ? partial[key] : fallback;
    const next = { ...(currentAi || {}), ...(partial || {}) };
    next.enabled = !!pick('enabled', currentAi.enabled);
    next.assistantName = String(pick('assistantName', currentAi.assistantName) || 'Zephyr AI').slice(0, 40);
    next.defaultProviderId = String(pick('defaultProviderId', currentAi.defaultProviderId) || '').slice(0, 120);
    next.defaultModel = String(pick('defaultModel', currentAi.defaultModel) || '').slice(0, 160);
    next.systemPrompt = String(pick('systemPrompt', currentAi.systemPrompt) || '').slice(0, 20000);
    next.defaultSystemPrompt = String(pick('defaultSystemPrompt', currentAi.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT) || DEFAULT_ZEPHYR_SYSTEM_PROMPT).slice(0, 40000);
    const contextIn = { ...(currentAi.context || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'context') ? (partial.context || {}) : {}) };
    next.context = {
        windowTokens: clampNumber(contextIn.windowTokens, 1024, 1000000, 128000),
        maxInputChars: clampNumber(contextIn.maxInputChars, 8000, 1200000, 180000),
        keepMessages: clampNumber(contextIn.keepMessages, 4, 160, 40),
        toolResultChars: clampNumber(contextIn.toolResultChars, 1000, 240000, 60000),
        memoryItems: clampNumber(contextIn.memoryItems, 0, 80, 28),
    };
    next.guidanceVersion = Math.max(1, Number(pick('guidanceVersion', currentAi.guidanceVersion) || 1));
    next.codeCompletionEnabled = pick('codeCompletionEnabled', currentAi.codeCompletionEnabled) !== false;
    const sensitiveIn = { ...(currentAi.sensitive || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'sensitive') ? (partial.sensitive || {}) : {}) };
    next.sensitive = {
        requireConfirmation: sensitiveIn.requireConfirmation !== false,
        autoConfirm: !!sensitiveIn.autoConfirm,
        autoConfirmDelayMs: clampNumber(sensitiveIn.autoConfirmDelayMs, 0, 60000, 2500),
    };
    const permissionsIn = { ...(currentAi.permissions || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'permissions') ? (partial.permissions || {}) : {}) };
    next.permissions = {
        webSearch: permissionsIn.webSearch !== false,
        webFetch: permissionsIn.webFetch !== false,
        browser: permissionsIn.browser !== false,
        remoteExecute: permissionsIn.remoteExecute !== false,
        fileRead: permissionsIn.fileRead !== false,
        fileWrite: permissionsIn.fileWrite !== false,
        codeEdit: permissionsIn.codeEdit !== false,
        memory: permissionsIn.memory !== false,
        env: permissionsIn.env !== false,
    };
    const plannerIn = { ...(currentAi.planner || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'planner') ? (partial.planner || {}) : {}) };
    next.planner = { enabled: plannerIn.enabled !== false, requirePlanBeforeTools: !!plannerIn.requirePlanBeforeTools };
    const memoryIn = { ...(currentAi.memory || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'memory') ? (partial.memory || {}) : {}) };
    next.memory = { enabled: memoryIn.enabled !== false, maxItems: clampNumber(memoryIn.maxItems, 1, 2000, 500) };
    if (Array.isArray(ai.providers)) {
        next.providers = ai.providers.slice(0, 30).map((p) => {
            const old = currentProviders.find((x) => x.id === p.id) || {};
            const rawModels = String(p.models || old.models || '').slice(0, 4000);
            const modelList = rawModels.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
            return {
                id: String(p.id || crypto.randomUUID()).slice(0, 120),
                name: String(p.name || '未命名供应商').slice(0, 80),
                type: ['openai-compatible', 'anthropic', 'gemini'].includes(providerType(p)) ? providerType(p) : 'openai-compatible',
                enabled: p.enabled !== false,
                baseUrl: String(p.baseUrl || '').slice(0, 500),
                apiMode: ['auto', 'chat', 'responses'].includes(String(p.apiMode || old.apiMode || '').toLowerCase()) ? String(p.apiMode || old.apiMode || 'auto').toLowerCase() : 'auto',
                apiKey: p.apiKey === '******' ? (old.apiKey || '') : String(p.apiKey || ''),
                organization: String(p.organization || old.organization || '').slice(0, 200),
                extraHeaders: String(p.extraHeaders || old.extraHeaders || '').slice(0, 4000),
                models: rawModels,
                modelsPending: !modelList.length,
                defaultModel: String(p.defaultModel || old.defaultModel || modelList[0] || '').slice(0, 160),
                options: {
                    temperature: p.options?.temperature ?? old.options?.temperature ?? 0.7,
                    top_p: p.options?.top_p ?? old.options?.top_p ?? 1,
                    max_tokens: p.options?.max_tokens ?? old.options?.max_tokens ?? 4096,
                    max_output_tokens: p.options?.max_output_tokens ?? old.options?.max_output_tokens ?? p.options?.max_tokens ?? old.options?.max_tokens ?? 4096,
                    presence_penalty: p.options?.presence_penalty ?? old.options?.presence_penalty ?? 0,
                    frequency_penalty: p.options?.frequency_penalty ?? old.options?.frequency_penalty ?? 0,
                    reasoning_effort: String(p.options?.reasoning_effort ?? old.options?.reasoning_effort ?? ''),
                    response_format: String(p.options?.response_format ?? old.options?.response_format ?? ''),
                    use_previous_response_id: !!(p.options?.use_previous_response_id ?? old.options?.use_previous_response_id ?? false),
                    context: {
                        windowTokens: clampNumber(p.options?.context?.windowTokens ?? old.options?.context?.windowTokens ?? next.context.windowTokens, 1024, 1000000, next.context.windowTokens),
                        maxInputChars: clampNumber(p.options?.context?.maxInputChars ?? old.options?.context?.maxInputChars ?? next.context.maxInputChars, 8000, 1200000, next.context.maxInputChars),
                        keepMessages: clampNumber(p.options?.context?.keepMessages ?? old.options?.context?.keepMessages ?? next.context.keepMessages, 4, 160, next.context.keepMessages),
                        toolResultChars: clampNumber(p.options?.context?.toolResultChars ?? old.options?.context?.toolResultChars ?? next.context.toolResultChars, 1000, 240000, next.context.toolResultChars),
                    },
                    extraJson: String(p.options?.extraJson ?? old.options?.extraJson ?? '').slice(0, 12000),
                },
            };
        });
        if (!next.defaultProviderId && next.providers.length) next.defaultProviderId = next.providers[0].id;
        if (!next.defaultModel) {
            const defaultProvider = next.providers.find((p) => p.id === next.defaultProviderId) || next.providers[0];
            next.defaultModel = defaultProvider?.defaultModel || aiModelNames(defaultProvider)[0] || '';
        }
    }
    if (Array.isArray(ai.skills)) {
        next.skills = mergeZephyrDefaultSkills(ai.skills.slice(0, 200).map((s) => ({
            id: String(s.id || crypto.randomUUID()).slice(0, 120),
            name: String(s.name || '').slice(0, 80),
            description: String(s.description || '').slice(0, 500),
            prompt: String(s.prompt || '').slice(0, 30000),
            enabled: s.enabled !== false,
            updatedAt: Number(s.updatedAt || Date.now()),
        })).filter((s) => s.name || s.prompt)).slice(0, 200);
    } else {
        next.skills = mergeZephyrDefaultSkills(next.skills || []).slice(0, 200);
    }
    if (Array.isArray(ai.memories)) {
        next.memories = ai.memories.slice(0, 2000).map((m) => ({
            id: String(m.id || crypto.randomUUID()).slice(0, 120),
            title: String(m.title || m.key || 'Memory').slice(0, 120),
            content: String(m.content || '').slice(0, 20000),
            scope: String(m.scope || 'global').slice(0, 80),
            project: String(m.project || '').slice(0, 120),
            projects: uniqueStrings([m.project, ...stringList(m.projects)]).slice(0, 20),
            tags: stringList(m.tags).slice(0, 30),
            connectionIds: stringList(m.connectionIds).slice(0, 50),
            enabled: m.enabled !== false,
            createdAt: Number(m.createdAt || Date.now()),
            updatedAt: Number(m.updatedAt || Date.now()),
        })).filter((m) => m.content.trim()).slice(0, next.memory.maxItems);
    }
    const currentEnvVars = Array.isArray(currentAi.envVars) ? currentAi.envVars : [];
    if (Array.isArray(ai.envVars)) {
        next.envVars = ai.envVars.slice(0, 200).map((item) => {
            const old = currentEnvVars.find((x) => x.id === item.id || x.name === item.name) || {};
            return {
                id: String(item.id || old.id || crypto.randomUUID()).slice(0, 120),
                name: String(item.name || '').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80),
                description: String(item.description || '').slice(0, 500),
                value: item.value === '******' ? (old.value || '') : String(item.value || ''),
                enabled: item.enabled !== false,
                updatedAt: Number(item.updatedAt || Date.now()),
            };
        }).filter((item) => item.name);
    }
    if (Array.isArray(ai.plans)) {
        next.plans = ai.plans.slice(0, 100).map((plan) => ({
            id: String(plan.id || crypto.randomUUID()).slice(0, 120),
            title: String(plan.title || 'AI 任务计划').slice(0, 160),
            risk: String(plan.risk || '').slice(0, 2000),
            status: String(plan.status || 'planned').slice(0, 40),
            steps: Array.isArray(plan.steps) ? plan.steps.slice(0, 100).map(normalizePlanStep) : [],
            logs: Array.isArray(plan.logs) ? plan.logs.slice(-100).map((log) => ({ time: Number(log.time || Date.now()), text: String(log.text || '').slice(0, 2000) })) : [],
            createdAt: Number(plan.createdAt || Date.now()),
            updatedAt: Number(plan.updatedAt || Date.now()),
        }));
    }
    return next;
}
function safeAiSettings(ai = {}) {
    const copy = JSON.parse(JSON.stringify(ai || {}));
    if (Array.isArray(copy.providers)) copy.providers.forEach((p) => { if (p.apiKey) p.apiKey = '******'; });
    if (Array.isArray(copy.envVars)) copy.envVars.forEach((item) => { item.hasValue = !!item.value; if (item.value) item.value = '******'; });
    return copy;
}
function cleanupPendingActions() {
    const now = Date.now();
    for (const [id, item] of pendingActions.entries()) if (!item || item.expiresAt < now) pendingActions.delete(id);
}
function registerAiRoutes(app, deps) {
    app.get('/api/ai/status', deps.requireAuth, (req, res) => {
        const ai = safeAiSettings(deps.storage.getSettings().ai || {});
        res.json({ ai, pending: pendingActions.size });
    });

    app.get('/api/ai/browser/screenshots/:name', deps.requireAuth, (req, res) => {
        const name = path.basename(String(req.params.name || ''));
        if (!/^[A-Za-z0-9_.-]+\.png$/.test(name)) return res.status(400).end('bad screenshot name');
        const file = path.join(SHOT_DIR, name);
        if (!fs.existsSync(file)) return res.status(404).end('not found');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(file);
    });

    app.post('/api/ai/models', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            const providerId = String(req.body?.providerId || '').trim();
            const provider = providerId
                ? (Array.isArray(ai.providers) ? ai.providers : []).find((p) => p.id === providerId)
                : req.body?.provider;
            if (!provider) return res.status(404).json({ error: '模型供应商不存在' });
            const models = await listProviderModels(provider);
            res.json({ ok: true, models: models.slice(0, 300) });
        } catch (err) { res.status(400).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/chat', deps.requireAuth, async (req, res) => {
        const abortController = new AbortController();
        const abortRequest = () => {
            if (res.writableEnded) return;
            abortController.abort();
        };
        req.on('aborted', abortRequest);
        res.on('close', abortRequest);
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用，请先到设置中开启' });
            const { provider, model } = selectProvider(ai, req.body || {});
            const context = normalizeAiContext(req.body?.context || {});
            const limits = normalizeContextLimits(ai, provider);
            const baseMessages = convertMessagesForProvider(req.body?.messages || [], buildSystemPrompt(ai, context, limits), limits);
            const tools = providerSupportsTools(provider) ? toolDefinitions(ai) : [];
            let messages = baseMessages;
            const toolResults = [];
            for (let step = 0; step < OPENAI_TOOL_LIMIT; step += 1) {
                throwIfAborted(abortController.signal);
                const message = await callProvider(provider, model, messages, req.body?.options || {}, tools, abortController.signal);
                throwIfAborted(abortController.signal);
                const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(parseToolCall).filter((c) => c.name) : [];
                if (!calls.length) {
                    deps.addActivity?.(`AI 助理对话：${provider.name || provider.type}/${model}`);
                    return res.json({ ok: true, message: { role: 'assistant', content: message.content || '' }, toolResults, provider: { id: provider.id, name: provider.name, type: provider.type }, model });
                }
                messages = [...messages, { role: 'assistant', content: message.content || '', tool_calls: message.tool_calls, response_id: message.response_id || '' }];
                for (const call of calls) {
                    throwIfAborted(abortController.signal);
                    const startedAt = Date.now();
                    const result = await executeAiTool(call.name, call.args, { req, context, responseMode: openAiApiMode(provider), signal: abortController.signal }, deps);
                    throwIfAborted(abortController.signal);
                    const endedAt = Date.now();
                    if (result?.confirmationRequired) {
                        return res.json({ ok: true, message: { role: 'assistant', content: message.content || '需要用户确认后继续执行。' }, confirmationRequired: true, confirmation: result.confirmation, toolResults });
                    }
                    toolResults.push({ tool: call.name, args: publicToolArgs(call.name, call.args), result, status: 'success', startedAt, endedAt, durationMs: endedAt - startedAt });
                    messages.push(toolResultMessage(call, result, openAiApiMode(provider), limits));
                }
            }
            res.json({ ok: true, message: { role: 'assistant', content: '已达到工具调用轮次上限，请根据上方工具结果继续。' }, toolResults });
        } catch (err) {
            if (err?.name === 'AbortError' || abortController.signal.aborted) {
                console.info('[ai-agent] chat aborted by client');
                if (!res.headersSent && !res.destroyed && !res.writableEnded) return res.status(499).json({ error: 'AI 请求已停止' });
                return;
            }
            console.error('[ai-agent] chat failed:', err);
            res.status(400).json({ error: publicError(err) });
        } finally {
            req.off?.('aborted', abortRequest);
            res.off?.('close', abortRequest);
        }
    });

    app.post('/api/ai/providers/:id/open', deps.requireAuth, async (req, res) => {
        try {
            if (typeof deps.verifySensitiveAccess !== 'function') return res.status(403).json({ error: '敏感信息验证不可用' });
            const auth = deps.verifySensitiveAccess(req, req.body?.secret);
            const ai = deps.storage.getSettings().ai || {};
            const provider = (Array.isArray(ai.providers) ? ai.providers : []).find((p) => p.id === req.params.id);
            if (!provider) return res.status(404).json({ error: '模型供应商不存在' });
            deps.addActivity?.(`查看 AI Provider API Key：${provider.name || provider.id}`);
            console.info('[ai-secret-open] reveal provider api key', { providerId: provider.id, name: provider.name, hasApiKey: !!provider.apiKey, authMethod: auth.method });
            res.json({ providerId: provider.id, apiKey: provider.apiKey || '', hasApiKey: !!provider.apiKey });
        } catch (err) { res.status(403).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/tools/run', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用' });
            const result = await executeAiTool(String(req.body?.tool || ''), req.body?.args || {}, { req, context: req.body?.context || {} }, deps);
            res.json({ ok: true, result });
        } catch (err) { res.status(400).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/confirm/:id', deps.requireAuth, async (req, res) => {
        const abortController = new AbortController();
        const abortRequest = () => {
            if (res.writableEnded) return;
            abortController.abort();
        };
        req.on('aborted', abortRequest);
        res.on('close', abortRequest);
        try {
            cleanupPendingActions();
            const item = pendingActions.get(req.params.id);
            if (!item || item.username !== req.session.username) return res.status(404).json({ error: '确认请求不存在或已过期' });
            pendingActions.delete(req.params.id);
            if (req.body?.approve === false) return res.json({ ok: true, cancelled: true });
            const startedAt = Date.now();
            throwIfAborted(abortController.signal);
            const result = await executeAiTool(item.toolName, item.rawArgs || item.args || {}, { req, confirmed: true, context: item.context || {}, signal: abortController.signal }, deps);
            throwIfAborted(abortController.signal);
            const endedAt = Date.now();
            res.json({ ok: true, toolName: item.toolName, args: publicToolArgs(item.toolName, item.rawArgs || item.args || {}), result, status: 'success', startedAt, endedAt, durationMs: endedAt - startedAt });
        } catch (err) {
            if (err?.name === 'AbortError' || abortController.signal.aborted) {
                console.info('[ai-agent] confirmed action aborted by client');
                if (!res.headersSent && !res.destroyed && !res.writableEnded) return res.status(499).json({ error: 'AI 请求已停止' });
                return;
            }
            res.status(400).json({ error: publicError(err) });
        } finally {
            req.off?.('aborted', abortRequest);
            res.off?.('close', abortRequest);
        }
    });

    app.post('/api/ai/complete', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled || ai.codeCompletionEnabled === false || ai.permissions?.codeEdit === false) return res.json({ suggestions: [] });
            res.json(await completeWithProvider(ai, req.body || {}));
        } catch (err) {
            console.warn('[ai-agent] completion failed:', err.message);
            res.json({ suggestions: [], error: publicError(err) });
        }
    });
}

module.exports = { registerAiRoutes, normalizeAiSettingsInput, safeAiSettings };
