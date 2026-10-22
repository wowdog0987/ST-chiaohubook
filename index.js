// 巧虎書 Chiaohu Book
// 手動選樓層產生大綱、勾選大綱產生整合，寫入世界書。
// 設計原則：
// - 直接讀聊天紀錄（含已隱藏樓層），不呼叫 /hide /unhide，不影響 HORAE。
// - 每條大綱記錄所屬聊天檔，建議樓層與重疊提示只看目前聊天，搬窗不會打架。
// - 不鎖「下一個要從哪層開始」，樓層隨意填；重疊只提醒不阻擋。

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import {
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    world_names,
    METADATA_KEY,
    reloadEditor,
} from '../../../world-info.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { DEFAULT_OUTLINE_PROMPT, DEFAULT_INTEGRATION_PROMPT } from './prompts.js';

const MODULE = 'chiaohubook';
const LOG = '[巧虎書]';
const NEW_BOOK = '__chb_new__';
const RESULT_REGENERATE = 2;
const RESULT_RETRY = 3;
const RESULT_SPLIT = 4;
const RESULT_SKIP = 5;

// 提示詞存空字串 = 跟隨預設，之後更新預設版本會自動生效；只有手動改過才存內容。
const DEFAULT_PROMPTS = Object.freeze({
    outlinePrompt: DEFAULT_OUTLINE_PROMPT,
    integrationPrompt: DEFAULT_INTEGRATION_PROMPT,
});

// 舊版預設提示詞的指紋。存的內容跟舊預設一樣，代表使用者沒改過，自動改回跟隨預設。
const LEGACY_PROMPT_HASHES = Object.freeze({
    outlinePrompt: ['58716a78', '289e9611'],      // v0.1.0, v0.2.1
    integrationPrompt: ['c2d07f21', '2d374697', 'aa83add0'],  // v0.1.0, v0.2.1, v0.2.2
});

function promptHash(text) {
    let x = 5381;
    for (const c of String(text).replace(/\s+/g, '')) x = ((x * 33) ^ c.codePointAt(0)) >>> 0;
    return x.toString(16);
}

function effectivePrompt(key) {
    return settings()[key] || DEFAULT_PROMPTS[key];
}

const DEFAULTS = Object.freeze({
    outlinePrompt: '',
    integrationPrompt: '',
    outlineProfileId: '',      // '' = 目前酒館 API
    integrationProfileId: '',
    maxTokens: 10000,
    temperature: '',           // 空白 = 使用連線設定檔的預設
    previewBeforeSave: true,
    includeHidden: true,
    horaeTime: true,           // 從 HORAE 資料插入遊戲日期時間
    horaeLocation: true,       // 從 HORAE 資料插入地點
    splitMode: 'date',         // date = 依 HORAE 日期拆段、token = 依 Token 上限拆段
    splitTokenLimit: 6000,     // 單段建議上限；超過時提醒或拆段
    stripPatterns: '<think>[\\s\\S]*?</think>\n<horae[a-z]*>[\\s\\S]*?</horae[a-z]*>',
    contextOutlineCount: 0,
    includePrevIntegration: false,
    lorebookNameTemplate: '{{char}} 大綱書',
    entryMode: 'link',         // link = 關鍵字 + 向量（同記憶書預設）、green = 只用關鍵字、blue = 常駐
    entryPosition: 0,
    entryDepth: 4,
    integrationOrder: 100,
    lastRaw: '',
});

// ---------- 設定 ----------

function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (s[key] === undefined) s[key] = value;
    }
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
        if (!s[key]) continue;
        const hash = promptHash(s[key]);
        if (hash === promptHash(DEFAULT_PROMPTS[key]) || LEGACY_PROMPT_HASHES[key].includes(hash)) {
            s[key] = '';
            saveSettingsDebounced();
        }
    }
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

// ---------- 小工具 ----------

const pad = (n, width) => String(n).padStart(width, '0');

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toInt(value) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(n) ? n : null;
}

function normalizeKeywords(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、\n]/);
    return [...new Set(list.map(k => String(k ?? '').trim()).filter(Boolean))];
}

function sanitizeTitle(title) {
    return String(title ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function getProfiles() {
    try {
        return getContext().ConnectionManagerRequestService.getSupportedProfiles() || [];
    } catch {
        return [];
    }
}

function currentChatId() {
    try {
        return String(getContext().getCurrentChatId() ?? '');
    } catch {
        return '';
    }
}

function lastMessageId() {
    const chat = getContext().chat || [];
    return chat.length - 1;
}

// ---------- 世界書條目分類 ----------

function parseTitleNo(title) {
    const m = String(title ?? '').match(/\[[^\]]*?(\d+)\s*\]/);
    return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * 判斷條目類型。巧虎書條目用 chb_* 欄位；舊記憶書條目（stmemorybooks）也一併讀取。
 */
function classifyEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.chb_type === 'outline') {
        return { kind: 'outline', no: toInt(entry.chb_no), start: toInt(entry.chb_start), end: toInt(entry.chb_end), chatId: entry.chb_chatId ?? null, legacy: false };
    }
    if (entry.chb_type === 'integration') {
        return { kind: 'integration', no: toInt(entry.chb_no), sources: (entry.chb_sources || []).map(String), legacy: false };
    }
    if (entry.stmemorybooks === true) {
        if (entry.stmbSummary === true || entry.stmbArc === true) {
            return { kind: 'integration', no: parseTitleNo(entry.comment), sources: (entry.stmbSourceEntryUids || []).map(String), legacy: true };
        }
        return { kind: 'outline', no: parseTitleNo(entry.comment), start: toInt(entry.STMB_start), end: toInt(entry.STMB_end), chatId: entry.STMB_chatId ?? null, legacy: true };
    }
    return null;
}

function listItems(bookData) {
    const items = [];
    for (const entry of Object.values(bookData?.entries || {})) {
        const info = classifyEntry(entry);
        if (!info) continue;
        items.push({
            ...info,
            uid: String(entry.uid),
            title: String(entry.comment ?? ''),
            content: String(entry.content ?? ''),
            disabled: !!entry.disable,
            disabledBy: entry.chb_disabledBy ?? entry.disabledBySummaryId ?? null,
        });
    }
    const sortKey = item => (item.no ?? Number.MAX_SAFE_INTEGER);
    items.sort((a, b) => sortKey(a) - sortKey(b) || (a.start ?? 0) - (b.start ?? 0));
    return items;
}

function nextNo(items, kind) {
    const nos = items.filter(i => i.kind === kind && Number.isFinite(i.no)).map(i => i.no);
    return nos.length ? Math.max(...nos) + 1 : 1;
}

function itemId(item) {
    return Number.isFinite(item.no) ? pad(item.no, 3) : `uid${item.uid}`;
}

function formatOutlineTitle(no, start, end, title) {
    return `[大綱 ${pad(no, 3)}] ${start}-${end}層 - ${sanitizeTitle(title) || '未命名'}`;
}

function formatSourceList(sourceItems) {
    const nos = sourceItems.map(i => i.no).filter(Number.isFinite).sort((a, b) => a - b);
    const others = sourceItems.filter(i => !Number.isFinite(i.no)).map(i => `uid${i.uid}`);
    let text = '';
    if (nos.length) {
        const contiguous = nos.every((n, idx) => idx === 0 || n === nos[idx - 1] + 1);
        text = contiguous && nos.length > 1
            ? `${pad(nos[0], 3)}-${pad(nos[nos.length - 1], 3)}`
            : nos.map(n => pad(n, 3)).join(',');
    }
    if (others.length) text = [text, ...others].filter(Boolean).join(',');
    return text;
}

function formatIntegrationTitle(no, sourceItems, title) {
    return `[整合 ${pad(no, 2)}] 大綱${formatSourceList(sourceItems)} - ${sanitizeTitle(title) || '未命名'}`;
}

