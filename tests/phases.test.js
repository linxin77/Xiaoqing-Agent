import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';
import { MINUTE } from '../modules/settings.js';
import { parseDecision } from '../modules/decision-engine.js';

const dual = extra => harness({ dualPhaseEnabled: true, fastTestEnabled: false, maxMessages: 3, ...extra });
const data = call => JSON.parse(call.prompt.split('\n')[1]);
const stop = narration => ({ action: 'STOP', message: null, next_check_minutes: null, thought: '遵守用户停止联系的要求。', pending_intention: null,
    ...(narration === undefined ? {} : { narration }) });
const scene = (action, narration = '') => decision(action, { narration });

test('快阶段两条后自主 END，真实5分钟后用剩余一条且不绕过总上限', async () => {
    const h = dual(); h.responses.push(decision('SEND_MESSAGE'), decision('SEND_MESSAGE'), decision('END'), decision('SEND_MESSAGE', { message: '刚才听到一首新歌，想分享给你。' }));
    await h.user(); const start = h.clock.now(); await h.clock.advance(30_000);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().phase, 'between');
    assert.equal(h.agent.episode().dueAt, start + 5 * MINUTE);
    await h.clock.advance(5 * MINUTE - 30_000 - 1); assert.equal(h.calls.length, 3);
    await h.clock.advance(1); assert.equal(h.calls.length, 4); assert.equal(h.rendered.length, 3);
    assert.equal(h.agent.episode().slowSentCount, 1); assert.equal(h.agent.episode().sentCount, 3);
    assert.equal(h.agent.episode().status, 'ENDED'); assert.equal(data(h.calls[3]).permissions.sent_count, 0);
    assert.equal(h.agent.episode().outputCount, 3); assert.equal(data(h.calls[3]).permissions.remaining_outputs, 1);
    assert.equal(data(h.calls[3]).interaction_phase.name, 'slow');
    assert.equal(data(h.calls[3]).environment.fast_test, undefined);
    assert.match(h.calls[3].systemPrompt, /慢速重新联系/);
    assert.doesNotMatch(h.calls[3].systemPrompt, /用户明确开启了快速测试/);
    assert.ok(h.calls[3].jsonSchema === undefined); // 未知连接不强加 Schema。
    await h.clock.advance(60 * MINUTE); assert.equal(h.calls.length, 4);
});

test('快阶段 END 只收尾，慢阶段 WAIT 使用真实分钟，慢 END 后不再重开', async () => {
    const h = dual(); h.responses.push(decision('END'), decision('WAIT', { next_check_minutes: 15 }), decision('END'));
    await h.user(); await h.clock.advance(10_000);
    assert.equal(h.agent.episode().phase, 'between'); assert.equal(h.rendered.length, 0);
    await h.clock.advance(5 * MINUTE - 10_000);
    assert.equal(h.agent.episode().phase, 'slow'); assert.equal(h.agent.episode().dueAt - h.clock.now(), 15 * MINUTE);
    assert.equal(h.agent.episode().history[0].phase, 'fast'); assert.equal(h.agent.episode().history[1].phase, 'slow');
    await h.clock.advance(15 * MINUTE); assert.equal(h.agent.episode().status, 'ENDED');
    await h.clock.advance(60 * MINUTE); assert.equal(h.calls.length, 3);
});

test('真实门槛到时快阶段尚未结束，不并行启动慢阶段', async () => {
    const h = dual({ slowStartMinutes: 1, fastPhaseMaxMinutes: 10 });
    h.responses.push(...Array.from({ length: 7 }, () => decision('WAIT')), decision('END'), decision('END'));
    await h.user(); await h.clock.advance(80_000);
    assert.equal(h.calls.length, 8); assert.equal(h.agent.episode().phase, 'between');
    assert.ok(h.calls.every(call => data(call).interaction_phase.name === 'fast'));
    await h.clock.advance(10_000); assert.equal(h.calls.length, 9); assert.equal(data(h.calls[8]).interaction_phase.name, 'slow');
});

