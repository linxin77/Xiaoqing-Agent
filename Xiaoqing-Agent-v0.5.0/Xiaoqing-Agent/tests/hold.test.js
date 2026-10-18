import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain } from './helpers.js';
import { MINUTE } from '../modules/settings.js';

test('构思暂停冻结首检与最长寿命，数小时后继续仍从剩余时间运行', async () => {
    const h = harness({ maxWaitMinutes: 10 }); h.responses.push(decision('WAIT', { next_check_minutes: 30 }));
    await h.user(); await h.clock.advance(2 * MINUTE); await h.agent.setHold(true);
    const frozen = h.agent.effectiveNow(); await h.clock.advance(600 * MINUTE);
    assert.equal(h.calls.length, 0); assert.equal(h.agent.effectiveNow(), frozen);
    await h.agent.setHold(false); assert.equal(h.agent.episode().deadlineAt - h.clock.now(), 8 * MINUTE);
    await h.clock.advance(3 * MINUTE - 1); assert.equal(h.calls.length, 0);
    await h.clock.advance(1); assert.equal(h.calls.length, 1);
    const data = JSON.parse(h.calls[0].prompt.split('\n')[1]);
    assert.equal(data.environment.silence_minutes, 5); assert.equal(data.environment.excluded_pause_minutes, 600);
    await h.clock.advance(5 * MINUTE); assert.equal(h.agent.episode().status, 'ENDED');
});

test('暂停状态跨刷新保持；继续不会偷偷复活手动取消的任务', async () => {
    const h = harness(); await h.user(); await h.clock.advance(MINUTE); await h.agent.setHold(true);
    await h.clock.advance(500 * MINUTE); await h.agent.load(); assert.ok(h.agent.state.hold);
    assert.equal(h.agent.episode().status, 'WAITING'); await h.agent.cancel(); await h.agent.setHold(false);
    assert.equal(h.agent.episode().status, 'CANCELED'); await h.clock.advance(30 * MINUTE); assert.equal(h.calls.length, 0);
});

test('构思暂停按聊天隔离，切换聊天后不会继承别的聊天暂停', async () => {
    const h = harness(); await h.agent.load(); await h.agent.setHold(true);
    const a = structuredClone(h.ctx.chatMetadata), owner = h.agent.state.owner;
    h.ctx.chatId = 'B'; h.ctx.chatMetadata = {}; await h.agent.load(); assert.equal(h.agent.state.hold, null);
    assert.equal(await h.agent.setHold(false, owner), false);
    h.ctx.chatId = 'chat-A'; h.ctx.chatMetadata = a; await h.agent.load(); assert.ok(h.agent.state.hold);
});

test('模型返回中点暂停，动作与对白均丢弃，继续不并发启动第二个请求', async () => {
    const h = harness(), pending = deferred(); await h.agent.load(); await h.agent.setInteractionMode('scene');
    h.responses.push(() => pending.promise); await h.user(); await h.clock.advance(5 * MINUTE);
    await h.agent.setHold(true); await h.clock.advance(20 * MINUTE); await h.agent.setHold(false);
    await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 1);
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE', { narration: '过期动作' }))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().narrationCount, 0);
});

test('秒级接话也冻结剩余时间，继续之后只回复一次', async () => {
    const h = harness(); h.responses.push({ action: 'REPLY', message: '准备好了我们再聊。', next_check_seconds: null, thought: '不催促。', pending_intention: null });
    await h.normalUser('我想一下'); await h.clock.advance(2000); await h.agent.setHold(true);
    await h.clock.advance(300 * MINUTE); assert.equal(h.calls.length, 0); await h.agent.setHold(false);
    await h.clock.advance(2999); assert.equal(h.calls.length, 0); await h.clock.advance(1);
    assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
});

test('暂停时继续发送会创建新的冻结任务，继续后再合并接话', async () => {
    const h = harness(); await h.agent.load(); await h.agent.setHold(true);
    await h.clock.advance(50 * MINUTE); assert.equal(await h.normalUser('先说前半句'), true);
    await h.clock.advance(10 * MINUTE); assert.equal(await h.normalUser('现在补上后半句'), true);
    await h.clock.advance(200 * MINUTE); assert.equal(h.calls.length, 0);
    h.responses.push({ action: 'REPLY', message: '听完了。', next_check_seconds: null, thought: '接着聊。', pending_intention: null });
    await h.agent.setHold(false); assert.equal(h.agent.episode().dueAt - h.clock.now(), 5 * MINUTE);
    await h.clock.advance(5000); assert.equal(h.rendered.length, 1);
    assert.match(h.calls[0].prompt, /先说前半句\\n现在补上后半句/);
});

test('纯聊天模式同样可以暂停，并且重复点击同一状态不重复延长寿命', async () => {
    const h = harness(); await h.user(); await h.clock.advance(MINUTE); await h.agent.setHold(true);
    await h.clock.advance(10 * MINUTE); await h.agent.setHold(true); await h.clock.advance(10 * MINUTE);
    await h.agent.setHold(false); const deadline = h.agent.episode().deadlineAt;
    await h.agent.setHold(false); assert.equal(h.agent.episode().deadlineAt, deadline);
    assert.equal(h.agent.episode().pausedMilliseconds, 20 * MINUTE);
});