// ---------- 世界書存取 ----------

function boundBook() {
    return getContext().chatMetadata?.[METADATA_KEY] || '';
}

function allBookNames() {
    return Array.isArray(world_names) ? [...world_names] : [];
}

function makeBookName() {
    const ctx = getContext();
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
    const name = String(settings().lorebookNameTemplate || DEFAULTS.lorebookNameTemplate)
        .replace(/\{\{\s*char\s*\}\}/gi, ctx.name2 || 'char')
        .replace(/\{\{\s*user\s*\}\}/gi, ctx.name1 || 'user')
        .replace(/\{\{\s*chat\s*\}\}/gi, currentChatId())
        .replace(/\{\{\s*date\s*\}\}/gi, date)
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim();
    return name || '大綱書';
}

/** 取得要寫入的世界書名稱；選「新建」時建立並綁定，選既有書而聊天尚未綁定時順便綁定。 */
async function resolveBook(choice) {
    const ctx = getContext();
    if (choice && choice !== NEW_BOOK) {
        if (!boundBook()) {
            ctx.chatMetadata[METADATA_KEY] = choice;
            await ctx.saveMetadata();
            toastr.info(`已將「${choice}」綁定到目前聊天`, '巧虎書');
        }
        return choice;
    }
    const base = makeBookName();
    const names = allBookNames();
    let name = base;
    for (let i = 2; names.includes(name); i++) name = `${base} (${i})`;
    const created = await createNewWorldInfo(name);
    if (!created) throw new Error(`建立世界書「${name}」失敗`);
    ctx.chatMetadata[METADATA_KEY] = name;
    await ctx.saveMetadata();
    toastr.success(`已建立並綁定世界書「${name}」`, '巧虎書');
    return name;
}

async function loadBook(name) {
    if (!name || name === NEW_BOOK) return null;
    const data = await loadWorldInfo(name);
    if (!data || typeof data.entries !== 'object') throw new Error(`讀不到世界書「${name}」`);
    return data;
}

function applyEntrySettings(entry) {
    const s = settings();
    switch (s.entryMode) {
        case 'blue':
            entry.constant = true;
            entry.vectorized = false;
            break;
        case 'green':
            entry.constant = false;
            entry.vectorized = false;
            break;
        default:
            entry.constant = false;
            entry.vectorized = true;
    }
    entry.position = Number(s.entryPosition) || 0;
    entry.depth = Number.isFinite(Number(s.entryDepth)) ? Number(s.entryDepth) : 4;
    entry.selective = true;
    entry.addMemo = true;
    entry.disable = false;
}

async function saveBook(name, data) {
    await saveWorldInfo(name, data, true);
    try {
        reloadEditor(name);
    } catch (e) {
        console.debug(LOG, 'reloadEditor 失敗', e);
    }
}

async function writeOutline(bookName, { start, end, title, content, keywords, chatId, no }) {
    const data = await loadBook(bookName);
    const items = listItems(data);
    const finalNo = Number.isFinite(no) && no > 0 ? no : nextNo(items, 'outline');
    const entry = createWorldInfoEntry(bookName, data);
    if (!entry) throw new Error('建立世界書條目失敗');
    applyEntrySettings(entry);
    entry.comment = formatOutlineTitle(finalNo, start, end, title);
    entry.content = String(content ?? '').trim();
    entry.key = normalizeKeywords(keywords);
    entry.order = Math.min(9999, Math.max(0, finalNo));
    entry.displayIndex = finalNo;
    entry.chb_type = 'outline';
    entry.chb_no = finalNo;
    entry.chb_start = start;
    entry.chb_end = end;
    entry.chb_chatId = chatId;
    entry.chb_created = new Date().toISOString();
    await saveBook(bookName, data);
    return entry.comment;
}

const clampOrder = n => Math.min(9999, Math.max(0, Math.trunc(n)));

/**
 * 整合的順序值 = 來源大綱中最小的順序值，讓整合插在它涵蓋的時間位置。
 * ST 依順序值由小到大放進提示詞，順序值相同時會反過來排，所以不能全部給同一個值。
 */
function integrationOrder(data, sourceUids) {
    const orders = sourceUids
        .map(uid => Number(data.entries[uid]?.order))
        .filter(Number.isFinite);
    return orders.length ? clampOrder(Math.min(...orders)) : clampOrder(Number(settings().integrationOrder) || 100);
}

/** 把整本書的巧虎書條目依時間重排順序值：大綱 = 編號，整合 = 來源大綱最小編號。回傳改了幾條。 */
async function reorderBook(bookName) {
    const data = await loadBook(bookName);
    let changed = 0;
    const entries = Object.values(data.entries);
    for (const entry of entries) {
        if (entry.chb_type !== 'outline' || !Number.isFinite(Number(entry.chb_no))) continue;
        const order = clampOrder(Number(entry.chb_no));
        if (entry.order !== order) { entry.order = order; changed++; }
    }
    for (const entry of entries) {
        if (entry.chb_type !== 'integration') continue;
        const order = integrationOrder(data, (entry.chb_sources || []).map(String));
        if (entry.order !== order) { entry.order = order; changed++; }
    }
    if (changed) await saveBook(bookName, data);
    return changed;
}

/**
 * 寫入整合條目，並停用（不刪除）被整合的大綱。
 * @param {{title:string, content:string, keywords:string[], sourceUids:string[]}[]} summaries
 */
async function writeIntegrations(bookName, summaries) {
    const data = await loadBook(bookName);
    const titles = [];
    for (const summary of summaries) {
        const items = listItems(data);
        const sourceItems = items.filter(i => summary.sourceUids.includes(i.uid));
        const no = nextNo(items, 'integration');
        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) throw new Error('建立世界書條目失敗');
        applyEntrySettings(entry);
        entry.comment = formatIntegrationTitle(no, sourceItems, summary.title);
        entry.content = String(summary.content ?? '').trim();
        entry.key = normalizeKeywords(summary.keywords);
        entry.order = integrationOrder(data, sourceItems.map(i => i.uid));
        entry.displayIndex = no;
        entry.chb_type = 'integration';
        entry.chb_no = no;
        entry.chb_sources = sourceItems.map(i => i.uid);
        entry.chb_sourceTitles = sourceItems.map(i => i.title);
        entry.chb_created = new Date().toISOString();
        for (const item of sourceItems) {
            const source = data.entries[item.uid];
            if (!source) continue;
            source.disable = true;
            source.chb_disabledBy = String(entry.uid);
        }
        titles.push(entry.comment);
    }
    await saveBook(bookName, data);
    return titles;
}

// ---------- 讀取聊天 ----------

function stripRegexes() {
    const list = [];
    for (const line of String(settings().stripPatterns || '').split('\n')) {
        const pattern = line.trim();
        if (!pattern) continue;
        try {
            list.push(new RegExp(pattern, 'gi'));
        } catch (e) {
            console.warn(LOG, '無效的移除規則：', pattern, e);
        }
    }
    return list;
}

