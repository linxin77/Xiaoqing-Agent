import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';
import { KEY, MINUTE } from '../modules/settings.js';

const scene = (action = 'WAIT', text = '她继续整理货架。') => decision(action, { narration: text });
async function setup(settings = {}, shared) {
    const h = harness({ maxMessages: 3, firstCheckMinutes: 1, minCheckMinutes: 1, ...settings }, shared);
    await h.agent.load(); await h.agent.setInteractionMode('scene'); return h;
}

test('关闭对白权限后纯动作仍严格最多三条，不会无限追加', async () => {
    const h = await setup({ allowSend: false });
    h.responses.push(...Array.from({ length: 8 }, () => scene('WAIT')));
    await h.user(); await h.clock.advance(100 * MINUTE);
    assert.equal(h.rendered.length, 3); assert.equal(h.calls.length, 3);
    assert.equal(h.agent.episode().outputCount, 3); assert.equal(h.agent.episode().sentCount, 0);
    assert.equal(h.agent.episode().status, 'ENDED');
});

test('上限一时第一条纯动作就结束，后续刷新、增大上限均不复活', async () => {
    const h = await setup({ maxMessages: 1 }); h.responses.push(scene(), scene());
    await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.agent.episode().status, 'ENDED');
    await h.agent.load(); h.storage.saveSettings({ ...h.agent.settings(), maxMessages: 3 });
    await h.agent.settingsChanged(); await h.clock.advance(30 * MINUTE);
    assert.equal(h.rendered.length, 1); assert.equal(h.calls.length, 1);
});

test('每次动作和对白合并一条，三条气泡只占三次而不是六次', async () => {
    const h = await setup({ contactGapMinutes: 5, minCheckMinutes: 5 });
    h.responses.push(...Array.from({ length: 4 }, () => scene('SEND_MESSAGE')));
    await h.user(); await h.clock.advance(40 * MINUTE);
    assert.equal(h.rendered.length, 3); assert.equal(h.agent.episode().outputCount, 3);
    assert.equal(h.agent.episode().narrationCount, 3); assert.equal(h.agent.episode().sentCount, 3);
    assert.equal(h.agent.episode().status, 'ENDED');
});

test('降低上限立即停止，切换模式与恢复按钮不能重置已用次数', async () => {
    const h = await setup(); h.responses.push(scene()); await h.user(); await h.clock.advance(MINUTE);
    h.storage.saveSettings({ ...h.agent.settings(), maxMessages: 1 }); await h.agent.settingsChanged();
    await h.agent.setInteractionMode('chat'); await h.agent.resume(); await h.clock.advance(30 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().outputCount, 1);
    assert.equal(h.agent.episode().status, 'ENDED');
});

test('旧任务缺少总计数时从实际聊天恢复，三条旁白不会再获得三条额度', async () => {
    const h = await setup(); h.responses.push(scene(), scene(), scene()); await h.user();
    await h.clock.advance(25 * MINUTE);
    const saved = h.ctx.chatMetadata[KEY].episode;
    delete saved.outputCount; saved.narrationCount = 0; saved.status = 'WAITING';
    await h.agent.load(); await h.clock.advance(30 * MINUTE);
    assert.equal(h.agent.episode().outputCount, 3); assert.equal(h.agent.episode().status, 'ENDED');
    assert.equal(h.calls.length, 3);
});

test('删除已展示动作不会退还已消费额度，收据也不会被较小计数覆盖', async () => {
    const h = await setup(); h.responses.push(scene(), scene(), scene()); await h.user();
    await h.clock.advance(MINUTE); h.ctx.chat.splice(1, 1);
    await h.events.emit('MESSAGE_DELETED', 1); await h.agent.load(); await h.clock.advance(30 * MINUTE);
    assert.equal(h.rendered.length, 3); assert.equal(h.agent.episode().outputCount, 3);
    const snapshot = h.adapter.snapshot();
    h.coordinator.write(snapshot, { sentCount: 0, outputCount: 0, nextAt: 0, closed: false }, h.clock.now());
    assert.equal(h.coordinator.read(snapshot).outputCount, 3);
});

test('纯聊天的空等待不占额度，正常缓冲回复也不占自主额度', async () => {
    const h = harness({ maxMessages: 1, firstCheckMinutes: 1, minCheckMinutes: 1 });
    h.responses.push({ action: 'REPLY', message: '接着说吧。', next_check_seconds: null, thought: '', pending_intention: null },
        decision('WAIT', { next_check_minutes: 1 }), decision('SEND_MESSAGE'));
    await h.normalUser('我有件事想说'); await h.clock.advance(5000);
    assert.equal(h.agent.episode().outputCount, 0);
    await h.clock.advance(MINUTE - 5000); assert.equal(h.agent.episode().outputCount, 0);
    await h.clock.advance(MINUTE); assert.equal(h.agent.episode().outputCount, 1);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().status, 'ENDED');
});

