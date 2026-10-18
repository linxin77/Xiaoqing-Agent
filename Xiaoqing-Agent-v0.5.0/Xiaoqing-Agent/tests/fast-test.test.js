import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';
import { normalizeSettings, MINUTE } from '../modules/settings.js';

const fast = extra => harness({ fastTestEnabled: true, ...extra });
const sceneDecision = (action, narration = '') => decision(action, { narration });
const data = call => JSON.parse(call.prompt.split('\n')[1]);

test('测试构建默认快测10秒，正常分钟值保留且仍需原启用与发送权限', () => {
    const s = normalizeSettings();
    assert.equal(s.fastTestEnabled, true); assert.equal(s.fastTestSeconds, 10);
    assert.equal(s.enabled, false); assert.equal(s.allowSend, false);
    assert.equal(s.firstCheckMinutes, 5); assert.equal(s.contactGapMinutes, 30);
    assert.equal(normalizeSettings({ fastTestSeconds: 0 }).fastTestSeconds, 1);
    assert.equal(normalizeSettings({ fastTestSeconds: 999 }).fastTestSeconds, 999);
    assert.equal(normalizeSettings({ fastTestSeconds: 99999 }).fastTestSeconds, 3600);
    assert.equal(normalizeSettings({ fastTestEnabled: false }).fastTestEnabled, false);
});

test('纯聊天10秒首检，AI提出120分钟WAIT仍只等10秒再判断并发送', async () => {
    const h = fast(); h.responses.push(decision('WAIT', { next_check_minutes: 120 }), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(9999); assert.equal(h.calls.length, 0);
    await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 0);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 10_000);
    await h.clock.advance(10_000); assert.equal(h.calls.length, 2); assert.equal(h.rendered.length, 1);
    assert.equal(h.agent.episode().status, 'ENDED');
    assert.match(h.calls[0].systemPrompt, /快速测试/);
    assert.equal(data(h.calls[0]).environment.test_silence_minutes, 10);
    assert.equal(data(h.calls[0]).environment.silence_minutes, 10 / 60);
    assert.equal(data(h.calls[1]).environment.test_since_last_decision_minutes, 10);
});

test('场景同样10秒先展示动作，长WAIT压缩，后续对白和动作一起提交', async () => {
    const h = fast({ maxMessages: 3 }); await h.agent.load(); await h.agent.setInteractionMode('scene');
    h.responses.push({ ...sceneDecision('WAIT', '团团转身去贴标签。'), next_check_minutes: 30 },
        sceneDecision('SEND_MESSAGE', '她贴好一张标签，抬头看向柜台。'), sceneDecision('END'));
    await h.user(); await h.clock.advance(10_000);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 10_000);
    await h.clock.advance(10_000); assert.equal(h.rendered.length, 2);
    assert.equal(h.agent.episode().sentCount, 1); assert.equal(h.agent.episode().narrationCount, 2);
    assert.match(h.calls[1].prompt, /团团转身去贴标签/);
    assert.match(h.calls[0].systemPrompt, /场景角色扮演/); assert.match(h.calls[0].systemPrompt, /快速测试/);
    await h.clock.advance(10_000); assert.equal(h.agent.episode().status, 'ENDED');
});

test('对白冷却也改为10秒，最近刚联系过仍能在测试间隔后发送两次', async () => {
    const h = fast({ maxMessages: 2 }); h.coordinator.contact('xiaoqing.png', h.clock.now());
    h.responses.push(decision('SEND_MESSAGE'), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(20_000);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().status, 'ENDED');
});

test('启用快测缩短正在等待的任务，旧分钟收据不继续卡住首个测试判断', async () => {
    const h = harness({ firstCheckMinutes: 1 }); h.responses.push(decision('WAIT', { next_check_minutes: 30 }), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 30 * MINUTE);
    h.storage.saveSettings({ ...h.agent.settings(), fastTestEnabled: true }); await h.agent.settingsChanged();
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 10_000);
    await h.clock.advance(10_000); assert.equal(h.calls.length, 2); assert.equal(h.rendered.length, 1);
});