function cleanText(text, regexes) {
    let s = String(text ?? '');
    for (const re of regexes) s = s.replace(re, '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * HORAE 會把 <horae> 標籤解析後存在 message.horae_meta。
 * 這裡逐層累積日期、時間、地點，跟 HORAE 的 getLatestState 同樣的規則（有值才覆蓋）。
 */
function applyHoraeMeta(state, message) {
    const meta = message?.horae_meta;
    if (!meta || meta._skipHorae) return;
    if (meta.timestamp?.story_date) state.date = String(meta.timestamp.story_date).trim();
    if (meta.timestamp?.story_time) state.time = String(meta.timestamp.story_time).trim();
    if (meta.scene?.location) state.location = String(meta.scene.location).trim();
}

function horaeMarker(state) {
    const s = settings();
    const parts = [];
    if (s.horaeTime && (state.date || state.time)) parts.push(`時間：${[state.date, state.time].filter(Boolean).join(' ')}`);
    if (s.horaeLocation && state.location) parts.push(`地點：${state.location}`);
    return parts.join('｜');
}

/** 直接從聊天陣列讀取樓層，包含已隱藏（is_system）的樓層，不改動隱藏狀態。 */
function getRangeMessages(start, end) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const includeHidden = !!settings().includeHidden;
    const regexes = stripRegexes();
    const out = [];
    // 起始層之前的最新時間地點，讓第一層也有時間可參考
    const horae = { date: '', time: '', location: '' };
    for (let i = 0; i < Math.min(start, chat.length); i++) applyHoraeMeta(horae, chat[i]);
    let lastMarker = '';
    for (let i = Math.max(0, start); i <= end && i < chat.length; i++) {
        const message = chat[i];
        if (!message) continue;
        applyHoraeMeta(horae, message);
        if (message.is_system && !includeHidden) continue;
        const text = cleanText(message.mes, regexes);
        if (!text) continue;
        const marker = horaeMarker(horae);
        out.push({
            id: i,
            name: message.name || (message.is_user ? ctx.name1 : ctx.name2),
            text,
            hidden: !!message.is_system,
            marker: marker !== lastMarker ? marker : '',
            time: marker,
            date: horae.date,
        });
        lastMarker = marker;
    }
    return out;
}

// ---------- 提示詞 ----------

function buildOutlinePrompt(messages, contextOutlines) {
    const ctx = getContext();
    const lines = [ctx.substituteParams(effectivePrompt('outlinePrompt')), ''];
    if (contextOutlines.length) {
        lines.push('=== 先前場景背景（僅供參考，不要寫進新記憶）===');
        for (const outline of contextOutlines) {
            lines.push(`--- ${outline.title} ---`, outline.content, '');
        }
        lines.push('=== 背景結束，只處理下面的場景 ===', '');
    }
    lines.push('=== 場景逐字稿 ===');
    for (const message of messages) {
        if (message.marker) lines.push(`【${message.marker}】`);
        lines.push(`${message.name}: ${message.text}`);
    }
    lines.push('=== 場景結束 ===');
    return lines.join('\n');
}

function buildIntegrationPrompt(sourceItems, prevIntegration) {
    const ctx = getContext();
    const lines = [ctx.substituteParams(effectivePrompt('integrationPrompt')), ''];
    if (prevIntegration) {
        lines.push('=== 先前的整合（正史，不要改寫，也不要寫進新的整合）===');
        lines.push(prevIntegration.title, prevIntegration.content);
        lines.push('=== 先前的整合結束 ===', '');
    }
    lines.push('=== 大綱 ===');
    for (const item of sourceItems) {
        const id = itemId(item);
        lines.push(`=== 大綱 ID: ${id} ===`);
        lines.push(`標題: ${item.title}`);
        lines.push(`內容: ${item.content}`);
        lines.push(`=== end 大綱 ${id} ===`, '');
    }
    return lines.join('\n');
}

async function countTokens(text) {
    try {
        return await getContext().getTokenCountAsync(text);
    } catch {
        return Math.ceil(String(text).length / 2);
    }
}

// ---------- AI 請求 ----------

async function requestAI(prompt, profileId, signal) {
    const ctx = getContext();
    const s = settings();
    const maxTokens = toInt(s.maxTokens) || DEFAULTS.maxTokens;
    const messages = [{ role: 'user', content: prompt }];
    let text;
    if (profileId) {
        const override = {};
        const temperature = Number.parseFloat(s.temperature);
        if (Number.isFinite(temperature)) override.temperature = temperature;
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            maxTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
            override,
        );
        text = typeof res === 'string' ? res : res?.content;
    } else {
        text = await ctx.generateRaw({ prompt: messages, responseLength: maxTokens });
    }
    text = String(text ?? '').trim();
    if (!text) throw new Error('AI 回應是空的');
    s.lastRaw = text;
    saveSettings();
    return text;
}

// ---------- JSON 解析 ----------

function extractBalanced(s) {
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

/** 把 JSON 字串值裡的真實換行改成 \n（模型常犯的錯）。 */
function escapeNewlinesInStrings(s) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const c of s) {
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            else if (c === '\n') { out += '\\n'; continue; }
            else if (c === '\r') continue;
        } else if (c === '"') {
            inString = true;
        }
        out += c;
    }
    return out;
}

function parseJsonLoose(raw) {
    let s = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const candidate = extractBalanced(s) ?? s;
    const noTrailing = candidate.replace(/,\s*([}\]])/g, '$1');
    for (const attempt of [candidate, noTrailing, escapeNewlinesInStrings(noTrailing)]) {
        try {
            return JSON.parse(attempt);
        } catch { /* 試下一種 */ }
    }
    return null;
}

function fixContent(text) {
    return String(text ?? '').replace(/\\n/g, '\n').trim();
}

function parseOutline(raw) {
    const json = parseJsonLoose(raw);
    const obj = Array.isArray(json) ? json[0] : json;
    const content = obj && (obj.content ?? obj.summary ?? obj.memory_content);
    if (!obj || !content) {
        return { ok: false, title: '', content: String(raw ?? ''), keywords: [] };
    }
    return {
        ok: true,
        title: sanitizeTitle(obj.title),
        content: fixContent(content),
        keywords: normalizeKeywords(obj.keywords),
    };
}

function parseIntegration(raw, sourceItems) {
    const json = parseJsonLoose(raw);
    const idMap = new Map(sourceItems.map(item => [itemId(item), item.uid]));
    const resolveIds = ids => {
        const uids = [];
        for (const id of Array.isArray(ids) ? ids : []) {
            const key = String(id).trim();
            const uid = idMap.get(key) ?? idMap.get(pad(toInt(key) ?? -1, 3));
            if (uid && !uids.includes(uid)) uids.push(uid);
        }
        return uids;
    };
    let list = [];
    if (json && Array.isArray(json.summaries)) list = json.summaries;
    else if (json && (json.summary || json.content)) list = [json];
    const summaries = list
        .filter(item => item && (item.summary || item.content))
        .map(item => {
            const uids = resolveIds(item.member_ids);
            return {
                title: sanitizeTitle(item.title),
                content: fixContent(item.summary ?? item.content),
                keywords: normalizeKeywords(item.keywords),
                // 沒回傳 member_ids 時，視為全部選取的大綱都已整合
                sourceUids: uids.length ? uids : sourceItems.map(i => i.uid),
            };
        });
    const unassigned = Array.isArray(json?.unassigned_items) ? json.unassigned_items : [];
    if (!summaries.length) {
        return {
            ok: false,
            summaries: [{ title: '', content: String(raw ?? ''), keywords: [], sourceUids: sourceItems.map(i => i.uid) }],
            unassigned: [],
        };
    }
    return { ok: true, summaries, unassigned };
}

// ---------- 彈窗 ----------

