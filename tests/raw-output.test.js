import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision } from './helpers.js';
import { MINUTE } from '../modules/settings.js';
import { parseDecision } from '../modules/decision-engine.js';

// 模拟官方 generateRawData：附带 Schema 时返回提取后的字符串，否则返回原始响应对象。
function rawHarness(model = 'deepseek/deepseek-v4.1-flash', source = 'openrouter') {
    const h = harness({ firstCheckMinutes: 1, minCheckMinutes: 1 });
    const modelCall = h.ctx.generateRaw;
    h.ctx.chatCompletionSettings = { chat_completion_source: source, openrouter_model: model, openai_max_tokens: 1024 };
    h.ctx.getChatCompletionModel = settings => settings.openrouter_model;
    h.ctx.extractMessageFromData = data => data.choices[0].message.content;
    h.ctx.generateRawData = async options => {
        const text = await modelCall(options);
        return options.jsonSchema ? text : { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
    };
    h.ctx.generateRaw = () => { throw new Error('不得经过聊天文字清理'); };
    return h;
}

test('正式原始响应接口绕过聊天文字清理；已核实 DeepSeek 连接附带 Schema', async () => {
    const h = rawHarness();
    const settingsBefore = structuredClone(h.ctx.chatCompletionSettings);
    h.responses.push(decision('SEND_MESSAGE', { message: '这行里有 **符号** 和 {括号}，也该原样保留。' }));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 1); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].jsonSchema.strict, true); assert.equal(h.calls[0].jsonSchema.returnInvalid, true);
    assert.equal(h.calls[0].jsonSchema.value.additionalProperties, false);
    assert.deepEqual(h.calls[0].jsonSchema.value.properties.action.enum, ['SEND_MESSAGE', 'WAIT', 'END']);
    assert.match(h.rendered[0].mes, /\*\*符号\*\*/);
    assert.deepEqual(h.ctx.chatCompletionSettings, settingsBefore);
    assert.equal(h.calls[0].responseLength, undefined);
});

for (const [label, model, source] of [
    ['未知模型', 'vendor/unknown', 'openrouter'],
    ['其他供应商', 'deepseek/deepseek-v4.1-flash', 'custom'],
]) test(`${label}不强加 Schema，原始响应仍严格解析`, async () => {
    const h = rawHarness(model, source); h.responses.push(decision('WAIT'));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].jsonSchema, undefined);
    assert.equal(h.agent.episode().history[0].action, 'WAIT');
});

test('秒级接话使用 REPLY / 秒数字段的 Schema，不能混用长期格式', async () => {
    const h = rawHarness();
    h.responses.push({ action: 'REPLY', message: '快说，我等着呢。', next_check_seconds: null, thought: '急着知道。', pending_intention: null });
    await h.normalUser('我发现一件事'); await h.clock.advance(5000);
    const schema = h.calls[0].jsonSchema.value;
    assert.deepEqual(schema.properties.action.enum, ['REPLY', 'WAIT', 'END']);
    assert.ok(schema.required.includes('next_check_seconds'));
    assert.equal(schema.properties.next_check_minutes, undefined);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().sentCount, 0);
});

test('接口拒绝结构化请求后不立即追加调用，下次有限重试才降级', async () => {
    const h = rawHarness();
    h.responses.push(new Error('Got response status 400'), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.calls.length, 1); assert.match(h.agent.episode().error, /STRUCTURED_REQUEST_REJECTED/);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'WAITING');
    await h.clock.advance(MINUTE);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].jsonSchema, undefined);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().sentCount, 1);
});

test('限流错误保持结构化格式，不把网络/额度问题误当 Schema 不兼容', async () => {
    const h = rawHarness(); h.responses.push(new Error('Got response status 429'), decision('END'));
    await h.user(); await h.clock.advance(MINUTE);
    assert.match(h.agent.episode().error, /HTTP_429/);
    await h.clock.advance(MINUTE);
    assert.ok(h.calls[1].jsonSchema); assert.equal(h.agent.episode().status, 'ENDED');
});

for (const finish of ['length', 'max_tokens', 'MAX_TOKENS']) test(`接口明确长度截断 ${finish}：报告原因且不发不完整消息`, async () => {
    const h = rawHarness('vendor/unknown');
    h.ctx.generateRawData = async options => {
        h.calls.push(options);
        return { choices: [{ finish_reason: finish, message: { content: '{"action":"SEND_MESSAGE","message":"private-partial' } }] };
    };
    await h.user(); await h.clock.advance(MINUTE);
    assert.match(h.agent.episode().error, /OUTPUT_TRUNCATED/); assert.equal(h.rendered.length, 0);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata).includes('private-partial'));
});

test('Schema 返回残缺对象仍拒绝，不补括号或发送部分消息', async () => {
    const h = rawHarness(); h.responses.push('{"action":"SEND_MESSAGE","message":"private-partial');
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 0); assert.match(h.agent.episode().error, /INCOMPLETE_JSON/);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata).includes('private-partial'));
});

test('结构完整但语法错与未结束对象分别提示，多个对象也不拼接', () => {
    assert.throws(() => parseDecision('{"action":"WAIT"'), { code: 'INCOMPLETE_JSON' });
    assert.throws(() => parseDecision('{invalid}'), { code: 'INVALID_JSON' });
    assert.throws(() => parseDecision(JSON.stringify(decision('END')) + '\n{'), { code: 'INVALID_JSON' });
});

test('Schema 输出仍遵守本地行动约束和发送权限', async () => {
    const h = rawHarness();
    h.responses.push(decision('WAIT', { message: '不能偷带这条消息' }));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 0); assert.match(h.agent.episode().error, /UNEXPECTED_MESSAGE/);
});
