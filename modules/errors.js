// 只展示预先定义的说明；服务端异常与模型原文可能含密钥或私人内容，不直接保存。
const MESSAGES = Object.freeze({
    EMPTY_OUTPUT: '模型没有返回可解析的正文。',
    OUTPUT_TOO_LONG: '模型返回超过 20000 字符，已拒绝解析。',
    INVALID_JSON: '模型已返回文本，但不是有效 JSON；可能包含额外说明或内容被截断。',
    NON_JSON_OUTPUT: '模型返回了文字或其他格式，没有按要求以 JSON 对象输出；本轮内容未发送。',
    INCOMPLETE_JSON: '返回的 JSON 对象或字符串没有结束；可能被截断。请提高酒馆的回复长度后重试。',
    OUTPUT_TRUNCATED: '接口明确标记输出达到长度上限而被截断。请提高酒馆的回复长度后重试；本轮内容未发送。',
    STRUCTURED_REQUEST_REJECTED: '接口拒绝本次结构化请求（400 / 422）；下次有限重试将改用普通 JSON 提示，不立即追加请求。',
    INVALID_FIELDS: '模型已返回 JSON，但字段缺失或多余；必须包含当前模式规定的全部字段（纯聊天五个，场景模式六个）。',
    INVALID_NARRATION: '场景旁白必须为 null 或 1–2000 字符的文本。',
    MISSING_SCENE_NARRATION: '场景模式选择了 WAIT，却没有提供玩家可读的旁白；本轮未写入聊天。动作不能只藏在心理摘要里，将按原定有限重试处理。',
    INVALID_ACTION: '模型返回了不支持的行动名称。',
    INVALID_STOP: 'STOP 表示停止两个阶段，不得夹带新的场景旁白。',
    INVALID_THOUGHT: '角色状态摘要必须是最多 800 字符的字符串。',
    INVALID_INTENTION: '待定意图必须为 null 或最多 800 字符的字符串。',
    INVALID_MESSAGE: '发送行动必须包含 1–4000 字符的消息，等待时间必须为 null。',
    UNEXPECTED_MESSAGE: 'WAIT / END 的 message 必须为 null，不能夹带消息。',
    INVALID_WAIT: '等待时间必须是 JSON 数字且大于零，不能写成字符串。',
    UNEXPECTED_WAIT: '发送或结束行动的等待时间必须为 null。',
    CONTEXT_TOO_LONG: '决策上下文超过 120000 字符，请减少读取消息数或缩短角色卡。',
    REQUEST_TIMEOUT: '本轮请求超时，已暂停；迟到结果不会发送。',
});

export class DecisionError extends Error {
    constructor(code, outputChars = null) {
        if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('未知决策错误类别');
        super(MESSAGES[code]); this.name = 'DecisionError'; this.code = code;
        this.outputChars = Number.isSafeInteger(outputChars) && outputChars >= 0 ? outputChars : null;
    }
}

const HTTP_HINTS = Object.freeze({
    400: '接口拒绝请求，请检查模型支持的参数和上下文长度。',
    401: '接口鉴权失败，请检查当前连接的密钥。',
    402: '接口要求余额或额度，请检查供应商账户。',
    403: '接口拒绝访问，请检查模型访问权限。',
    404: '接口或所选模型不存在，请检查连接和模型名称。',
    408: '接口请求超时。',
    413: '接口认为请求过大，请减少读取消息数或缩短角色卡。',
    422: '接口无法接受请求参数，请检查所选模型的兼容性。',
    429: '接口限流或额度暂时耗尽，请稍后重试。',
});

export function describeFailure(error, stage = '模型请求') {
    if (error instanceof DecisionError) {
        const area = error.code === 'CONTEXT_TOO_LONG' ? '构建上下文'
            : error.code === 'STRUCTURED_REQUEST_REJECTED' ? '模型请求'
            : error.code === 'REQUEST_TIMEOUT' ? stage : '解析模型输出';
        return `【${area} / ${error.code}】${error.message}${error.outputChars == null ? '' : `（正文 ${error.outputChars} 字符）`}`;
    }
    // 只用错误内容识别固定类别，绝不把匹配前后的原文带进界面或日志。
    const message = (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '').slice(0, 8192);
    const rawStatus = error?.status ?? error?.statusCode ?? error?.response?.status;
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus
        : Number(message.match(/^Got response status ([45]\d{2})$/)?.[1]) || null;
    if (stage === '模型请求') {
        if (status) return `【模型请求 / HTTP_${status}】${HTTP_HINTS[status] ?? (status >= 500 ? '模型服务或中转服务返回错误，请稍后重试。' : '接口拒绝本次请求。')}`;
        if (/context_length_exceeded|maximum context length|context window|too many tokens/i.test(message)) {
            return '【模型请求 / CONTEXT_LIMIT】接口报告上下文超限，请减少读取消息数或缩短角色卡。';
        }
        if (message === 'No message generated') return '【模型请求 / EMPTY_OUTPUT】接口调用结束，但酒馆没有取得正文；请检查回复长度和模型设置。';
        if (error?.name === 'AbortError') return '【模型请求 / REQUEST_ABORTED】本轮请求已被中止。';
        if (/^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(message)) {
            return '【模型请求 / NETWORK_ERROR】浏览器未能完成接口请求，请检查酒馆服务及连接。';
        }
        return '【模型请求 / REQUEST_FAILED】决策调用报错，酒馆未提供可安全展示的错误类别；不能据此认定为网络故障。';
    }
    const kind = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'QuotaExceededError', 'SecurityError'].includes(error?.name) ? error.name : 'Error';
    return `【${stage} / LOCAL_${kind}】插件在此步骤遇到异常；尚不能归因为模型或网络。`;
}
