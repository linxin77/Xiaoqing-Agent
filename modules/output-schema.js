// 供应商 Schema 只是一层格式约束；行动和权限始终由本地生产解析器与提交检查验证。
export function decisionSchema(buffered = false, scene = false, dualPhase = false) {
    const timeKey = buffered ? 'next_check_seconds' : 'next_check_minutes';
    const schema = {
        name: buffered ? 'xiaoqing_buffer_decision' : scene ? 'xiaoqing_scene_decision' : 'xiaoqing_proactive_decision',
        strict: true, returnInvalid: true,
        value: {
            type: 'object', additionalProperties: false,
            properties: {
                action: { type: 'string', enum: buffered ? ['REPLY', 'WAIT', 'END'] : ['SEND_MESSAGE', 'WAIT', 'END'] },
                message: { type: ['string', 'null'], description: '发送或回复时填写自然聊天文本，其他行动必须为 null。' },
                [timeKey]: { type: ['number', 'null'], description: `仅 WAIT 填写大于零的${buffered ? '秒数' : '分钟数'}，其他行动必须为 null。` },
                thought: { type: 'string', description: '一句可展示的角色模拟状态，不输出隐藏推理。' },
                pending_intention: { type: ['string', 'null'], description: '尚未执行的意图，或 null。' },
            },
            required: ['action', 'message', timeKey, 'thought', 'pending_intention'],
        },
    };
    if (scene && !buffered) {
        const original = schema.value.properties;
        // 优先生成玩家能看到的结果，再填写简短摘要，避免长独白占满输出。
        schema.value.properties = {
            action: original.action,
            narration: { type: 'string', maxLength: 2000,
                description: '玩家可读的第三人称动作或场景描述。确实发生可见动作时填写；任何行动没有新动作均用空字符串，包括安静 WAIT。无对白、内心独白或隐藏推理。' },
            message: original.message,
            next_check_minutes: original.next_check_minutes,
            thought: { type: 'string', maxLength: 120, description: '最多 120 字符的一句决策状态摘要，不能以长内心独白代替旁白。' },
            pending_intention: original.pending_intention,
        };
        schema.value.required = Object.keys(schema.value.properties);
    }
    if (dualPhase && !buffered) schema.value.properties.action.enum.push('STOP');
    return schema;
}

// 仅启用已查证的组合，不能假设任意供应商或模型支持结构化输出。
// 官方依据：https://openrouter.ai/deepseek/deepseek-v4.1-flash
export function structuredConnection(ctx) {
    if (ctx.mainApi !== 'openai' || ctx.chatCompletionSettings?.chat_completion_source !== 'openrouter'
        || typeof ctx.getChatCompletionModel !== 'function') return null;
    const model = ctx.getChatCompletionModel(ctx.chatCompletionSettings);
    return model === 'deepseek/deepseek-v4.1-flash' ? `openrouter:${model}` : null;
}
