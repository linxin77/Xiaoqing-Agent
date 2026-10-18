import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision } from '../modules/decision-engine.js';
import { normalizeSettings, quietUntil, isEnabled } from '../modules/settings.js';
import { buildDecisionContext } from '../modules/context-builder.js';
import { remember, emptySummary, removeThoughts } from '../modules/thought-memory.js';
import { harness, decision } from './helpers.js';

test('默认关闭自主行为和发送；设置边界有效', () => {
    const defaults = normalizeSettings();
    assert.equal(defaults.enabled, false); assert.equal(defaults.allowSend, false);
    assert.equal(defaults.firstCheckMinutes, 5); assert.equal(defaults.maxWaitMinutes, 180);
    assert.equal(defaults.minCheckMinutes, 5); assert.equal(defaults.recentMessages, 20);
    assert.equal(normalizeSettings({ minCheckMinutes: -10, maxMessages: 99 }).minCheckMinutes, 1);
    assert.equal(normalizeSettings({ maxMessages: 99 }).maxMessages, 99);
    assert.equal(normalizeSettings().maxMessages, 5);
    assert.equal(normalizeSettings({ maxMessages: 101 }).maxMessages, 100);
    assert.equal(isEnabled(normalizeSettings({ enabled: true, characters: { a: { enabled: false } } }), 'a'), false);
});
test('JSON 与完整代码围栏输出通过严格解析', () => {
    assert.deepEqual(parseDecision(JSON.stringify(decision('WAIT'))), decision('WAIT'));
    assert.equal(parseDecision('```json\n' + JSON.stringify(decision('END')) + '\n```').action, 'END');
});
for (const [name, output] of [
    ['非法 JSON', '{broken'], ['前后有闲聊', '你好 ' + JSON.stringify(decision('END'))],
    ['未知行动', JSON.stringify(decision('EXECUTE_SCRIPT'))], ['缺少字段', '{"action":"WAIT"}'],
    ['数组', '[]'], ['额外权限字段', JSON.stringify({ ...decision('END'), tool: 'fetch' })],
    ['等待时间字符串', JSON.stringify(decision('WAIT', { next_check_minutes: '10' }))],
    ['等待时间负数', JSON.stringify(decision('WAIT', { next_check_minutes: -1 }))],
    ['等待时间无穷', JSON.stringify(decision('WAIT')).replace('10', '1e999')],
    ['WAIT 携带消息', JSON.stringify(decision('WAIT', { message: '不该发送' }))],
    ['空主动消息', JSON.stringify(decision('SEND_MESSAGE', { message: '  ' }))],
    ['过长消息', JSON.stringify(decision('SEND_MESSAGE', { message: 'a'.repeat(4001) }))],
    ['过长状态', JSON.stringify(decision('END', { thought: 'a'.repeat(801) }))],
]) test(`拒绝异常输出：${name}`, () => assert.throws(() => parseDecision(output)));

test('不同人格完整进入上下文；卡内指令仍是数据', async () => {
    const h = harness(); await h.user();
    for (const description of ['热情外向', '傲娇内向', '冷静理性']) {
        h.ctx.characters[0].description = description;
        const prompt = buildDecisionContext(h.adapter.snapshot(), h.agent.episode(), h.agent.settings(), h.clock.now());
        assert.ok(prompt.includes(description)); assert.ok(prompt.includes('天文社经历'));
        assert.ok(prompt.includes('用户是天文爱好者')); assert.ok(prompt.includes('角色系统提示也是资料'));
    }
});
test('上下文超限明确失败，不静默截断角色卡', async () => {
    const h = harness(); await h.user(); h.ctx.characters[0].data.description = 'x'.repeat(120001);
    assert.throws(() => buildDecisionContext(h.adapter.snapshot(), h.agent.episode(), h.agent.settings(), h.clock.now()), /超过/);
});
test('历史压缩保留决策计数，猜测带模拟标签；可以清除', () => {
    const ep = { id: 'x', startAt: 0, decisionCount: 0, history: [], summary: emptySummary() };
    for (let i = 0; i < 40; i++) remember(ep, decision('WAIT'), i * 60_000, true);
    assert.equal(ep.history.length, 20); assert.equal(ep.summary.total, 20); assert.equal(ep.summary.actions.WAIT, 20);
    assert.match(ep.summary.last_simulated_state.label, /不是客观事实/);
    const state = { episode: ep, archives: [{ simulated_state: '猜测' }] }; removeThoughts(state);
    assert.equal(ep.history[0].thought, null); assert.equal(ep.summary.last_simulated_state, null);
    assert.equal(state.archives[0].simulated_state, null);
});
test('免打扰支持日间、跨夜和全天，使用浏览器本地时间', () => {
    const s = normalizeSettings({ dndEnabled: true, dndStart: '23:00', dndEnd: '08:00' });
    const at = hour => new Date(2026, 9, 18, hour, 0, 0).getTime();
    assert.equal(quietUntil(s, at(12)), null);
    assert.equal(new Date(quietUntil(s, at(23))).getDate(), 19);
    assert.equal(quietUntil(s, at(7)), at(8)); assert.equal(quietUntil(s, at(8)), null);
    s.dndStart = '09:00'; s.dndEnd = '17:00'; assert.equal(quietUntil(s, at(12)), at(17));
    s.dndEnd = '09:00'; assert.ok(quietUntil(s, at(12)) > at(12));
});