test('关闭快测恢复保存的分钟设置，当前任务也按正式最短间隔继续', async () => {
    const h = fast({ firstCheckMinutes: 2, minCheckMinutes: 3, contactGapMinutes: 15 });
    h.responses.push(decision('WAIT', { next_check_minutes: 30 }), decision('END'));
    await h.user(); await h.clock.advance(10_000);
    h.storage.saveSettings({ ...h.agent.settings(), fastTestEnabled: false }); await h.agent.settingsChanged();
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 3 * MINUTE);
    assert.equal(h.agent.settings().firstCheckMinutes, 2); assert.equal(h.agent.settings().contactGapMinutes, 15);
    await h.clock.advance(3 * MINUTE - 1); assert.equal(h.calls.length, 1);
    await h.clock.advance(1); assert.equal(h.calls.length, 2);
    assert.doesNotMatch(h.calls[1].systemPrompt, /用户明确开启了快速测试/);
});

test('快测修改秒数立即生效，刷新不重置同一配置的倒计时', async () => {
    const h = fast(); h.responses.push(decision('WAIT'), decision('END'));
    await h.user(); await h.clock.advance(10_000);
    h.storage.saveSettings({ ...h.agent.settings(), fastTestSeconds: 3 }); await h.agent.settingsChanged();
    const due = h.agent.episode().dueAt;
    await h.clock.advance(1000); await h.agent.load(); assert.equal(h.agent.episode().dueAt, due);
    await h.clock.advance(2000); assert.equal(h.calls.length, 2);
});

test('快测失败重试也是10秒，仍遵守有限次数', async () => {
    const h = fast({ maxRetries: 1 }); h.responses.push('invalid', 'invalid');
    await h.user(); await h.clock.advance(20_000);
    assert.equal(h.calls.length, 2); assert.equal(h.agent.episode().status, 'PAUSED'); assert.equal(h.rendered.length, 0);
});

test('快测仍能冻结构思时间，暂停一小时后保留7秒首检', async () => {
    const h = fast(); h.responses.push(decision('SEND_MESSAGE')); await h.user();
    await h.clock.advance(3000); await h.agent.setHold(true); await h.clock.advance(60 * MINUTE);
    assert.equal(h.calls.length, 0); await h.agent.setHold(false);
    assert.equal(h.agent.episode().deadlineAt - h.clock.now(), 5 * MINUTE - 3000);
    await h.clock.advance(6999); assert.equal(h.calls.length, 0); await h.clock.advance(1); assert.equal(h.calls.length, 1);
    assert.equal(data(h.calls[0]).environment.test_silence_minutes, 10);
});

test('快测尊重免打扰与5分钟任务上限，不无限轮询', async () => {
    const quiet = fast({ dndEnabled: true, dndStart: '00:00', dndEnd: '00:00' });
    await quiet.user(); await quiet.clock.advance(5 * MINUTE);
    assert.equal(quiet.calls.length, 0); assert.equal(quiet.agent.episode().status, 'ENDED');
    const h = fast(); h.responses.push(...Array.from({ length: 40 }, () => decision('WAIT')));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 29); assert.equal(h.agent.episode().status, 'ENDED');
    await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 29);
});

test('快测仍校验发送权限；关闭主开关不会调用模型', async () => {
    const h = fast({ allowSend: false }); h.responses.push(decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(10_000); assert.equal(h.rendered.length, 0);
    assert.equal(h.agent.episode().history[0].outcome, 'BLOCKED_BY_POLICY');
    const off = fast({ enabled: false }); await off.user(); await off.clock.advance(5 * MINUTE); assert.equal(off.calls.length, 0);
});

test('切换快测配置时正在生成的旧结果必须丢弃', async () => {
    const h = fast(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(10_000);
    h.storage.saveSettings({ ...h.agent.settings(), fastTestEnabled: false }); await h.agent.settingsChanged();
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().dueAt - h.clock.now(), 5 * MINUTE);
});

test('两标签同一快测任务仍只发送一次，不清空去重或消息次数', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({ fastTestEnabled: true }, shared), b = harness({ fastTestEnabled: true }, shared);
    a.responses.push(decision('SEND_MESSAGE')); b.responses.push(decision('SEND_MESSAGE'));
    await a.user('同一条'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    await a.clock.advance(10_000); await b.clock.advance(10_000);
    assert.equal(a.rendered.length + b.rendered.length, 1); assert.equal(b.calls.length, 0);
});
