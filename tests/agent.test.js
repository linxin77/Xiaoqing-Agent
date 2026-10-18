import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, MINUTE } from '../modules/settings.js';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';

test('首次 5 分钟只进行模型决策，WAIT 不强制发消息', async () => {
    const h = harness(); h.responses.push(decision('WAIT')); await h.user();
    await h.clock.advance(5 * MINUTE - 1); assert.equal(h.calls.length, 0);
    await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 0);
    assert.equal(h.agent.episode().status, 'WAITING');
});
test('连续 WAIT 10、WAIT 20、SEND 正确调度并带回此前决策', async () => {
    const h = harness(); h.responses.push(decision('WAIT'), decision('WAIT', { next_check_minutes: 20 }), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(5 * MINUTE); await h.clock.advance(10 * MINUTE - 1);
    assert.equal(h.calls.length, 1); await h.clock.advance(1); assert.equal(h.calls.length, 2);
    await h.clock.advance(20 * MINUTE); assert.equal(h.calls.length, 3); assert.equal(h.rendered.length, 1);
    assert.match(h.calls[2].prompt, /"action":"WAIT"/); assert.match(h.calls[2].prompt, /"elapsed_minutes":15/);
    assert.match(h.calls[2].prompt, /有些好奇/); assert.equal(h.agent.episode().sentCount, 1);
    assert.equal(h.agent.episode().status, 'ENDED');
    assert.equal(h.ctx.chat.at(-1).is_user, false); assert.ok(h.ctx.chat.at(-1).extra.xiaoqing_agent);
    assert.equal(h.ctx.chatMetadata[KEY].episode.history.at(-1).outcome, 'SENT');
});
test('用户中途回复取消旧任务，重新从首次间隔计时', async () => {
    const h = harness(); h.responses.push(decision('WAIT', { next_check_minutes: 30 }), decision('END'));
    await h.user(); await h.clock.advance(5 * MINUTE); const oldId = h.agent.episode().id;
    await h.clock.advance(10 * MINUTE); await h.user('我回来啦'); assert.notEqual(h.agent.episode().id, oldId);
    assert.equal(h.agent.state.archives[0].status, 'CANCELED'); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 2); await h.clock.advance(120 * MINUTE); assert.equal(h.calls.length, 2);
});
test('模型生成途中用户回复：迟到 SEND 必须丢弃', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE); assert.equal(h.agent.episode().status, 'CHECKING');
    await h.user('不用追问了'); const newId = h.agent.episode().id;
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().id, newId); assert.equal(h.agent.episode().status, 'WAITING');
});
test('切换角色或聊天后不能把 A 的消息发到 B', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE);
    const aMetadata = structuredClone(h.ctx.chatMetadata);
    h.ctx.characters.push({ name: 'B', avatar: 'b.png', description: '冷静', data: {} });
    h.ctx.characterId = 1; h.ctx.chatId = 'chat-B'; h.ctx.chat = []; h.ctx.chatMetadata = {};
    await h.events.emit('CHAT_CHANGED'); await drain(); pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.ctx.chat.length, 0); assert.equal(h.rendered.length, 0); assert.equal(h.agent.state.owner.includes('b.png'), true);
    assert.equal(aMetadata[KEY].episode.status, 'CHECKING');
});
test('最大等待截止时停止，即使模型一直选择长时间 WAIT', async () => {
    const h = harness(); h.responses.push(decision('WAIT', { next_check_minutes: 999999 }));
    await h.user(); await h.clock.advance(180 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().status, 'ENDED');
    assert.equal(h.clock.timers.size, 0); await h.clock.advance(180 * MINUTE); assert.equal(h.calls.length, 1);
});
test('首检晚于最长等待时，不调用模型', async () => {
    const h = harness({ firstCheckMinutes: 5, maxWaitMinutes: 3 }); await h.user(); await h.clock.advance(3 * MINUTE);
    assert.equal(h.agent.episode().status, 'ENDED'); assert.equal(h.calls.length, 0);
});
test('END 立即终止，不再创建后续检查', async () => {
    const h = harness(); h.responses.push(decision('END')); await h.user(); await h.clock.advance(200 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().history[0].action, 'END'); assert.equal(h.clock.timers.size, 0);
});
test('非法 JSON 有限重试，失败后暂停，无异常消息', async () => {
    const h = harness(); h.responses.push('{broken', '{}', '[]'); await h.user(); await h.clock.advance(15 * MINUTE);
    assert.equal(h.calls.length, 3); assert.equal(h.agent.episode().status, 'PAUSED'); assert.equal(h.rendered.length, 0);
    await h.clock.advance(200 * MINUTE); assert.equal(h.calls.length, 3);
});
test('API 失败遵守相同重试上限', async () => {
    const h = harness({ maxRetries: 1 }); h.responses.push(new Error('秘密错误'), new Error('秘密错误'));
    await h.user(); await h.clock.advance(10 * MINUTE); assert.equal(h.calls.length, 2);
    assert.equal(h.agent.episode().status, 'PAUSED'); assert.ok(!h.agent.episode().error.includes('秘密'));
});
test('超时后暂停并丢弃迟到结果；请求返回前不重复调用', async () => {
    const h = harness({ timeoutSeconds: 10 }), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE + 10_000);
    assert.equal(h.agent.episode().status, 'PAUSED'); assert.equal(h.agent.inFlight, true);
    await h.agent.resume(); await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 1);
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain(); assert.equal(h.rendered.length, 0);
});
test('生成期间越过最大截止时间，迟到结果不能发送', async () => {
    const h = harness({ maxWaitMinutes: 6, timeoutSeconds: 300 }), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(6 * MINUTE); assert.equal(h.agent.episode().status, 'ENDED');
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain(); assert.equal(h.rendered.length, 0);
});
test('仅开启决策、未开启发送时，SEND 被阻止', async () => {
    const h = harness({ allowSend: false }); h.responses.push(decision('SEND_MESSAGE')); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().history[0].outcome, 'BLOCKED_BY_POLICY');
});
test('插件关闭时不建立任务、不调用模型', async () => {
    const h = harness({ enabled: false }); await h.user(); await h.clock.advance(500 * MINUTE);
    assert.equal(h.agent.episode(), null); assert.equal(h.calls.length, 0);
});
test('生成中关闭发送和插件会使旧决策失效', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise); await h.user(); await h.clock.advance(5 * MINUTE);
    h.storage.saveSettings({ ...h.agent.settings(), enabled: false, allowSend: false }); await h.agent.settingsChanged();
    pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'PAUSED');
});
test('同一次用户消息的重复事件不会重置任务或制造额外计时器', async () => {
    const h = harness(); await h.user(); const id = h.agent.episode().id;
    await h.events.emit('MESSAGE_SENT', 0); await drain(); assert.equal(h.agent.episode().id, id); assert.equal(h.clock.timers.size, 1);
});
test('WAIT 太短会被修正为最短间隔', async () => {
    const h = harness(); h.responses.push(decision('WAIT', { next_check_minutes: 0.01 })); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 5 * MINUTE);
});
test('允许两次主动消息时，第二次决策能看到第一次发送并遵守上限', async () => {
    const h = harness({ maxMessages: 2, contactGapMinutes: 5 }); h.responses.push(decision('SEND_MESSAGE'), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(10 * MINUTE); assert.equal(h.rendered.length, 2);
    assert.match(h.calls[1].prompt, /"sent_count":1/); assert.match(h.calls[1].prompt, /"outcome":"SENT"/);
    await h.clock.advance(100 * MINUTE); assert.equal(h.calls.length, 2); assert.equal(h.agent.episode().status, 'ENDED');
});
test('联系频率限制会阻止过早的第二条消息', async () => {
    const h = harness({ maxMessages: 2, contactGapMinutes: 30 }); h.responses.push(decision('SEND_MESSAGE'), decision('SEND_MESSAGE'));
    await h.user(); await h.clock.advance(10 * MINUTE); assert.equal(h.rendered.length, 1);
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 25 * MINUTE);
});
test('免打扰时不调用模型，截止优先于免打扰结束', async () => {
    const h = harness({ dndEnabled: true, dndStart: '00:00', dndEnd: '00:00' }); await h.user(); await h.clock.advance(180 * MINUTE);
    assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'ENDED');
});
test('无实际内容变化的更新通知不会取消等待或重置截止', async () => {
    for (const event of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHARACTER_EDITED']) {
        const h = harness(); h.responses.push(decision('END')); await h.user(); const due = h.agent.episode().dueAt;
        await h.events.emit(event); await drain(); assert.equal(h.agent.episode().status, 'WAITING');
        assert.equal(h.agent.episode().dueAt, due); await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 1);
    }
});
test('截图回归：1分钟首检再等5分钟，5.4分钟收到更新通知，6分钟仍继续判断', async () => {
    const h = harness({ firstCheckMinutes: 1 });
    h.responses.push(decision('WAIT', { next_check_minutes: 5 }), decision('END'));
    await h.user(); await h.clock.advance(MINUTE); const due = h.agent.episode().dueAt;
    await h.clock.advance(4.4 * MINUTE); await h.events.emit('MESSAGE_UPDATED'); await drain();
    assert.equal(h.agent.episode().status, 'WAITING'); assert.equal(h.agent.episode().dueAt, due);
    await h.clock.advance(0.6 * MINUTE); assert.equal(h.calls.length, 2); assert.equal(h.agent.episode().history.length, 2);
});
test('等待中修改AI文本保留原定时间，下一次读取修改后的上下文', async () => {
    const h = harness({ firstCheckMinutes: 1 }); h.responses.push(decision('WAIT', { next_check_minutes: 5 }), decision('END'));
    await h.user(); h.ctx.chat.push({ name: '小晴', is_user: false, mes: '原来的回复' });
    await h.events.emit('MESSAGE_RECEIVED', 1, 'normal'); await h.clock.advance(MINUTE);
    const due = h.agent.episode().dueAt; h.ctx.chat[1].mes = '修改后的新回复';
    await h.events.emit('MESSAGE_EDITED'); await drain(); assert.equal(h.agent.episode().status, 'WAITING');
    assert.equal(h.agent.episode().dueAt, due); assert.equal(h.agent.episode().lastContextEvent.type, 'MESSAGE_EDITED');
    await h.clock.advance(5 * MINUTE); assert.match(h.calls[1].prompt, /修改后的新回复/);
});
test('模型生成中的纯界面更新不会丢弃仍有效的决策', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE); await h.events.emit('MESSAGE_UPDATED'); await drain();
    assert.equal(h.agent.episode().status, 'CHECKING'); pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 1);
});
test('生成中真实修改角色卡丢弃旧结果，但保留任务继续评估', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise, decision('END'));
    await h.user(); await h.clock.advance(5 * MINUTE); h.ctx.characters[0].description = '更新的人格';
    await h.events.emit('CHARACTER_EDITED'); await drain(); pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'WAITING');
    await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 2); assert.match(h.calls[1].prompt, /更新的人格/);
});
test('编辑最后一条用户消息会重建任务，而不是永久停止', async () => {
    const h = harness(); await h.user(); const oldId = h.agent.episode().id;
    h.ctx.chat[0].mes = '修改后的用户消息'; await h.events.emit('MESSAGE_EDITED'); await drain();
    assert.notEqual(h.agent.episode().id, oldId); assert.equal(h.agent.episode().status, 'WAITING');
    assert.equal(h.agent.episode().lastContextEvent.type, 'MESSAGE_EDITED');
});
test('删除所有用户消息仍然取消等待，不凭空联系', async () => {
    const h = harness(); await h.user(); h.ctx.chat = []; await h.events.emit('MESSAGE_DELETED'); await drain();
    await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 0); assert.equal(h.agent.episode().status, 'CANCELED');
});
test('旧版误取消的同一沉默任务可以恢复，过期唤醒只重新判断一次', async () => {
    const h = harness({ firstCheckMinutes: 1 }); h.responses.push(decision('WAIT', { next_check_minutes: 5 }), decision('END'));
    await h.user(); await h.clock.advance(MINUTE); h.agent.scheduler.cancel();
    const saved = h.ctx.chatMetadata[KEY].episode; saved.status = 'CANCELED';
    saved.reason = '聊天或角色资料被编辑、删除或切换候选回复'; h.clock.time += 6 * MINUTE;
    await h.agent.load(); assert.equal(h.agent.episode().status, 'WAITING');
    await h.clock.advance(0); assert.equal(h.calls.length, 2); assert.equal(h.agent.episode().history.length, 2);
});
test('旧版恢复不会复活手动取消任务或用户消息已变化的任务', async () => {
    const h = harness(); await h.user(); await h.agent.cancel(); await h.agent.load();
    assert.equal(h.agent.episode().status, 'CANCELED');
    const saved = h.ctx.chatMetadata[KEY].episode; saved.reason = '聊天或角色资料被编辑、删除或切换候选回复';
    h.ctx.chat[0].mes = '已经不一样的用户消息'; await h.agent.load();
    assert.equal(h.agent.episode().status, 'CANCELED'); assert.equal(h.calls.length, 0);
});
test('无事件通知的角色卡变化也会丢弃旧决策', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise); await h.user(); await h.clock.advance(5 * MINUTE);
    h.ctx.characters[0].description = '被修改的人格'; pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'WAITING');
});
test('正常回复生成期间不发起决策，生成结束后再评估', async () => {
    const h = harness(); h.responses.push(decision('END')); await h.user(); await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    await h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.clock.advance(5 * MINUTE); assert.equal(h.calls.length, 0); await h.events.emit('GENERATION_ENDED');
    await h.clock.advance(30_000); assert.equal(h.calls.length, 1);
});
test('/send 只触发命令前通知而没有生成结束时，等待任务不会卡住', async () => {
    const h = harness({ firstCheckMinutes: 1 }); h.responses.push(decision('END'));
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false); await h.user();
    assert.equal(h.agent.busy, false); await h.clock.advance(MINUTE); assert.equal(h.calls.length, 1);
});
test('酒馆停止事件暂停本插件请求并丢弃结果', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise); await h.user(); await h.clock.advance(5 * MINUTE);
    await h.events.emit('GENERATION_STOPPED'); await drain(); pending.resolve(JSON.stringify(decision('SEND_MESSAGE'))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'PAUSED');
});
test('刷新恢复 WAITING 的绝对截止时间；CHECKING 恢复为暂停', async () => {
    const h = harness(); await h.user(); const deadline = h.agent.episode().deadlineAt;
    await h.agent.load(); assert.equal(h.agent.episode().deadlineAt, deadline);
    h.ctx.chatMetadata[KEY].episode.status = 'CHECKING'; await h.agent.load(); assert.equal(h.agent.episode().status, 'PAUSED');
    h.ctx.chatMetadata[KEY].episode.status = 'WAITING'; h.clock.time = deadline; await h.agent.load();
    assert.equal(h.agent.episode().status, 'ENDED'); assert.equal(h.calls.length, 0);
});
test('手动取消以及删除记忆不会因刷新复活同一次沉默', async () => {
    const h = harness(); h.responses.push(decision('WAIT')); await h.user(); await h.clock.advance(5 * MINUTE);
    await h.agent.clearMemory(); assert.equal(h.agent.episode().history.length, 0); assert.equal(h.agent.state.archives.length, 0);
    await h.agent.load(); await h.clock.advance(180 * MINUTE); assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().status, 'CANCELED');
});
test('关闭心理历程保存时只保留运行记录', async () => {
    const h = harness({ saveMemory: false }); h.responses.push(decision('WAIT')); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.ctx.chatMetadata[KEY].episode.history[0].thought, null);
    assert.equal(h.ctx.chatMetadata[KEY].episode.history[0].action, 'WAIT');
});
test('不同聊天的元数据归属不匹配时不读取他人的心理历程', async () => {
    const h = harness(); await h.user(); h.ctx.chatId = 'different'; await h.agent.load();
    assert.equal(h.agent.episode(), null); assert.equal(h.agent.state.archives.length, 0);
});
test('两标签页共享生成锁和收据，同一次沉默最多发送一次', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({}, shared), b = harness({}, shared);
    a.responses.push(decision('SEND_MESSAGE')); b.responses.push(decision('SEND_MESSAGE'));
    await a.user(); await b.user(); await a.clock.advance(5 * MINUTE); await b.clock.advance(5 * MINUTE);
    assert.equal(a.calls.length + b.calls.length, 1); assert.equal(a.rendered.length + b.rendered.length, 1);
});
test('存储不可用时拒绝调用模型或发送', async () => {
    const h = harness(); h.coordinator.storage = null; await h.user(); await h.clock.advance(15 * MINUTE);
    assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'PAUSED');
});
test('主动消息原文不会作为 slash command 执行，事件与渲染正确触发', async () => {
    const h = harness(); let received = 0, rendered = 0;
    h.events.on('MESSAGE_RECEIVED', () => received++); h.events.on('CHARACTER_MESSAGE_RENDERED', () => rendered++);
    h.responses.push(decision('SEND_MESSAGE', { message: '/run {{danger}} <script>text</script>' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.ctx.chat.at(-1).mes, '/run {{danger}} <script>text</script>'); assert.equal(received, 1); assert.equal(rendered, 1);
});
test('浅角色卡加载超时也会暂停，迟到加载不会再调用模型', async () => {
    const h = harness({ timeoutSeconds: 10 }), pending = deferred();
    h.ctx.unshallowCharacter = () => pending.promise;
    await h.user(); await h.clock.advance(5 * MINUTE + 10_000);
    assert.equal(h.agent.episode().status, 'PAUSED'); assert.equal(h.calls.length, 0);
    pending.resolve(); await drain(); assert.equal(h.calls.length, 0);
});
test('保存或渲染出现异常时，去重收据防止再次发送', async () => {
    const h = harness(); h.ctx.addOneMessage = () => { throw new Error('渲染失败'); };
    h.responses.push(decision('SEND_MESSAGE')); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.ctx.chat.length, 2); assert.equal(h.agent.episode().sentCount, 1);
    await h.agent.load(); await h.clock.advance(60 * MINUTE); assert.equal(h.calls.length, 1);
});
test('同一角色的不同聊天也遵守联系频率限制', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({}, shared), b = harness({}, shared); b.ctx.chatId = 'another-chat';
    a.responses.push(decision('SEND_MESSAGE')); b.responses.push(decision('SEND_MESSAGE'));
    await a.user(); await b.user(); await a.clock.advance(5 * MINUTE); await b.clock.advance(5 * MINUTE);
    assert.equal(a.rendered.length, 1); assert.equal(b.rendered.length, 0);
    assert.equal(b.agent.episode().history[0].outcome, 'BLOCKED_BY_POLICY');
});
test('用户消息保存较慢时，按消息时间而非事件延迟起算', async () => {
    const h = harness();
    h.ctx.chat.push({ name: '用户', is_user: true, mes: '消息两分钟前已发送', send_date: new Date(h.clock.now() - 2 * MINUTE).toISOString() });
    h.responses.push(decision('END')); await h.events.emit('MESSAGE_SENT', 0); await drain();
    await h.clock.advance(3 * MINUTE); assert.equal(h.calls.length, 1);
});