test('快阶段时限收尾后可进入慢阶段，不把整轮任务一起结束', async () => {
    const h = dual(); h.responses.push(...Array.from({ length: 29 }, () => decision('WAIT')), decision('END'));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 29); assert.equal(h.agent.episode().phase, 'between');
    await h.clock.advance(10_000); assert.equal(h.calls.length, 30); assert.equal(h.agent.episode().status, 'ENDED');
});

test('场景动作和位置跨阶段承接，慢阶段可以独立发送对白', async () => {
    const h = dual(); await h.agent.load(); await h.agent.setInteractionMode('scene');
    h.responses.push(scene('END', '团团把价签收好，走到柜台边。'), scene('SEND_MESSAGE', '她把新烤好的面包端上柜台。'), scene('END'));
    await h.user(); await h.clock.advance(10_000);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().phase, 'between');
    await h.clock.advance(5 * MINUTE - 10_000);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().slowSentCount, 1);
    assert.equal(h.agent.episode().slowNarrationCount, 1); assert.equal(h.agent.episode().narrationCount, 2);
    assert.match(h.calls[1].prompt, /走到柜台边/); assert.equal(data(h.calls[1]).permissions.allow_send, true);
    await h.clock.advance(5 * MINUTE); assert.equal(h.agent.episode().status, 'ENDED');
});

test('快慢两种时间标清：慢阶段读取真实沉默，不继承60倍测试参考', async () => {
    const h = dual(); h.responses.push(decision('END'), decision('END')); await h.user();
    await h.clock.advance(5 * MINUTE);
    assert.equal(data(h.calls[0]).environment.test_silence_minutes, 10);
    assert.equal(data(h.calls[1]).environment.silence_minutes, 5);
    assert.equal(data(h.calls[1]).environment.test_silence_minutes, undefined);
    assert.match(h.calls[1].systemPrompt, /剧情时间不要倒退/);
});

test('阶段间构思暂停冻结真实门槛，继续后从剩余时间走', async () => {
    const h = dual(); h.responses.push(decision('END'), decision('END')); await h.user(); await h.clock.advance(MINUTE);
    await h.agent.setHold(true); await h.clock.advance(10 * MINUTE); assert.equal(h.calls.length, 1);
    await h.agent.setHold(false); assert.equal(h.agent.episode().dueAt - h.clock.now(), 4 * MINUTE);
    await h.clock.advance(4 * MINUTE); assert.equal(h.calls.length, 2);
    assert.equal(data(h.calls[1]).environment.silence_minutes, 5);
});

test('阶段间刷新保持门槛和快阶段事实，不重跑快阶段', async () => {
    const h = dual(); h.responses.push(decision('END'), decision('END')); await h.user(); await h.clock.advance(MINUTE);
    const due = h.agent.episode().dueAt; await h.agent.load(); assert.equal(h.agent.episode().dueAt, due);
    assert.equal(h.agent.episode().phase, 'between'); await h.clock.advance(4 * MINUTE); assert.equal(h.calls.length, 2);
});

for (const action of ['cancel', 'clearMemory']) test(`阶段间 ${action} 关闭两个阶段，不因刷新复活`, async () => {
    const h = dual(); h.responses.push(decision('END')); await h.user(); await h.clock.advance(10_000);
    await h.agent[action](); await h.agent.load(); await h.clock.advance(20 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().status, 'CANCELED');
    assert.equal(h.agent.readReceipt(h.adapter.snapshot(), 'slow').hardStop, true);
});

test('STOP 关闭两个阶段，和普通 END 的收尾语义分开', async () => {
    const h = dual(); h.responses.push(stop()); await h.user(); await h.clock.advance(10_000);
    assert.equal(h.agent.episode().status, 'ENDED'); assert.equal(h.agent.episode().history[0].outcome, 'STOPPED');
    assert.equal(h.agent.readReceipt(h.adapter.snapshot(), 'fast').hardStop, true);
    assert.equal(h.agent.readReceipt(h.adapter.snapshot(), 'slow').hardStop, true);
    await h.clock.advance(20 * MINUTE); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 0);
    await h.user('我又回来聊了'); assert.equal(h.agent.state.archives[0].decisions.STOP, 1);
});

