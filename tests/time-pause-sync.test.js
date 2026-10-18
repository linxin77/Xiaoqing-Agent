import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';
import { MINUTE, KEY } from '../modules/settings.js';

async function pair() {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({ dualPhaseEnabled: true, maxMessages: 5 }, shared);
    const b = harness({ dualPhaseEnabled: true, maxMessages: 5 }, shared);
    await a.user('同一个测试消息'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    return { a, b, shared };
}

test('同一聊天另一页即使错过storage事件，到检查时也先冻结，不调用模型', async () => {
    const { a, b } = await pair(); b.responses.push(decision('SEND_MESSAGE'));
    await a.clock.advance(3000); await b.clock.advance(3000); await a.agent.setHold(true);
    await b.clock.advance(60_000);
    assert.equal(b.calls.length, 0); assert.equal(b.rendered.length, 0);
    assert.equal(b.agent.state.hold.since, a.clock.now());
});

test('模拟storage通知立即同步暂停和继续，首检仍剩七秒', async () => {
    const { a, b } = await pair(); b.responses.push(decision('SEND_MESSAGE'));
    await a.clock.advance(3000); await b.clock.advance(3000); await a.agent.setHold(true); await b.agent.timePauseChanged();
    await a.clock.advance(60_000); await b.clock.advance(60_000);
    await a.agent.setHold(false); await b.agent.timePauseChanged();
    assert.equal(b.agent.state.hold, null); assert.equal(b.agent.episode().dueAt - b.clock.now(), 7000);
    await b.clock.advance(6999); assert.equal(b.calls.length, 0); await b.clock.advance(1); assert.equal(b.calls.length, 1);
    assert.equal(b.agent.episode().pausedMilliseconds, 60_000);
});

test('另一页的在途结果提交前重新检查共享暂停，不能推进世界', async () => {
    const { a, b } = await pair(), pending = deferred(); b.responses.push(() => pending.promise);
    await b.clock.advance(10_000); await a.clock.advance(10_000); assert.equal(b.calls.length, 1); await a.agent.setHold(true);
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(b.rendered.length, 0); assert.equal(b.agent.episode().outputCount, 0);
    assert.ok(b.agent.state.hold); assert.equal(b.agent.episode().status, 'WAITING');
});

test('另一页错过多次暂停继续时累计时长一次补齐，刷新和重复通知不再累加', async () => {
    const { a, b } = await pair(); await a.clock.advance(1000); await a.agent.setHold(true);
    await a.clock.advance(20_000); await a.agent.setHold(false); await a.agent.setHold(true);
    await a.clock.advance(30_000); await a.agent.setHold(false);
    b.clock.time = a.clock.now(); await b.agent.tick();
    assert.equal(b.agent.episode().pausedMilliseconds, 50_000);
    assert.equal(b.agent.episode().dueAt - b.clock.now(), 9000);
    const due = b.agent.episode().dueAt;
    await b.agent.timePauseChanged(); await b.agent.load(); assert.equal(b.agent.episode().dueAt, due);
    assert.equal(b.agent.episode().pausedMilliseconds, 50_000); assert.equal(b.calls.length, 0);
});

test('暂停中发新消息只计算新消息之后的暂停时间，另一页继续也不会多算', async () => {
    const { a, b } = await pair(); await a.agent.setHold(true);
    await a.clock.advance(60_000); await a.user('新的测试消息');
    await b.clock.advance(90_000); await b.agent.setHold(false);
    await a.clock.advance(30_000); await a.agent.timePauseChanged();
    assert.equal(a.agent.episode().pausedMilliseconds, 30_000);
    assert.equal(a.agent.episode().dueAt - a.clock.now(), 10_000);
});

test('暂停状态按聊天隔离；从另一页继续后，暂停页面恢复计时', async () => {
    const { a, b } = await pair(); await a.agent.setHold(true); await b.agent.timePauseChanged();
    b.ctx.chatId = '其他聊天'; b.ctx.chat = []; b.ctx.chatMetadata = {}; await b.agent.load();
    assert.equal(b.agent.state.hold, null);
    b.ctx.chatId = 'chat-A'; b.ctx.chat = structuredClone(a.ctx.chat); b.ctx.chatMetadata = {}; await b.agent.load();
    assert.ok(b.agent.state.hold); await b.agent.setHold(false); await a.agent.timePauseChanged();
    assert.equal(a.agent.state.hold, null);
});

test('旧版仅元数据中的暂停自动迁移，共享暂停后仍保持原剩余时间', async () => {
    const h = harness({ dualPhaseEnabled: true, maxMessages: 5 }); await h.user(); await h.clock.advance(3000);
    h.ctx.chatMetadata[KEY].hold = { since: h.clock.now() };
    h.agent.scheduler.cancel(); // 模拟旧页面已关闭，只有旧元数据保留下来。
    await h.clock.advance(20_000); await h.agent.load(); assert.ok(h.agent.state.hold);
    await h.agent.setHold(false);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 7000);
    assert.equal(h.agent.episode().pausedMilliseconds, 20_000);
});