test('单条总额度的双阶段场景立即结束整轮，不在五分钟后绕过', async () => {
    const h = await setup({ dualPhaseEnabled: true, maxMessages: 1 }); h.responses.push(scene(), scene());
    await h.user(); await h.clock.advance(10_000);
    assert.equal(h.agent.episode().status, 'ENDED'); await h.clock.advance(60 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
});

test('双阶段两页共享动作总计数，快二慢一后任一页都不能追加第四条', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = await setup({ dualPhaseEnabled: true }, shared), b = await setup({ dualPhaseEnabled: true }, shared);
    a.responses.push(scene(), scene(), scene('END', ''), scene(), scene()); b.responses.push(scene(), scene());
    await a.user('同一条'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    await a.clock.advance(30_000); await b.clock.advance(30_000);
    assert.equal(b.calls.length, 0); assert.equal(b.agent.episode().outputCount, 2);
    await a.clock.advance(5 * MINUTE - 30_000); await b.clock.advance(5 * MINUTE - 30_000);
    await a.clock.advance(30 * MINUTE); await b.clock.advance(30 * MINUTE);
    assert.equal(a.rendered.length + b.rendered.length, 3); assert.equal(b.calls.length, 0);
    assert.equal(b.agent.episode().outputCount, 3); assert.equal(b.agent.episode().status, 'ENDED');
});

test('在途动作生成时降低额度，迟到输出必须丢弃', async () => {
    const h = await setup(), pending = deferred(); h.responses.push(scene(), () => pending.promise);
    await h.user(); await h.clock.advance(11 * MINUTE);
    h.storage.saveSettings({ ...h.agent.settings(), maxMessages: 1 }); await h.agent.settingsChanged();
    pending.resolve(JSON.stringify(scene())); await drain();
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().outputCount, 1);
    assert.equal(h.agent.episode().status, 'ENDED');
});

test('渲染失败的预留输出也占总额度，刷新后不重复尝试已提交动作', async () => {
    const h = await setup({ maxMessages: 1 }); h.ctx.addOneMessage = () => { throw new Error('模拟渲染失败'); };
    h.responses.push(scene(), scene()); await h.user(); await h.clock.advance(MINUTE);
    assert.equal(h.agent.episode().outputCount, 1); assert.equal(h.agent.episode().status, 'ENDED');
    await h.agent.load(); await h.clock.advance(30 * MINUTE); assert.equal(h.calls.length, 1);
});

test('五次是默认可调上限，设置七次可实际输出七次，之后严格停止', async () => {
    const h = await setup({ maxMessages: 7, fastTestEnabled: true, fastTestSeconds: 2 });
    h.responses.push(...Array.from({ length: 9 }, () => scene())); await h.user();
    await h.clock.advance(14_000);
    assert.equal(h.rendered.length, 7); assert.equal(h.agent.episode().outputCount, 7);
    assert.equal(h.agent.episode().status, 'ENDED'); await h.clock.advance(30 * MINUTE);
    assert.equal(h.calls.length, 7);
});

test('快阶段可用满共享五条并结束整轮，不强制预留或补发慢阶段', async () => {
    const h = await setup({ dualPhaseEnabled: true, maxMessages: 5 });
    h.responses.push(...Array.from({ length: 8 }, () => scene())); await h.user(); await h.clock.advance(50_000);
    assert.equal(h.agent.episode().fastOutputCount, 5); assert.equal(h.agent.episode().status, 'ENDED');
    await h.clock.advance(30 * MINUTE); assert.equal(h.calls.length, 5); assert.equal(h.rendered.length, 5);
});

test('五条共享额度可以快二慢三，END提前收尾不要求用满快阶段', async () => {
    const h = await setup({ dualPhaseEnabled: true, maxMessages: 5, contactGapMinutes: 1 });
    h.responses.push(scene(), scene(), scene('END', ''), scene('SEND_MESSAGE'), scene('SEND_MESSAGE'), scene('SEND_MESSAGE'), scene());
    await h.user(); await h.clock.advance(30_000);
    assert.equal(h.agent.episode().phase, 'between'); assert.equal(h.agent.episode().outputCount, 2);
    await h.clock.advance(7 * MINUTE - 30_000);
    assert.equal(h.agent.episode().fastOutputCount, 2); assert.equal(h.agent.episode().slowOutputCount, 3);
    assert.equal(h.agent.episode().outputCount, 5); assert.equal(h.agent.episode().status, 'ENDED');
    assert.equal(h.rendered.length, 5); assert.equal(h.calls.length, 6);
});

test('场景无可见更新的WAIT不消耗额度，也不阻止按可调时限结束快阶段', async () => {
    const h = await setup({ dualPhaseEnabled: true, maxMessages: 5, fastPhaseMaxMinutes: 1, slowStartMinutes: 2 });
    h.responses.push(...Array.from({ length: 5 }, () => scene('WAIT', '')), scene('END', ''));
    await h.user(); await h.clock.advance(2 * MINUTE);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().outputCount, 0);
    assert.equal(h.calls.length, 6); assert.equal(h.agent.episode().status, 'ENDED');
    assert.match(h.calls[0].systemPrompt, /不需要使用完所有自主行动机会/);
    assert.match(h.calls[0].systemPrompt, /不要求每段时间都有值得展示的事情/);
});