test('STOP 仅双阶段可用且不能夹带台词或场景内容', () => {
    assert.throws(() => parseDecision(JSON.stringify(stop())), { code: 'INVALID_ACTION' });
    assert.equal(parseDecision(JSON.stringify(stop()), { dualPhase: true }).action, 'STOP');
    assert.throws(() => parseDecision(JSON.stringify(stop('再说一句')), { dualPhase: true, scene: true }), { code: 'INVALID_STOP' });
    assert.equal(parseDecision(JSON.stringify(stop('')), { dualPhase: true, scene: true }).narration, null);
});

test('玩家返回时重建快阶段，慢阶段的迟到消息必须丢弃', async () => {
    const h = dual(), pending = deferred(); h.responses.push(decision('END'), () => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE); assert.equal(h.agent.episode().phase, 'slow');
    const old = h.agent.episode().id; await h.user('我回来了');
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.notEqual(h.agent.episode().id, old); assert.equal(h.agent.episode().phase, 'fast'); assert.equal(h.rendered.length, 0);
});

test('快阶段在途请求跨过自身上限，先丢弃迟到结果，再按门槛进入慢阶段', async () => {
    const h = dual({ fastPhaseMaxMinutes: 1, timeoutSeconds: 300 }), pending = deferred();
    h.responses.push(() => pending.promise, decision('END'));
    await h.user(); await h.clock.advance(MINUTE); assert.equal(h.agent.episode().phase, 'between');
    assert.equal(h.agent.inFlight, true); pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); await h.clock.advance(4 * MINUTE); assert.equal(h.calls.length, 2);
});

test('整轮寿命短于慢阶段门槛时直接结束，不补发', async () => {
    const h = dual({ maxWaitMinutes: 3 }); h.responses.push(decision('END'));
    await h.user(); await h.clock.advance(10 * MINUTE); assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().status, 'ENDED');
});

test('两页共享阶段收尾及慢阶段去重，只会慢速发送一次', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({ dualPhaseEnabled: true }, shared), b = harness({ dualPhaseEnabled: true }, shared);
    a.responses.push(decision('END'), decision('SEND_MESSAGE'));
    await a.user('同一条'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    await a.clock.advance(10_000); await b.clock.advance(10_000); assert.equal(b.agent.episode().phase, 'between');
    await a.clock.advance(5 * MINUTE - 10_000); await b.clock.advance(5 * MINUTE - 10_000);
    assert.equal(a.rendered.length + b.rendered.length, 1); assert.equal(b.calls.length, 0);
});

test('一页手动取消阶段间等待，另一页不能继续慢速联系', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({ dualPhaseEnabled: true }, shared), b = harness({ dualPhaseEnabled: true }, shared);
    a.responses.push(decision('END')); await a.user('同一条'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    await a.clock.advance(10_000); await b.clock.advance(10_000); await a.agent.cancel();
    await b.clock.advance(10 * MINUTE); assert.equal(b.calls.length, 0); assert.equal(b.agent.episode().status, 'ENDED');
});

test('既有慢阶段联系冷却仍跨聊天生效，快阶段发送不抹除它', async () => {
    const h = dual(); h.coordinator.slowContact('xiaoqing.png', h.clock.now());
    h.responses.push(decision('SEND_MESSAGE'), decision('END'), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().slowSentCount, 0);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 25 * MINUTE);
});

test('门槛内没有逐秒空轮询，快 END 后只剩一个门槛定时器', async () => {
    const h = dual(); h.responses.push(decision('END')); await h.user(); await h.clock.advance(10_000);
    assert.equal(h.clock.timers.size, 1); await h.clock.advance(4 * MINUTE); assert.equal(h.calls.length, 1);
});