test('共享暂停记录不含聊天文本，损坏时停止而不继续输出', async () => {
    const { a, b, shared } = await pair(); await a.agent.setHold(true);
    const key = a.coordinator.timePauseKey(a.adapter.snapshot());
    assert.doesNotMatch(shared.local.getItem(key), /同一个测试消息|小晴/);
    shared.local.setItem(key, '{bad'); await b.clock.advance(10_000);
    assert.equal(b.calls.length, 0); assert.equal(b.agent.episode().status, 'PAUSED');
});

test('缓冲回复也在最终提交前服从其他标签页暂停', async () => {
    const { a, b } = await pair(), pending = deferred(); b.responses.push(() => pending.promise);
    await b.normalUser('接着说'); await b.clock.advance(5000); await a.clock.advance(5000); await a.agent.setHold(true);
    pending.resolve(JSON.stringify({ action: 'REPLY', message: '不应显示', next_check_seconds: null, thought: '', pending_intention: null }));
    await drain(); assert.equal(b.rendered.length, 0); assert.ok(b.agent.state.hold);
});

test('门槛等待的跨页暂停不会把暂停时长当成玩家沉默', async () => {
    const { a, b } = await pair(); a.responses.push(decision('END')); b.responses.push(decision('END'));
    await a.clock.advance(10_000); await b.clock.advance(10_000);
    await a.agent.setHold(true); await b.agent.timePauseChanged();
    await a.clock.advance(10 * MINUTE); await b.clock.advance(10 * MINUTE);
    await a.agent.setHold(false); await b.agent.timePauseChanged();
    assert.equal(b.agent.episode().phase, 'between'); assert.equal(b.agent.episode().dueAt - b.clock.now(), 290_000);
    assert.equal(b.agent.effectiveNow() - b.agent.episode().startAt, 10_000);
});

test('关闭接话缓冲时，时间暂停仍拦住普通即时回复，继续后处理一次再恢复原设置', async () => {
    const h = harness({ bufferEnabled: false }); await h.agent.load(); await h.agent.setHold(true);
    assert.equal(await h.normalUser('先留一句话'), true);
    await h.clock.advance(20 * MINUTE); assert.equal(h.calls.length, 0);
    h.responses.push({ action: 'REPLY', message: '现在时间继续了。', next_check_seconds: null, thought: '', pending_intention: null });
    await h.agent.setHold(false); await h.clock.advance(5000);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.settings().bufferEnabled, false);
    assert.equal(await h.normalUser('现在普通发送'), false);
});

test('暂停正在生成的普通回复时调用酒馆公开停止接口，保留时间暂停而非错误暂停', async () => {
    const h = harness(); await h.user(); let stopped = 0;
    h.ctx.stopGeneration = () => { stopped++; void h.events.emit('GENERATION_STOPPED'); };
    h.agent.busy = true; await h.agent.setHold(true); await drain();
    assert.equal(stopped, 1); assert.ok(h.agent.state.hold); assert.equal(h.agent.episode().status, 'WAITING');
    assert.equal(h.agent.busy, false);
});

test('时间暂停引起的停止事件不会丢失待接话消息', async () => {
    const h = harness(); await h.normalUser('暂停前保留的消息');
    h.ctx.stopGeneration = () => { void h.events.emit('GENERATION_STOPPED'); }; h.agent.busy = true;
    await h.agent.setHold(true); await drain(); assert.equal(h.agent.buffer.state.status, 'BUFFERING');
    h.responses.push({ action: 'REPLY', message: '继续接着聊。', next_check_seconds: null, thought: '', pending_intention: null });
    await h.agent.setHold(false); await h.clock.advance(5000); assert.equal(h.rendered.length, 1);
});

test('给模型的距离上次决策时间也扣除暂停，避免角色误以为世界过去很久', async () => {
    const h = harness({ dualPhaseEnabled: true, maxMessages: 5 });
    h.responses.push(decision('WAIT'), decision('WAIT')); await h.user(); await h.clock.advance(10_000);
    await h.agent.setHold(true); await h.clock.advance(20 * MINUTE); await h.agent.setHold(false);
    await h.clock.advance(10_000);
    const environment = JSON.parse(h.calls[1].prompt.split('\n')[1]).environment;
    assert.equal(environment.silence_minutes, 20 / 60);
    assert.equal(environment.since_last_decision_minutes, 10 / 60);
    assert.equal(environment.test_since_last_decision_minutes, 10);
});
