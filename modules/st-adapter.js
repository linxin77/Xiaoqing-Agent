import { identity, readSnapshot } from './context-builder.js';
import { DecisionError } from './errors.js';
import { structuredConnection } from './output-schema.js';

export class STAdapter {
    constructor(getContext) { this.getContext = getContext; this.unsupportedSchemas = new Set(); }
    snapshot() { return readSnapshot(this.getContext()); }
    async prepare() {
        const ctx = this.getContext();
        if (identity(ctx)) await ctx.unshallowCharacter(ctx.characterId);
    }
    async generate(options) {
        const ctx = this.getContext();
        const { jsonSchema, trimNames = false, ...request } = options;
        const connection = jsonSchema ? structuredConnection(ctx) : null;
        const structured = connection && !this.unsupportedSchemas.has(connection);
        if (structured) request.jsonSchema = jsonSchema;
        let raw;
        try {
            if (typeof ctx.generateRawData === 'function' && typeof ctx.extractMessageFromData === 'function') {
                // 决策 JSON 不能经过 generateRaw 的聊天正则、Markdown 自动修复或停止串裁剪。
                const data = await ctx.generateRawData(request);
                const finish = data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? data?.candidates?.[0]?.finishReason;
                if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finish)) throw new DecisionError('OUTPUT_TRUNCATED');
                raw = typeof data === 'string' ? data : ctx.extractMessageFromData(data, ctx.mainApi);
            } else {
                // 旧适配环境保留兼容；1.19.0 正式 Context 已同时公开以上两个接口。
                raw = await ctx.generateRaw({ ...request, trimNames });
            }
        } catch (error) {
            const status = error?.status ?? error?.statusCode
                ?? Number(error?.message?.match(/^Got response status (400|422)$/)?.[1]);
            if (structured && [400, 422].includes(status)) {
                this.unsupportedSchemas.add(connection);
                throw new DecisionError('STRUCTURED_REQUEST_REJECTED');
            }
            throw error;
        }
        // 使用酒馆公开的当前推理模板解析器，
        // 只取正文送入 JSON 校验，不保存或展示推理块，也不猜测修补 JSON。
        if (typeof raw === 'string' && typeof ctx.parseReasoningFromString === 'function') {
            const parsed = ctx.parseReasoningFromString(raw, { strict: true });
            if (typeof parsed?.content === 'string') return parsed.content;
        }
        return raw;
    }
    hasDraft() { return !!globalThis.document?.querySelector('#send_textarea')?.value?.trim(); }
    stopGeneration(snapshot) {
        const ctx = this.getContext();
        if (identity(ctx)?.key === snapshot.key && typeof ctx.stopGeneration === 'function') ctx.stopGeneration();
    }
    canBuffer() {
        const message = this.getContext().chat.at(-1);
        return message?.is_user && !message.is_system
            && !Object.keys(message.extra ?? {}).some(key => /file|image|audio|video|media/i.test(key));
    }
    available() {
        const ctx = this.getContext();
        return ctx.onlineStatus !== 'no_connection' && !ctx.streamingProcessor && !this.hasDraft();
    }
    async append(snapshot, text, meta, guard, beforeCommit) {
        const ctx = this.getContext();
        // 最后一次检查到 chat.push 之间没有 await，用户消息无法插入这个提交窗口。
        if (identity(ctx)?.key !== snapshot.key || !guard()) return false;
        if (ctx.chat.some(message => message.extra?.xiaoqing_agent?.decision_id === meta.decision_id)) return false;
        const message = {
            name: snapshot.characterName, is_user: false, is_system: false,
            send_date: new Date(meta.sent_at).toISOString(), mes: text,
            extra: { api: ctx.mainApi, type: meta.kind === 'buffered_reply' ? 'xiaoqing_buffered_reply' : 'xiaoqing_proactive', xiaoqing_agent: meta },
            swipe_id: 0, swipes: [text],
        };
        message.swipe_info = [{ send_date: message.send_date, gen_started: null, gen_finished: null, extra: structuredClone(message.extra) }];
        beforeCommit(); // 先持久化去重收据；失败时绝不插入消息。
        const index = ctx.chat.length;
        ctx.chat.push(message);
        ctx.chatMetadata.tainted = true;
        ctx.addOneMessage(message);
        // 不把模型文本交给 /sendas 或 STscript 执行。
        await ctx.saveChat();
        if (identity(this.getContext())?.key === snapshot.key && this.getContext().chat[index] === message) {
            const eventType = meta.kind === 'buffered_reply' ? 'xiaoqing_buffer' : 'xiaoqing';
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, index, eventType);
            if (identity(this.getContext())?.key === snapshot.key) {
                await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, index, eventType);
            }
        }
        return true;
    }
}