function collectFields(root) {
    const values = {};
    root.querySelectorAll('[data-field]').forEach(el => {
        values[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return values;
}

async function showForm(html, { okText, cancelText = '取消', buttons = [] }) {
    let values = {};
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: okText,
        cancelButton: cancelText,
        customButtons: buttons,
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: p => {
            values = collectFields(p.content);
            return true;
        },
    });
    const result = await popup.show();
    return { result, values };
}

/** 失敗時詢問是否重試。回傳 true = 重試。 */
async function askRetry(error) {
    const message = esc(error?.message || String(error));
    const { result } = await showForm(
        `<div class="chb-form"><h3>產生失敗</h3><p class="chb-error">${message}</p><p>如果是 429 或暫時性錯誤，可以稍等後重試；也可以改用其他 AI 生成，再用「手動新增」貼上。</p></div>`,
        { okText: false, cancelText: '取消', buttons: [{ text: '重試', result: RESULT_RETRY, classes: ['menu_button'] }] },
    );
    return result === RESULT_RETRY;
}

function outlinePreviewHtml(draft, start, end, no, heading = '大綱預覽') {
    return `
<div class="chb-form">
    <h3>${esc(heading)}</h3>
    ${draft.ok ? '' : '<p class="chb-error">AI 回應不是有效的 JSON，下面是原始內容，請自行整理成大綱再寫入。</p>'}
    <div class="chb-muted">將寫入為：[大綱 ${pad(no, 3)}] ${start}-${end}層 - （標題）</div>
    <label>標題</label>
    <input class="text_pole" data-field="title" value="${esc(draft.title)}">
    <label>關鍵字（逗號分隔）</label>
    <input class="text_pole" data-field="keywords" value="${esc(draft.keywords.join(', '))}">
    <label>內容</label>
    <textarea class="text_pole chb-big" data-field="content" rows="16">${esc(draft.content)}</textarea>
</div>`;
}

function integrationPreviewHtml(parsed, sourceItems) {
    const byUid = new Map(sourceItems.map(i => [i.uid, i]));
    const cards = parsed.summaries.map((summary, idx) => {
        const members = summary.sourceUids.map(uid => byUid.get(uid)).filter(Boolean);
        return `
    <div class="chb-card">
        <div class="chb-muted">第 ${idx + 1} 份 · 來源：大綱${esc(formatSourceList(members))}（寫入後這些大綱會停用、保留）</div>
        <label>標題</label>
        <input class="text_pole" data-field="title_${idx}" value="${esc(summary.title)}">
        <label>關鍵字（逗號分隔）</label>
        <input class="text_pole" data-field="keywords_${idx}" value="${esc(summary.keywords.join(', '))}">
        <label>來源大綱 ID（逗號分隔，可修改）</label>
        <input class="text_pole" data-field="ids_${idx}" value="${esc(members.map(itemId).join(', '))}">
        <label>內容</label>
        <textarea class="text_pole chb-big" data-field="content_${idx}" rows="16">${esc(summary.content)}</textarea>
    </div>`;
    }).join('');
    const unassigned = parsed.unassigned.length
        ? `<div class="chb-warn">AI 認為不適合整合的大綱（不會被停用）：<br>${parsed.unassigned.map(u => esc(`${u.id}：${u.reason ?? ''}`)).join('<br>')}</div>`
        : '';
    return `
<div class="chb-form">
    <h3>整合預覽</h3>
    ${parsed.ok ? '' : '<p class="chb-error">AI 回應不是有效的 JSON，下面是原始內容，請自行整理後再寫入。</p>'}
    ${unassigned}
    ${cards}
</div>`;
}

// ---------- 主面板 ----------

const state = {
    busy: false,
    abort: null,
    bookData: null,
    items: [],
    $root: null,
};

function bookChoice() {
    return state.$root?.find('#chb-book').val() || NEW_BOOK;
}

function bookOptionsHtml() {
    const bound = boundBook();
    const names = allBookNames();
    const options = [];
    if (bound) options.push(`<option value="${esc(bound)}">${esc(bound)}（目前聊天綁定）</option>`);
    options.push(`<option value="${NEW_BOOK}">＋ 新建並綁定（${esc(makeBookName())}）</option>`);
    for (const name of names) {
        if (name !== bound) options.push(`<option value="${esc(name)}">${esc(name)}</option>`);
    }
    return options.join('');
}

function profileOptionsHtml(selected) {
    const options = [`<option value="">目前酒館 API</option>`];
    for (const profile of getProfiles()) {
        const label = `${profile.name}${profile.model ? `（${profile.model}）` : ''}`;
        options.push(`<option value="${esc(profile.id)}" ${profile.id === selected ? 'selected' : ''}>${esc(label)}</option>`);
    }
    return options.join('');
}

function panelHtml() {
    const s = settings();
    return `
<div class="chb-panel">
    <div class="chb-header">
        <b>📖 巧虎書</b>
        <label class="chb-inline">世界書
            <select id="chb-book" class="text_pole">${bookOptionsHtml()}</select>
        </label>
    </div>
    <div class="chb-tabs">
        <button class="menu_button chb-tab active" data-tab="outline">產生大綱</button>
        <button class="menu_button chb-tab" data-tab="manual">手動新增</button>
        <button class="menu_button chb-tab" data-tab="integration">產生整合</button>
        <button class="menu_button chb-tab" data-tab="settings">設定</button>
    </div>

    <section class="chb-page" data-page="outline">
        <div class="chb-muted" id="chb-latest"></div>
        <div class="chb-row">
            <label>起始層 <input id="chb-start" class="text_pole chb-num" type="number" min="0"></label>
            <label>結束層 <input id="chb-end" class="text_pole chb-num" type="number" min="0"></label>
            <button class="menu_button" id="chb-suggest">填入建議</button>
        </div>
        <div id="chb-range-info" class="chb-info"></div>
        <div class="chb-row">
            <label>附上此聊天前面的大綱作為背景 <input id="chb-ctx-count" class="text_pole chb-num" type="number" min="0" value="${esc(s.contextOutlineCount)}"> 條</label>
        </div>
        <div class="chb-muted" id="chb-outline-tokens"></div>
        <div class="chb-row">
            <button class="menu_button chb-primary" id="chb-run-outline">產生大綱</button>
            <button class="menu_button chb-stop" disabled>停止</button>
        </div>
    </section>

    <section class="chb-page" data-page="manual" hidden>
        <div class="chb-muted">把其他 AI 生成的大綱貼進來，格式會跟插件生成的完全一樣，之後也能拿來整合。</div>
        <div class="chb-row">
            <label>起始層 <input id="chb-m-start" class="text_pole chb-num" type="number" min="0"></label>
            <label>結束層 <input id="chb-m-end" class="text_pole chb-num" type="number" min="0"></label>
            <label>編號 <input id="chb-m-no" class="text_pole chb-num" type="number" min="1" placeholder="自動"></label>
        </div>
        <label>標題</label>
        <input id="chb-m-title" class="text_pole">
        <label>關鍵字（逗號分隔）</label>
        <input id="chb-m-keywords" class="text_pole">
        <label>內容（也可以直接貼 AI 回的 JSON，按「解析 JSON」自動拆開）</label>
        <textarea id="chb-m-content" class="text_pole chb-big" rows="12"></textarea>
        <div class="chb-row">
            <button class="menu_button" id="chb-m-parse">解析 JSON</button>
            <button class="menu_button chb-primary" id="chb-m-save">寫入世界書</button>
        </div>
    </section>

    <section class="chb-page" data-page="integration" hidden>
        <div class="chb-row">
            <label class="checkbox_label"><input type="checkbox" id="chb-f-enabled" checked> 只顯示啟用中</label>
            <label class="checkbox_label"><input type="checkbox" id="chb-f-chat"> 只顯示此聊天</label>
            <button class="menu_button" id="chb-refresh">重新整理</button>
            <button class="menu_button" id="chb-reorder" title="大綱順序值＝編號，整合順序值＝來源大綱最小編號，讓 AI 依時間由早到晚讀">依時間重排順序</button>
        </div>
        <div id="chb-list" class="chb-list"></div>
        <div id="chb-selected" class="chb-info"></div>
        <label class="checkbox_label"><input type="checkbox" id="chb-prev-int" ${s.includePrevIntegration ? 'checked' : ''}> 附上最近一份整合作為正史背景</label>
        <div class="chb-muted" id="chb-int-tokens"></div>
        <div class="chb-row">
            <button class="menu_button chb-primary" id="chb-run-int">產生整合</button>
            <button class="menu_button chb-stop" disabled>停止</button>
        </div>
    </section>

    <section class="chb-page" data-page="settings" hidden>
        <h4>API</h4>
        <div class="chb-grid">
            <label>大綱用</label><select class="text_pole" data-setting="outlineProfileId">${profileOptionsHtml(s.outlineProfileId)}</select>
            <label>整合用</label><select class="text_pole" data-setting="integrationProfileId">${profileOptionsHtml(s.integrationProfileId)}</select>
            <label>最大回應 Token</label><input class="text_pole" type="number" data-setting="maxTokens" value="${esc(s.maxTokens)}">
            <label>溫度（空白＝設定檔預設）</label><input class="text_pole" data-setting="temperature" value="${esc(s.temperature)}">
        </div>
        <div class="chb-muted">選連線設定檔時會直接用該設定檔送出，不會切換酒館目前的 API。</div>

        <h4>生成</h4>
        <label class="checkbox_label"><input type="checkbox" data-setting="previewBeforeSave" ${s.previewBeforeSave ? 'checked' : ''}> 生成後先預覽、可編輯再寫入</label>
        <label class="checkbox_label"><input type="checkbox" data-setting="includeHidden" ${s.includeHidden ? 'checked' : ''}> 讀取已隱藏的樓層（不會改動隱藏狀態）</label>
        <label class="checkbox_label"><input type="checkbox" data-setting="horaeTime" ${s.horaeTime ? 'checked' : ''}> 從 HORAE 讀取遊戲日期時間（有變化時插入一行【時間：…】）</label>
        <label class="checkbox_label"><input type="checkbox" data-setting="horaeLocation" ${s.horaeLocation ? 'checked' : ''}> 從 HORAE 讀取地點</label>
        <div class="chb-grid">
            <label>範圍太長時的拆段方式</label>
            <select class="text_pole" data-setting="splitMode">
                <option value="date" ${s.splitMode === 'date' ? 'selected' : ''}>依日期（HORAE 日期一換就拆，一天一篇）</option>
                <option value="token" ${s.splitMode === 'token' ? 'selected' : ''}>依 Token（每段累積到上限就拆）</option>
            </select>
            <label>單段 Token 上限</label><input class="text_pole" type="number" data-setting="splitTokenLimit" value="${esc(s.splitTokenLimit)}">
        </div>
        <div class="chb-muted">依日期時，跨多天會建議拆開；只有一天但超過上限時只提醒，不自動拆。依 Token 時，超過上限才建議拆開。</div>
        <label>送出前從訊息移除的內容（每行一條正則，例如 HORAE 標籤、思考區塊）</label>
        <textarea class="text_pole" rows="3" data-setting="stripPatterns">${esc(s.stripPatterns)}</textarea>

        <h4>世界書條目</h4>
        <div class="chb-grid">
            <label>觸發方式</label>
            <select class="text_pole" data-setting="entryMode">
                <option value="link" ${s.entryMode === 'link' ? 'selected' : ''}>關鍵字 + 向量（同記憶書預設）</option>
                <option value="green" ${s.entryMode === 'green' ? 'selected' : ''}>只用關鍵字（綠燈）</option>
                <option value="blue" ${s.entryMode === 'blue' ? 'selected' : ''}>常駐（藍燈）</option>
            </select>
            <label>插入位置</label>
            <select class="text_pole" data-setting="entryPosition">
                ${[['0', '角色定義之前'], ['1', '角色定義之後'], ['2', '作者註釋之前'], ['3', '作者註釋之後'], ['4', '@深度'], ['5', '範例訊息之前'], ['6', '範例訊息之後']]
                    .map(([v, l]) => `<option value="${v}" ${String(s.entryPosition) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <label>深度（位置選 @深度 時）</label><input class="text_pole" type="number" data-setting="entryDepth" value="${esc(s.entryDepth)}">
            <label>新世界書名稱</label><input class="text_pole" data-setting="lorebookNameTemplate" value="${esc(s.lorebookNameTemplate)}">
        </div>
        <div class="chb-muted">名稱可用 {{char}}、{{user}}、{{chat}}、{{date}}。條目順序值：大綱＝編號，整合＝來源大綱最小編號，放進提示詞時會依時間由早到晚排列。</div>

        <h4>提示詞</h4>
        <label>大綱提示詞</label>
        <textarea class="text_pole chb-big" rows="10" data-setting="outlinePrompt">${esc(effectivePrompt('outlinePrompt'))}</textarea>
        <button class="menu_button" data-reset="outlinePrompt">還原預設大綱提示詞</button> <span class="chb-muted" data-prompt-state="outlinePrompt">${s.outlinePrompt ? '已自訂' : '使用預設（插件更新時自動套用新版）'}</span>
        <label>整合提示詞</label>
        <textarea class="text_pole chb-big" rows="10" data-setting="integrationPrompt">${esc(effectivePrompt('integrationPrompt'))}</textarea>
        <button class="menu_button" data-reset="integrationPrompt">還原預設整合提示詞</button> <span class="chb-muted" data-prompt-state="integrationPrompt">${s.integrationPrompt ? '已自訂' : '使用預設（插件更新時自動套用新版）'}</span>

        <h4>除錯</h4>
        <button class="menu_button" id="chb-last-raw">查看上次 AI 原始回應</button>
    </section>
</div>`;
}

function setBusy(busy) {
    state.busy = busy;
    const $root = state.$root;
    if (!$root) return;
    $root.find('#chb-run-outline, #chb-run-int, #chb-m-save').prop('disabled', busy);
    $root.find('.chb-stop').prop('disabled', !busy);
    $root.find('#chb-run-outline').text(busy ? '產生中…' : '產生大綱');
    $root.find('#chb-run-int').text(busy ? '產生中…' : '產生整合');
}

async function refreshBook() {
    try {
        state.bookData = await loadBook(bookChoice());
    } catch (e) {
        console.warn(LOG, e);
        state.bookData = null;
        toastr.warning(e.message, '巧虎書');
    }
    state.items = listItems(state.bookData);
    updateLatest();
    updateRangeInfo();
    renderList();
}

function chatOutlines() {
    const chatId = currentChatId();
    return state.items.filter(i => i.kind === 'outline' && i.chatId && String(i.chatId) === chatId);
}

function suggestRange() {
    const last = lastMessageId();
    const ends = chatOutlines().map(i => i.end).filter(Number.isFinite);
    const start = ends.length ? Math.min(Math.max(...ends) + 1, Math.max(last, 0)) : 0;
    return { start, end: Math.max(last, start) };
}

function updateLatest() {
    const $root = state.$root;
    if (!$root) return;
    const last = lastMessageId();
    const count = chatOutlines().length;
    $root.find('#chb-latest').text(last < 0
        ? '目前沒有開啟聊天'
        : `最新樓層 #${last}（樓層號碼同 ST 訊息上的 #）· 這個聊天已有 ${count} 條大綱 · 下一條編號 ${pad(nextNo(state.items, 'outline'), 3)}`);
}

function overlapsInChat(start, end) {
    return chatOutlines().filter(i => Number.isFinite(i.start) && Number.isFinite(i.end) && start <= i.end && end >= i.start);
}

function readRange(startSel, endSel) {
    const $root = state.$root;
    const start = toInt($root.find(startSel).val());
    const end = toInt($root.find(endSel).val());
    const last = lastMessageId();
    if (start === null || end === null) return { error: '請填起始層和結束層' };
    if (start < 0 || end < start) return { error: '起始層要 ≥ 0，且結束層不能小於起始層' };
    if (last >= 0 && end > last) return { error: `結束層超過最新樓層 #${last}` };
    return { start, end };
}

function contextOutlinesFor(start) {
    const count = Math.max(0, toInt(state.$root?.find('#chb-ctx-count').val()) || 0);
    if (!count) return [];
    return chatOutlines()
        .filter(i => Number.isFinite(i.end) && i.end < start)
        .sort((a, b) => a.end - b.end)
        .slice(-count);
}

let tokenTimer = null;
function updateRangeInfo() {
    const $root = state.$root;
    if (!$root) return;
    const $info = $root.find('#chb-range-info');
    const range = readRange('#chb-start', '#chb-end');
    if (range.error) {
        $info.html(`<span class="chb-muted">${esc(range.error)}</span>`);
        $root.find('#chb-outline-tokens').text('');
        return;
    }
    const messages = getRangeMessages(range.start, range.end);
    const hidden = messages.filter(m => m.hidden).length;
    const preview = m => m ? `#${m.id} ${esc(m.name)}：${esc(m.text.slice(0, 60))}${m.text.length > 60 ? '…' : ''}` : '';
    const overlaps = overlapsInChat(range.start, range.end);
    const html = [
        `範圍內有 ${messages.length} 層有內容${hidden ? `，其中 ${hidden} 層已隱藏（仍會讀取）` : ''}`,
        messages.length && (settings().horaeTime || settings().horaeLocation)
            ? `<div class="chb-muted">HORAE：${esc(messages[0].time || '讀不到時間')}${messages.length > 1 && messages[messages.length - 1].time !== messages[0].time ? ` → ${esc(messages[messages.length - 1].time)}` : ''}</div>`
            : '',
        messages.length ? `<div class="chb-quote">開頭 ${preview(messages[0])}</div>` : '',
        messages.length > 1 ? `<div class="chb-quote">結尾 ${preview(messages[messages.length - 1])}</div>` : '',
        overlaps.length ? `<div class="chb-warn">⚠ 和這個聊天已有的大綱重疊：${overlaps.map(o => esc(o.title)).join('、')}（仍可生成）</div>` : '',
    ].join('');
    $info.html(html);

    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(async () => {
        if (!messages.length) return;
        const prompt = buildOutlinePrompt(messages, contextOutlinesFor(range.start));
        const tokens = await countTokens(prompt);
        $root.find('#chb-outline-tokens').text(`預估送出 ≈ ${tokens} tokens（不含回應）`);
    }, 500);
}

function renderList() {
    const $root = state.$root;
    if (!$root) return;
    const onlyEnabled = $root.find('#chb-f-enabled').prop('checked');
    const onlyChat = $root.find('#chb-f-chat').prop('checked');
    const chatId = currentChatId();
    const checked = new Set($root.find('.chb-pick:checked').map((_, el) => el.value).get());
    const outlines = state.items.filter(i => i.kind === 'outline')
        .filter(i => !onlyEnabled || !i.disabled)
        .filter(i => !onlyChat || String(i.chatId ?? '') === chatId);
    if (!state.bookData) {
        $root.find('#chb-list').html('<div class="chb-muted">尚未選擇世界書。</div>');
    } else if (!outlines.length) {
        $root.find('#chb-list').html('<div class="chb-muted">沒有符合條件的大綱。</div>');
    } else {
        $root.find('#chb-list').html(outlines.map(i => {
            const tags = [
                i.legacy ? '<span class="chb-tag">記憶書</span>' : '',
                String(i.chatId ?? '') === chatId ? '<span class="chb-tag">此聊天</span>' : '',
                i.disabled ? '<span class="chb-tag chb-tag-off">已停用</span>' : '',
            ].join('');
            return `<label class="chb-item"><input type="checkbox" class="chb-pick" value="${esc(i.uid)}" ${checked.has(i.uid) ? 'checked' : ''}> <span>${esc(i.title)}</span> ${tags}</label>`;
        }).join(''));
    }
    updateSelected();
}

function selectedItems() {
    const uids = new Set(state.$root.find('.chb-pick:checked').map((_, el) => el.value).get());
    return state.items.filter(i => uids.has(i.uid));
}

function prevIntegration() {
    if (!state.$root.find('#chb-prev-int').prop('checked')) return null;
    const list = state.items.filter(i => i.kind === 'integration' && !i.disabled);
    return list.length ? list[list.length - 1] : null;
}

let intTokenTimer = null;
function updateSelected() {
    const $root = state.$root;
    const items = selectedItems();
    $root.find('#chb-selected').text(items.length
        ? `已選 ${items.length} 條：大綱${formatSourceList(items)} → 將寫成 [整合 ${pad(nextNo(state.items, 'integration'), 2)}]`
        : '勾選要整合的大綱');
    clearTimeout(intTokenTimer);
    if (!items.length) {
        $root.find('#chb-int-tokens').text('');
        return;
    }
    intTokenTimer = setTimeout(async () => {
        const tokens = await countTokens(buildIntegrationPrompt(items, prevIntegration()));
        $root.find('#chb-int-tokens').text(`預估送出 ≈ ${tokens} tokens（不含回應）`);
    }, 400);
}

// ---------- 動作 ----------

async function runWithRetry(fn) {
    for (;;) {
        state.abort = new AbortController();
        setBusy(true);
        try {
            return await fn(state.abort.signal);
        } catch (error) {
            if (state.abort?.signal.aborted) {
                toastr.info('已停止', '巧虎書');
                return null;
            }
            console.error(LOG, error);
            setBusy(false);
            if (!(await askRetry(error))) return null;
        } finally {
            setBusy(false);
            state.abort = null;
        }
    }
}

// ---------- 拆段 ----------

/**
 * 在本機規劃拆段，不呼叫 AI、不花 Token。
 * - date：HORAE 日期一換就拆；沒有日期的樓層併入前一段（開頭沒有日期則併入第一個有日期的段）。
 * - token：每段累積到上限就拆。
 * 段落範圍連續覆蓋 start-end，所以沒有內容的樓層也不會漏掉。
 */
async function planSegments(start, end, messages) {
    const s = settings();
    const limit = Math.max(500, toInt(s.splitTokenLimit) || DEFAULTS.splitTokenLimit);
    const overhead = await countTokens(buildOutlinePrompt([], contextOutlinesFor(start)));
    const costs = [];
    for (const m of messages) costs.push(await countTokens(`${m.marker ? `【${m.marker}】\n` : ''}${m.name}: ${m.text}`));
    const total = overhead + costs.reduce((a, b) => a + b, 0);

    const groups = [];
    if (s.splitMode === 'token') {
        let current = null;
        messages.forEach((m, idx) => {
            if (!current || (current.tokens + costs[idx] > limit && current.count > 0)) {
                current = { firstId: m.id, date: m.date, tokens: overhead, count: 0 };
                groups.push(current);
            }
            current.tokens += costs[idx];
            current.count++;
        });
    } else {
        let current = null;
        messages.forEach((m, idx) => {
            if (current && m.date && current.date && m.date !== current.date) current = null;
            if (!current) {
                current = { firstId: m.id, date: m.date, tokens: overhead, count: 0 };
                groups.push(current);
            }
            if (!current.date && m.date) current.date = m.date;
            current.tokens += costs[idx];
            current.count++;
        });
    }

    const segments = groups.map((g, idx) => ({
        start: idx === 0 ? start : g.firstId,
        end: idx < groups.length - 1 ? groups[idx + 1].firstId - 1 : end,
        date: g.date,
        tokens: g.tokens,
    }));
    const hasDates = messages.some(m => m.date);
    return { segments, total, limit, hasDates };
}

/** 回傳 'whole'（一次產生）、'split'（照建議拆開）或 null（取消）。 */
async function askSplit(plan, range) {
    const s = settings();
    const { segments, total, limit } = plan;
    if (segments.length <= 1) {
        if (total <= limit) return 'whole';
        const hint = s.splitMode === 'date' && !plan.hasDates
            ? '這段讀不到 HORAE 日期，沒辦法依日期拆段。可以縮小範圍，或在設定改用「依 Token」拆段。'
            : '這段只有一天，依日期模式不會自動拆開。可以縮小範圍，或在設定改用「依 Token」拆段。';
        const { result } = await showForm(
            `<div class="chb-form"><h3>範圍可能太長</h3><p>${range.start}-${range.end} 層約 ${total} tokens，超過上限 ${limit}，AI 可能會大量刪減內容。</p><p class="chb-muted">${hint}</p></div>`,
            { okText: '仍然產生', cancelText: '取消' },
        );
        return result === POPUP_RESULT.AFFIRMATIVE ? 'whole' : null;
    }
    const rows = segments.map(seg => {
        const over = seg.tokens > limit ? ' <span class="chb-warn">⚠ 超過上限，可能被刪減</span>' : '';
        return `<tr><td>${seg.start}-${seg.end} 層</td><td>${esc(seg.date || '日期不詳')}</td><td>約 ${seg.tokens} tokens${over}</td></tr>`;
    }).join('');
    const reason = s.splitMode === 'date' ? `這段跨了 ${segments.length} 天` : `這段約 ${total} tokens，超過上限 ${limit}`;
    const { result } = await showForm(
        `<div class="chb-form"><h3>建議拆段</h3><p>${reason}，建議拆成 ${segments.length} 條大綱：</p><table class="chb-table">${rows}</table><p class="chb-muted">照建議拆開會依序產生，每一條都照你的預覽設定確認後才寫入。</p></div>`,
        { okText: '仍然一次產生', cancelText: '取消', buttons: [{ text: '照建議拆開', result: RESULT_SPLIT, classes: ['menu_button'] }] },
    );
    if (result === RESULT_SPLIT) return 'split';
    if (result === POPUP_RESULT.AFFIRMATIVE) return 'whole';
    return null;
}

async function runOutline() {
    if (state.busy) return;
    const range = readRange('#chb-start', '#chb-end');
    if (range.error) return toastr.warning(range.error, '巧虎書');
    // 生成開始時就鎖定聊天與世界書，避免中途切換聊天寫錯地方
    const chatId = currentChatId();
    let choice = bookChoice();
    const messages = getRangeMessages(range.start, range.end);
    if (!messages.length) return toastr.warning('這個範圍沒有可讀的內容', '巧虎書');

    const plan = await planSegments(range.start, range.end, messages);
    const decision = await askSplit(plan, range);
    if (!decision) return;
    const segments = decision === 'split' ? plan.segments : [{ start: range.start, end: range.end }];

    let written = 0;
    for (let i = 0; i < segments.length; i++) {
        const outcome = await generateOutline(segments[i], { chatId, choice, index: i, total: segments.length });
        if (outcome.bookName) {
            choice = outcome.bookName;
            written++;
        }
        if (outcome.stop) break;
    }
    if (segments.length > 1) toastr.info(`拆段完成：寫入 ${written}／${segments.length} 條`, '巧虎書');
}

/** 產生一段大綱。回傳 { bookName?（有寫入時）, stop?（要中止後續段落時） }。 */
async function generateOutline(seg, { chatId, choice, index, total }) {
    const s = settings();
    const batch = total > 1;
    const messages = getRangeMessages(seg.start, seg.end);
    if (!messages.length) return {};
    const prompt = buildOutlinePrompt(messages, contextOutlinesFor(seg.start));
    const fields = draft => ({ ...draft, start: seg.start, end: seg.end, chatId });

    for (;;) {
        if (batch) toastr.info(`產生第 ${index + 1}／${total} 段：${seg.start}-${seg.end} 層`, '巧虎書');
        const raw = await runWithRetry(signal => requestAI(prompt, s.outlineProfileId, signal));
        if (raw === null) return { stop: true };
        let draft = parseOutline(raw);
        if (!s.previewBeforeSave && draft.ok) {
            const bookName = await saveOutline(choice, fields(draft));
            return bookName ? { bookName } : { stop: true };
        }
        const heading = batch ? `大綱預覽（第 ${index + 1}／${total} 段）` : '大綱預覽';
        const buttons = [{ text: '重新生成', result: RESULT_REGENERATE, classes: ['menu_button'] }];
        if (batch) buttons.push({ text: '略過這段', result: RESULT_SKIP, classes: ['menu_button'] });
        const { result, values } = await showForm(outlinePreviewHtml(draft, seg.start, seg.end, nextNo(state.items, 'outline'), heading), {
            okText: '寫入世界書',
            cancelText: batch ? '全部停止' : '取消',
            buttons,
        });
        if (result === RESULT_REGENERATE) continue;
        if (result === RESULT_SKIP) return {};
        if (result !== POPUP_RESULT.AFFIRMATIVE) return { stop: true };
        draft = { title: values.title, content: values.content, keywords: normalizeKeywords(values.keywords) };
        if (!String(draft.content).trim()) {
            toastr.warning('內容是空的，沒有寫入', '巧虎書');
            return {};
        }
        const bookName = await saveOutline(choice, fields(draft));
        return bookName ? { bookName } : { stop: true };
    }
}

/** 寫入大綱；成功回傳世界書名稱，失敗回傳 null。 */
async function saveOutline(choice, fields) {
    try {
        const bookName = await resolveBook(choice);
        const title = await writeOutline(bookName, fields);
        toastr.success(`已寫入「${title}」`, '巧虎書');
        await reopenBookSelect(bookName);
        return bookName;
    } catch (error) {
        console.error(LOG, error);
        toastr.error(`寫入失敗：${error.message}`, '巧虎書');
        return null;
    }
}

async function reopenBookSelect(bookName) {
    const $select = state.$root?.find('#chb-book');
    if (!$select) return;
    $select.html(bookOptionsHtml());
    $select.val(bookName);
    await refreshBook();
}

async function saveManual() {
    if (state.busy) return;
    const $root = state.$root;
    const range = readRange('#chb-m-start', '#chb-m-end');
    if (range.error) return toastr.warning(range.error, '巧虎書');
    const content = String($root.find('#chb-m-content').val() ?? '').trim();
    if (!content) return toastr.warning('請填內容', '巧虎書');
    const overlaps = overlapsInChat(range.start, range.end);
    if (overlaps.length) {
        const ok = await Popup.show.confirm('樓層重疊', `和這個聊天已有的大綱重疊：${overlaps.map(o => o.title).join('、')}。仍要寫入嗎？`);
        if (!ok) return;
    }
    await saveOutline(bookChoice(), {
        start: range.start,
        end: range.end,
        no: toInt($root.find('#chb-m-no').val()),
        title: $root.find('#chb-m-title').val(),
        keywords: normalizeKeywords($root.find('#chb-m-keywords').val()),
        content,
        chatId: currentChatId(),
    });
    $root.find('#chb-m-title, #chb-m-keywords, #chb-m-content, #chb-m-no').val('');
}

function parseManualJson() {
    const $root = state.$root;
    const draft = parseOutline($root.find('#chb-m-content').val());
    if (!draft.ok) return toastr.warning('解析不到 JSON（需要有 content 欄位）', '巧虎書');
    $root.find('#chb-m-title').val(draft.title);
    $root.find('#chb-m-keywords').val(draft.keywords.join(', '));
    $root.find('#chb-m-content').val(draft.content);
}

async function runIntegration() {
    if (state.busy) return;
    const sourceItems = selectedItems();
    if (sourceItems.length < 1) return toastr.warning('請先勾選要整合的大綱', '巧虎書');
    const choice = bookChoice();
    if (choice === NEW_BOOK) return toastr.warning('請先選擇有大綱的世界書', '巧虎書');
    const prompt = buildIntegrationPrompt(sourceItems, prevIntegration());
    const s = settings();

    for (;;) {
        const raw = await runWithRetry(signal => requestAI(prompt, s.integrationProfileId, signal));
        if (raw === null) return;
        let parsed = parseIntegration(raw, sourceItems);
        if (s.previewBeforeSave || !parsed.ok) {
            const { result, values } = await showForm(integrationPreviewHtml(parsed, sourceItems), {
                okText: '寫入世界書',
                buttons: [{ text: '重新生成', result: RESULT_REGENERATE, classes: ['menu_button'] }],
            });
            if (result === RESULT_REGENERATE) continue;
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
            const idMap = new Map(sourceItems.map(i => [itemId(i), i.uid]));
            parsed = {
                summaries: parsed.summaries.map((summary, idx) => ({
                    title: values[`title_${idx}`],
                    content: values[`content_${idx}`],
                    keywords: normalizeKeywords(values[`keywords_${idx}`]),
                    sourceUids: String(values[`ids_${idx}`] ?? '').split(/[,，\s]+/)
                        .map(id => idMap.get(id.trim()) ?? idMap.get(pad(toInt(id) ?? -1, 3)))
                        .filter(Boolean),
                })).filter(summary => String(summary.content).trim()),
            };
            if (!parsed.summaries.length) return toastr.warning('內容是空的，沒有寫入', '巧虎書');
        }
        try {
            const titles = await writeIntegrations(choice, parsed.summaries);
            toastr.success(`已寫入：${titles.join('、')}，來源大綱已停用（保留）`, '巧虎書');
            state.$root.find('.chb-pick').prop('checked', false);
            await refreshBook();
        } catch (error) {
            console.error(LOG, error);
            toastr.error(`寫入失敗：${error.message}`, '巧虎書');
        }
        return;
    }
}

function stopGeneration() {
    if (!state.abort) return;
    state.abort.abort();
    try {
        getContext().stopGeneration();
    } catch { /* 走連線設定檔時不需要 */ }
}

function bindPanel($root) {
    $root.on('click', '.chb-tab', function () {
        const tab = this.dataset.tab;
        $root.find('.chb-tab').removeClass('active');
        $(this).addClass('active');
        $root.find('.chb-page').each((_, el) => { el.hidden = el.dataset.page !== tab; });
        if (tab === 'manual') {
            const { start, end } = suggestRange();
            if (!$root.find('#chb-m-start').val()) $root.find('#chb-m-start').val(start);
            if (!$root.find('#chb-m-end').val()) $root.find('#chb-m-end').val(end);
        }
    });
    $root.on('change', '#chb-book', refreshBook);
    $root.on('click', '#chb-suggest', () => {
        const { start, end } = suggestRange();
        $root.find('#chb-start').val(start);
        $root.find('#chb-end').val(end);
        updateRangeInfo();
    });
    $root.on('input', '#chb-start, #chb-end', updateRangeInfo);
    $root.on('input', '#chb-ctx-count', () => {
        settings().contextOutlineCount = Math.max(0, toInt($root.find('#chb-ctx-count').val()) || 0);
        saveSettings();
        updateRangeInfo();
    });
    $root.on('click', '#chb-run-outline', runOutline);
    $root.on('click', '.chb-stop', stopGeneration);
    $root.on('click', '#chb-m-parse', parseManualJson);
    $root.on('click', '#chb-m-save', saveManual);
    $root.on('change', '#chb-f-enabled, #chb-f-chat', renderList);
    $root.on('click', '#chb-refresh', refreshBook);
    $root.on('click', '#chb-reorder', async () => {
        const choice = bookChoice();
        if (choice === NEW_BOOK) return toastr.warning('請先選擇世界書', '巧虎書');
        try {
            const changed = await reorderBook(choice);
            toastr.success(changed ? `已重排 ${changed} 條的順序值` : '順序已經正確，不用調整', '巧虎書');
            await refreshBook();
        } catch (error) {
            console.error(LOG, error);
            toastr.error(`重排失敗：${error.message}`, '巧虎書');
        }
    });
    $root.on('change', '.chb-pick', updateSelected);
    $root.on('change', '#chb-prev-int', () => {
        settings().includePrevIntegration = $root.find('#chb-prev-int').prop('checked');
        saveSettings();
        updateSelected();
    });
    $root.on('click', '#chb-run-int', runIntegration);

    $root.on('input change', '[data-setting]', function () {
        const key = this.dataset.setting;
        let value = this.type === 'checkbox' ? this.checked : this.value;
        if (key in DEFAULT_PROMPTS) {
            // 內容跟預設一樣就存空字串，保持「跟隨預設」
            if (promptHash(value) === promptHash(DEFAULT_PROMPTS[key])) value = '';
            $root.find(`[data-prompt-state="${key}"]`).text(value ? '已自訂' : '使用預設（插件更新時自動套用新版）');
        }
        settings()[key] = value;
        saveSettings();
        if (['stripPatterns', 'includeHidden', 'outlinePrompt', 'horaeTime', 'horaeLocation'].includes(key)) updateRangeInfo();
    });
    $root.on('click', '[data-reset]', async function () {
        const key = this.dataset.reset;
        const ok = await Popup.show.confirm('還原預設', '確定要把這段提示詞還原成預設版本嗎？');
        if (!ok) return;
        settings()[key] = '';
        saveSettings();
        $root.find(`[data-setting="${key}"]`).val(DEFAULT_PROMPTS[key]);
        $root.find(`[data-prompt-state="${key}"]`).text('使用預設（插件更新時自動套用新版）');
    });
    $root.on('click', '#chb-last-raw', () => {
        const raw = settings().lastRaw || '（還沒有紀錄）';
        new Popup(`<div class="chb-form"><h3>上次 AI 原始回應</h3><textarea class="text_pole chb-big" rows="20" readonly>${esc(raw)}</textarea></div>`,
            POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, leftAlign: true }).show();
    });
}

async function openPanel() {
    if (lastMessageId() < 0) {
        toastr.warning('請先開啟一個聊天', '巧虎書');
        return;
    }
    const $root = $(panelHtml());
    state.$root = $root;
    bindPanel($root);
    const popup = new Popup($root[0], POPUP_TYPE.TEXT, '', {
        okButton: '關閉',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: () => {
            if (state.busy) {
                toastr.warning('正在產生中，請先停止或等待完成', '巧虎書');
                return false;
            }
            return true;
        },
    });
    const shown = popup.show();
    await refreshBook();
    const suggestion = suggestRange();
    $root.find('#chb-start').val(suggestion.start);
    $root.find('#chb-end').val(suggestion.end);
    updateRangeInfo();
    await shown;
    state.$root = null;
}

// ---------- 初始化 ----------

function addMenuButton() {
    if ($('#chb-menu-btn').length) return;
    const $button = $(`
<div id="chb-menu-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="巧虎書：產生大綱與整合">
    <i class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></i>
    <span>巧虎書</span>
</div>`);
    $button.on('click', openPanel);
    $('#extensionsMenu').append($button);
}

function addSettingsDrawer() {
    if ($('#chb-settings-drawer').length) return;
    const $drawer = $(`
<div id="chb-settings-drawer" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>📖 巧虎書</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <p>從左下角魔杖選單的「巧虎書」開啟面板，所有功能和設定都在面板裡。</p>
        <button class="menu_button" id="chb-open-from-settings">開啟巧虎書</button>
    </div>
</div>`);
    $drawer.find('#chb-open-from-settings').on('click', openPanel);
    $('#extensions_settings2').append($drawer);
}

jQuery(() => {
    settings();
    addMenuButton();
    addSettingsDrawer();
    console.log(LOG, '已載入');
});
