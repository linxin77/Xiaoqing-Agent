import { Agent } from '../modules/agent.js';
import { Storage } from '../modules/storage.js';
import { STAdapter } from '../modules/st-adapter.js';
import { DecisionEngine } from '../modules/decision-engine.js';
import { BrowserCoordinator } from '../modules/coordination.js';
import { normalizeSettings, KEY } from '../modules/settings.js';
import { listen } from '../modules/event-listener.js';
import { ConversationBuffer } from '../modules/conversation-buffer.js';

export const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
export class FakeClock {
    constructor(now = Date.UTC(2026, 9, 18, 12)) { this.time = now; this.nextId = 1; this.timers = new Map(); }
    now = () => this.time;
    setTimeout = (fn, ms) => { const id = this.nextId++; this.timers.set(id, { at: this.time + ms, fn }); return id; };
    clearTimeout = id => this.timers.delete(id);
    async advance(ms) {
        const end = this.time + ms;
        for (let i = 0; i < 10000; i++) {
            const next = [...this.timers.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await drain();
            if (i === 9999) throw new Error('定时器失控');
        }
        this.time = end; await drain();
    }
}
export class MemoryStorage {
    map = new Map();
    get length() { return this.map.size; }
    key(index) { return [...this.map.keys()][index] ?? null; }
    getItem(key) { return this.map.get(key) ?? null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
}
export class Locks {
    held = new Set();
    async request(key, _options, callback) {
        if (this.held.has(key)) return callback(null);
        this.held.add(key);
        try { return await callback({ name: key }); } finally { this.held.delete(key); }
    }
}
export class Events {
    handlers = new Map();
    on(key, fn) { if (!this.handlers.has(key)) this.handlers.set(key, new Set()); this.handlers.get(key).add(fn); }
    removeListener(key, fn) { this.handlers.get(key)?.delete(fn); }
    async emit(key, ...args) { for (const fn of [...this.handlers.get(key) ?? []]) await fn(...args); }
}
export function decision(action, options = {}) {
    return { action, message: action === 'SEND_MESSAGE' ? '喂，你刚才的话还没说完呢。' : null,
        next_check_minutes: action === 'WAIT' ? 10 : null, thought: '有些好奇，也许对方正在忙。', pending_intention: null, ...options };
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

export function harness(settings = {}, shared = {}) {
    const clock = new FakeClock();
    const responses = [], calls = [], rendered = [], saved = [];
    const events = new Events();
    const names = ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED',
        'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'CHARACTER_EDITED', 'MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED', 'PERSONA_CHANGED'];
    const ctx = {
        characterId: 0, groupId: null, chatId: 'chat-A', name1: '用户', name2: '小晴', mainApi: 'openai', onlineStatus: 'Connected', streamingProcessor: null,
        characters: [{ name: '小晴', avatar: 'xiaoqing.png', description: '有些傲娇，内心温柔', personality: '敏感，喜欢天文',
            data: { description: '完整卡正文', system_prompt: '角色系统提示也是资料', character_book: { entries: [{ content: '天文社经历' }] } } }],
        // 旧用例明确保留固定间隔作为回归基线；自然等待另有专门的开启用例。
        chat: [], chatMetadata: {}, extensionSettings: { [KEY]: normalizeSettings({ enabled: true, allowSend: true, maxMessages: 1, fastTestEnabled: false, dualPhaseEnabled: false, adaptiveWaitEnabled: false, ...settings }) },
        eventSource: events, eventTypes: Object.fromEntries(names.map(name => [name, name])),
        getCharacterCardFields: () => ({ description: ctx.characters[ctx.characterId].description, persona: '用户是天文爱好者' }),
        timestampToMoment: value => ({ valueOf: () => new Date(value).getTime() }),
        unshallowCharacter: async () => {}, saveMetadata: async () => { saved.push(structuredClone(ctx.chatMetadata)); },
        saveChat: async () => { saved.push(structuredClone({ chat: ctx.chat, meta: ctx.chatMetadata })); },
        saveSettingsDebounced: () => {}, addOneMessage: message => rendered.push(message),
        generateRaw: async options => {
            calls.push(options);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            if (typeof response === 'function') return response(options);
            if (response === undefined) throw new Error('测试未设置模型输出');
            return typeof response === 'string' ? response : JSON.stringify(response);
        },
    };
    const getContext = () => ctx;
    const storage = new Storage(getContext), adapter = new STAdapter(getContext);
    const coordinator = new BrowserCoordinator(shared.locks ?? new Locks(), shared.local ?? new MemoryStorage());
    const agent = new Agent({ adapter, storage, engine: new DecisionEngine(adapter), coordinator, clock });
    agent.buffer = new ConversationBuffer(agent);
    const unlisten = listen(getContext, agent);
    async function user(text = '今天那个同学居然……') {
        ctx.chat.push({ name: '用户', is_user: true, is_system: false, mes: text, send_date: new Date(clock.now()).toISOString() });
        await events.emit('MESSAGE_SENT', ctx.chat.length - 1); await drain();
    }
    async function normalUser(text) {
        await events.emit('GENERATION_STARTED', 'normal', {}, false);
        await events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        await user(text);
        let aborted = false;
        agent.buffer.intercept(ctx.chat, 8192, () => { aborted = true; }, 'normal');
        if (aborted) { await events.emit('GENERATION_ENDED'); await drain(); }
        return aborted;
    }
    return { ctx, clock, responses, calls, rendered, saved, agent, storage, adapter, coordinator, events, user, normalUser, unlisten };
}
