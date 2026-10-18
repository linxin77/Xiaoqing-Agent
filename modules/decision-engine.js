import { DECISION_PROMPT } from '../prompts/decision-prompt.js';
import { DecisionError } from './errors.js';
import { decisionSchema } from './output-schema.js';
import { SCENE_PROMPT } from '../prompts/scene-prompt.js';
import { fastTestPrompt } from './timing.js';
import { isDual, phasePrompt } from './phases.js';

function unfinishedObject(text) {
    if (!text.startsWith('{')) return false;
    const stack = [];
    let quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
            if (stack.pop() !== (ch === '}' ? '{' : '[')) return false;
            if (!stack.length && text.slice(i + 1).trim()) return false;
        }
    }
    return quoted || stack.length > 0;
}

export function parseObject(raw, keys) {
    if (typeof raw !== 'string' || !raw.trim()) throw new DecisionError('EMPTY_OUTPUT');
    if (raw.length > 20_000) throw new DecisionError('OUTPUT_TOO_LONG');
    let text = raw.trim();
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fence) text = fence[1].trim();
    let value;
    try { value = JSON.parse(text); } catch {
        // 只诊断，不补括号、不猜字段，更不发送残缺文本。
        const code = unfinishedObject(text) ? 'INCOMPLETE_JSON' : /^[{[]/.test(text) ? 'INVALID_JSON' : 'NON_JSON_OUTPUT';
        throw new DecisionError(code, raw.length);
    }
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw new DecisionError('INVALID_FIELDS');
    }
    return value;
}

export function parseDecision(raw, { scene = false, dualPhase = false } = {}) {
    const keys = ['action', 'message', 'next_check_minutes', 'thought', 'pending_intention'];
    const value = parseObject(raw, scene ? [...keys, 'narration'] : keys);
    if (!(dualPhase ? ['WAIT', 'SEND_MESSAGE', 'END', 'STOP'] : ['WAIT', 'SEND_MESSAGE', 'END']).includes(value.action)) throw new DecisionError('INVALID_ACTION');
    if (typeof value.thought !== 'string' || !scene && value.thought.length > 800) throw new DecisionError('INVALID_THOUGHT');
    if (value.pending_intention !== null && (typeof value.pending_intention !== 'string' || value.pending_intention.length > 800)) {
        throw new DecisionError('INVALID_INTENTION');
    }
    if (value.action === 'SEND_MESSAGE') {
        if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 4000
            || value.next_check_minutes !== null) throw new DecisionError('INVALID_MESSAGE');
        value.message = value.message.trim();
    } else if (value.message !== null) throw new DecisionError('UNEXPECTED_MESSAGE');
    if (value.action === 'WAIT') {
        if (typeof value.next_check_minutes !== 'number' || !Number.isFinite(value.next_check_minutes)
            || value.next_check_minutes <= 0) throw new DecisionError('INVALID_WAIT');
    } else if (value.next_check_minutes !== null) throw new DecisionError('UNEXPECTED_WAIT');
    if (scene) {
        // 所有行动均允许没有新的可见动作；空字符串统一为 null，兼容旧版 null。
        // 仅实际返回旁白时展示，不能从辅助状态摘要推断外部行动。
        if (typeof value.narration === 'string' && !value.narration.trim()) value.narration = null;
        if (value.narration !== null && (typeof value.narration !== 'string' || !value.narration.trim()
            || value.narration.length > 2000)) throw new DecisionError('INVALID_NARRATION');
        if (value.narration !== null) value.narration = value.narration.trim();
        if (value.action === 'STOP' && value.narration !== null) throw new DecisionError('INVALID_STOP');
        // 辅助摘要超长时省略，不让它挡住已经合格的玩家可见旁白，也不持久化长独白。
        if (value.thought.length > 120) value.thought = '状态摘要过长，已省略；请以本轮旁白和实际执行结果为准。';
    }
    return value;
}

export class DecisionEngine {
    constructor(adapter) { this.adapter = adapter; }
    async decide(prompt, { scene = false, settings = null, episode = null } = {}) {
        // 适配器只对已确认支持的连接附带 Schema；所有输出仍通过相同的本地严格校验。
        const systemPrompt = (scene ? SCENE_PROMPT : DECISION_PROMPT) + fastTestPrompt(settings, episode) + phasePrompt(episode);
        const raw = await this.adapter.generate({ systemPrompt, prompt, trimNames: false, jsonSchema: decisionSchema(false, scene, isDual(episode)) });
        return parseDecision(raw, { scene, dualPhase: isDual(episode) });
    }
}
