import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionError, describeFailure } from '../modules/errors.js';
import { parseDecision } from '../modules/decision-engine.js';
import { parseBufferedDecision } from '../modules/buffer-engine.js';
import { DECISION_PROMPT } from '../prompts/decision-prompt.js';
import { BUFFER_PROMPT } from '../prompts/buffer-prompt.js';
import { harness, decision } from './helpers.js';
import { MINUTE } from '../modules/settings.js';

test('两条系统提示内所有格式示例都是可直接通过生产校验的 JSON', () => {
    for (const [prompt, parse, actions] of [
        [DECISION_PROMPT, parseDecision, ['SEND_MESSAGE', 'WAIT', 'END']],
        [BUFFER_PROMPT, parseBufferedDecision, ['REPLY', 'WAIT', 'END']],
    ]) {
        const examples = prompt.split('\n').filter(line => line.startsWith('{'));
        assert.equal(examples.length, 3);
        assert.deepEqual(examples.map(text => parse(text).action), actions);
    }
});

test('解析错误区分无正文、无效 JSON、缺字段、等待值类型，且不回显原文', () => {
    for (const [raw, code] of [
        ['', 'EMPTY_OUTPUT'], ['private-secret-not-json', 'NON_JSON_OUTPUT'], ['{invalid}', 'INVALID_JSON'],
        ['{"action":"WAIT"}', 'INVALID_FIELDS'],
        [JSON.stringify(decision('WAIT', { next_check_minutes: '5' })), 'INVALID_WAIT'],
    ]) {
        assert.throws(() => parseDecision(raw), error => {
            assert.ok(error instanceof DecisionError); assert.equal(error.code, code);
            assert.ok(!describeFailure(error).includes('private-secret'));
            return true;
        });
    }
});

test('HTTP、网络、空正文、上下文限制和本地异常分类，不复制任意错误文本', () => {
    const cases = [
        [new Error('Got response status 429'), '模型请求', 'HTTP_429'],
        [Object.assign(new Error('sk-private-key'), { status: 401 }), '模型请求', 'HTTP_401'],
        [new TypeError('Failed to fetch'), '模型请求', 'NETWORK_ERROR'],
        [new Error('No message generated'), '模型请求', 'EMPTY_OUTPUT'],
        [new Error('maximum context length: private-chat'), '模型请求', 'CONTEXT_LIMIT'],
        [new Error('sk-private-key private-chat'), '模型请求', 'REQUEST_FAILED'],
        [new ReferenceError('private-chat is not defined'), '构建决策上下文', 'LOCAL_ReferenceError'],
        [new SyntaxError('Unexpected token private-chat'), '读取去重记录', 'LOCAL_SyntaxError'],
    ];
    for (const [error, stage, code] of cases) {
        const safe = describeFailure(error, stage);
        assert.ok(safe.includes(code), safe);
        assert.ok(!safe.includes('private-chat') && !safe.includes('sk-private-key'), safe);
    }
});

test('重现短期成功、长期格式失败：显示解析错误，有限重试后正常发送', async () => {
    const h = harness({ firstCheckMinutes: 1, minCheckMinutes: 1, bufferSeconds: 2 });
    h.responses.push({ action: 'REPLY', message: '然后呢？快说！', next_check_seconds: null,
        thought: '好奇后续。', pending_intention: null },
    'private-secret-not-json', decision('SEND_MESSAGE'));
    assert.equal(await h.normalUser('我告诉你个秘密'), true);
    await h.clock.advance(2000);
    assert.equal(h.agent.buffer.state.status, 'DONE'); assert.equal(h.rendered.length, 1);
    await h.clock.advance(MINUTE - 2000);
    const ep = h.agent.episode();
    assert.equal(ep.status, 'WAITING'); assert.match(ep.error, /解析模型输出 \/ NON_JSON_OUTPUT/);
    assert.equal(h.calls.length, 2); assert.equal(ep.history.length, 0); assert.equal(h.rendered.length, 1);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata).includes('private-secret'));
    await h.clock.advance(MINUTE);
    assert.equal(ep.status, 'ENDED'); assert.equal(ep.error, null);
    assert.equal(ep.sentCount, 1); assert.equal(h.rendered.length, 2);
});

test('角色加载异常显示本地步骤；不能错误提示为网络故障', async () => {
    const h = harness({ firstCheckMinutes: 1 });
    h.ctx.unshallowCharacter = async () => { throw new ReferenceError('private-card undefined'); };
    await h.user(); await h.clock.advance(MINUTE);
    assert.match(h.agent.episode().error, /加载角色资料 \/ LOCAL_ReferenceError/);
    assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata).includes('private-card'));
});

test('短期请求失败也明确显示 HTTP 类别，重试成功会清除旧错误', async () => {
    const h = harness({ bufferSeconds: 2 });
    h.responses.push(new Error('Got response status 503'),
        { action: 'REPLY', message: '我听着，你继续。', next_check_seconds: null, thought: '继续听。', pending_intention: null });
    await h.normalUser('我有事想说'); await h.clock.advance(2000);
    assert.match(h.agent.buffer.state.error, /HTTP_503/); assert.equal(h.rendered.length, 0);
    await h.clock.advance(2000);
    assert.equal(h.agent.buffer.state.status, 'DONE'); assert.equal(h.agent.buffer.state.error, null);
    assert.equal(h.rendered.length, 1);
});

test('用酒馆当前推理模板分离正文，保留严格校验，不保存推理块', async () => {
    const h = harness({ firstCheckMinutes: 1 });
    h.ctx.parseReasoningFromString = (raw, options) => {
        assert.equal(options.strict, true);
        return { reasoning: 'private-reasoning', content: raw.replace(/^<think>[\s\S]*?<\/think>/, '').trim() };
    };
    h.responses.push('<think>private-reasoning</think>\n' + JSON.stringify(decision('SEND_MESSAGE')));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().sentCount, 1);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata).includes('private-reasoning'));
    assert.ok(!h.rendered[0].mes.includes('<think>'));
});

test('分离推理块之后，正文仍然必须是合法的完整决策', async () => {
    const h = harness({ firstCheckMinutes: 1 });
    h.ctx.parseReasoningFromString = () => ({ reasoning: 'private-reasoning', content: '{"action":"SEND_MESSAGE"}' });
    h.responses.push('<think>private-reasoning</think>{"action":"SEND_MESSAGE"}');
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 0); assert.match(h.agent.episode().error, /INVALID_FIELDS/);
});
