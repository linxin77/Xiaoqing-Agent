import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, drain, deferred, Locks, MemoryStorage } from './helpers.js';
import { parseBufferedDecision } from '../modules/buffer-engine.js';

function reply(action = 'REPLY', options = {}) {
    return { action, message: action === 'REPLY' ? '他把你的文件删了？有没有备份能找回来？' : null,
        next_check_seconds: action === 'WAIT' ? 10 : null, thought: '听完再接话。', pending_intention: null, ...options };
}

test('缓冲默认等待5秒，官方 interceptor 中止即时生成，之后只回复一次', async () => {
    const h = harness(); h.responses.push(reply());
    assert.equal(await h.normalUser('今天发生一件事'), true);
    assert.equal(h.calls.length, 0); assert.equal(h.agent.busy, false);
    await h.clock.advance(4999); assert.equal(h.calls.length, 0);
    await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
    assert.equal(h.ctx.chat.at(-1).extra.xiaoqing_agent.kind, 'buffered_reply');
    assert.equal(h.agent.episode().sentCount, 0);
});
test('连续发送重置秒级计时，并将完整连续消息合并提供给模型', async () => {
    const h = harness(); h.responses.push(reply());
    await h.normalUser('我跟你说'); await h.clock.advance(3000);
    await h.normalUser('今天真的气死了'); await h.clock.advance(3000);
    await h.normalUser('他居然把我文件删了'); await h.clock.advance(4999); assert.equal(h.calls.length, 0);
    await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
    assert.match(h.calls[0].prompt, /我跟你说\\n今天真的气死了\\n他居然把我文件删了/);
    assert.equal(h.ctx.chat.filter(message => message.is_user).length, 3);
});
test('模型可继续等待，再回复；过短秒数被修正', async () => {
    const h = harness(); h.responses.push(reply('WAIT', { next_check_seconds: 0.1 }), reply());
    await h.normalUser('那个同学他居然……'); await h.clock.advance(5000);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.buffer.state.dueAt - h.clock.now(), 5000);
    await h.clock.advance(5000); assert.equal(h.rendered.length, 1); assert.match(h.calls[1].prompt, /previous_buffer_decisions/);
});
test('短期 END 不发消息，保留独立的长期等待', async () => {
    const h = harness(); h.responses.push(reply('END')); await h.normalUser('先说到这里'); await h.clock.advance(5000);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.buffer.state.status, 'DONE');
    assert.equal(h.agent.episode().status, 'WAITING');
});
test('接话生成途中继续发消息，丢弃旧回复并为新消息重新缓冲', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise, reply());
    await h.normalUser('我跟你说'); await h.clock.advance(5000); assert.equal(h.agent.buffer.inFlight, true);
    await h.normalUser('他把我的文件删了'); pending.resolve(JSON.stringify(reply())); await drain();
    assert.equal(h.rendered.length, 0); await h.clock.advance(5000); assert.equal(h.rendered.length, 1);
    assert.match(h.calls[1].prompt, /他把我的文件删了/);
});
test('继续输入草稿时重新计时，草稿不会进入模型；清空后再判断', async () => {
    const h = harness(); let draft = false; h.adapter.hasDraft = () => draft;
    h.responses.push(reply()); await h.normalUser('我跟你说'); await h.clock.advance(3000);
    draft = true; h.agent.buffer.inputChanged(); await h.clock.advance(20_000); assert.equal(h.calls.length, 0);
    draft = false; h.agent.buffer.inputChanged(); await h.clock.advance(5000); assert.equal(h.calls.length, 1);
});
test('生成过程中用户开始输入时旧接话作废', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.normalUser('今天发生一件事'); await h.clock.advance(5000);
    h.agent.buffer.inputChanged(); pending.resolve(JSON.stringify(reply())); await drain(); assert.equal(h.rendered.length, 0);
});
test('切换聊天取消缓冲，即使旧模型迟到也不发到新聊天', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.normalUser('我跟你说'); await h.clock.advance(5000);
    h.ctx.chatId = 'B'; h.ctx.chat = []; h.ctx.chatMetadata = {};
    await h.events.emit('CHAT_CHANGED'); await drain(); pending.resolve(JSON.stringify(reply())); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.buffer.state.status, 'CANCELED');
});
test('关闭缓冲、暂停插件、群聊和附件均不拦截酒馆原生成', async () => {
    for (const settings of [{ bufferEnabled: false }, { enabled: false }, { paused: true }]) {
        const h = harness(settings); assert.equal(await h.normalUser('你好'), false);
    }
    const h = harness(); await h.user('图片'); h.ctx.chat.at(-1).extra = { media: ['image'] };
    let aborted = false; h.agent.buffer.intercept([], 8192, () => { aborted = true; }, 'normal'); assert.equal(aborted, false);
    h.ctx.groupId = 'group'; h.agent.buffer.intercept([], 8192, () => { aborted = true; }, 'normal'); assert.equal(aborted, false);
});
test('不接管重生成、继续、quiet；普通空输入手动触发也不被延迟', async () => {
    for (const type of ['regenerate', 'continue', 'quiet', 'swipe', 'impersonate']) {
        const h = harness(); await h.user('你好'); let aborted = false;
        h.agent.buffer.intercept([], 8192, () => { aborted = true; }, type); assert.equal(aborted, false);
    }
    const h = harness(); let aborted = false;
    h.agent.buffer.intercept([], 8192, () => { aborted = true; }, 'normal'); assert.equal(aborted, false);
});
test('模型输出异常只重试一次，暂停后不回退到错误即时回复', async () => {
    const h = harness(); h.responses.push('{broken', '{}'); await h.normalUser('我跟你说');
    await h.clock.advance(10_000); assert.equal(h.calls.length, 2); assert.equal(h.rendered.length, 0);
    assert.equal(h.agent.buffer.state.status, 'PAUSED');
});
test('接话请求超时后迟到结果不发送，并保持互斥', async () => {
    const h = harness({ timeoutSeconds: 10 }), pending = deferred(); h.responses.push(() => pending.promise);
    await h.normalUser('我跟你说'); await h.clock.advance(15_000);
    assert.equal(h.agent.buffer.state.status, 'PAUSED'); assert.equal(h.agent.buffer.inFlight, true);
    pending.resolve(JSON.stringify(reply())); await drain(); assert.equal(h.rendered.length, 0);
});
test('持续 WAIT 最多判断3次，不形成秒级无限轮询', async () => {
    const h = harness(); h.responses.push(reply('WAIT'), reply('WAIT'), reply('WAIT'));
    await h.normalUser('他居然……'); await h.clock.advance(40_000);
    assert.equal(h.calls.length, 3); assert.equal(h.agent.buffer.state.status, 'DONE'); assert.equal(h.rendered.length, 0);
});
test('未发送草稿持续存在时，120秒后结束短期任务且不调用模型', async () => {
    const h = harness(); await h.normalUser('我跟你说'); h.adapter.hasDraft = () => true;
    await h.clock.advance(120_000); assert.equal(h.calls.length, 0); assert.equal(h.agent.buffer.state.status, 'DONE');
});
test('缓冲是用户请求的正常回复，不占主动联系次数，也不要求开启主动发送', async () => {
    const h = harness({ allowSend: false, contactGapMinutes: 1440, dndEnabled: true, dndStart: '00:00', dndEnd: '00:00' });
    h.responses.push(reply()); await h.normalUser('你好'); await h.clock.advance(5000);
    assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().sentCount, 0);
});
test('两个标签页的同一次缓冲只回复一次', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = harness({}, shared), b = harness({}, shared); a.responses.push(reply()); b.responses.push(reply());
    await a.normalUser('我跟你说'); await b.normalUser('我跟你说'); await a.clock.advance(5000); await b.clock.advance(5000);
    assert.equal(a.rendered.length + b.rendered.length, 1); assert.equal(a.calls.length + b.calls.length, 1);
});
test('长计时到期时若短期缓冲仍在处理，不并发发起另一次模型调用', async () => {
    const h = harness({ firstCheckMinutes: 1 }), pending = deferred(); h.responses.push(() => pending.promise);
    await h.normalUser('我跟你说'); await h.clock.advance(60_000); assert.equal(h.calls.length, 1);
    pending.resolve(JSON.stringify(reply())); await drain(); assert.equal(h.rendered.length, 1);
});
test('严格校验秒级输出，不接受分钟字段或错误类型', () => {
    assert.equal(parseBufferedDecision(JSON.stringify(reply())).action, 'REPLY');
    for (const value of [reply('SEND_MESSAGE'), reply('WAIT', { next_check_seconds: '5' }), reply('WAIT', { next_check_seconds: 0 }),
        { ...reply(), next_check_minutes: null }, reply('REPLY', { next_check_seconds: 5 })]) {
        assert.throws(() => parseBufferedDecision(JSON.stringify(value)));
    }
});
test('接话记录按聊天保存，并向之后的长期决策提供；删除历程一并清除', async () => {
    const h = harness(); h.responses.push(reply(), { action: 'END', message: null, next_check_minutes: null, thought: '先等他忙完。', pending_intention: null });
    await h.normalUser('今天发生一件事'); await h.clock.advance(5000);
    assert.equal(h.agent.state.bufferHistory[0].outcome, 'REPLIED');
    await h.clock.advance(295_000); assert.match(h.calls[1].prompt, /previous_buffer_decisions/);
    assert.match(h.calls[1].prompt, /REPLIED/);
    await h.agent.clearMemory(); assert.equal(h.agent.state.bufferHistory.length, 0); assert.equal(h.agent.buffer.state.history.length, 0);
});
test('关闭心理状态保存时，接话记录不持久化状态文本', async () => {
    const h = harness({ saveMemory: false }); h.responses.push(reply()); await h.normalUser('你好'); await h.clock.advance(5000);
    assert.equal(h.agent.state.bufferHistory[0].thought, null);
    assert.equal(h.agent.state.bufferHistory[0].action, 'REPLY');
});
test('纯消息更新通知不打断短期缓冲', async () => {
    const h = harness(); h.responses.push(reply()); await h.normalUser('你好'); await h.clock.advance(3000);
    await h.events.emit('MESSAGE_UPDATED'); await drain(); await h.clock.advance(2000);
    assert.equal(h.rendered.length, 1);
});
test('接话生成中更新角色后丢弃旧结果，重新读取新角色卡而非永久取消', async () => {
    const h = harness(), pending = deferred(); h.responses.push(() => pending.promise, reply());
    await h.normalUser('你好'); await h.clock.advance(5000); h.ctx.characters[0].description = '新角色设定';
    await h.events.emit('CHARACTER_EDITED'); await drain(); pending.resolve(JSON.stringify(reply())); await drain();
    assert.equal(h.rendered.length, 0); await h.clock.advance(5000); assert.equal(h.rendered.length, 1);
    assert.match(h.calls[1].prompt, /新角色设定/);
});
