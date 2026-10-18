import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, deferred, drain, Locks, MemoryStorage } from './helpers.js';
import { KEY, MINUTE } from '../modules/settings.js';
import { parseDecision } from '../modules/decision-engine.js';
import { decisionSchema } from '../modules/output-schema.js';
import { SCENE_PROMPT } from '../prompts/scene-prompt.js';

const action = (name = 'WAIT', options = {}) => decision(name, { narration: null, next_check_minutes: name === 'WAIT' ? 5 : null, ...options });
async function setup(settings = {}, shared) {
    const h = harness({ maxMessages: 3, ...settings }, shared);
    h.ctx.characters[0].scenario = '团团经营面包店，顾客在柜台前挑选面包，她还有价签没贴完。';
    await h.agent.load(); await h.agent.setInteractionMode('scene');
    return h;
}
const data = call => JSON.parse(call.prompt.split('\n')[1]);

test('默认纯聊天不启用场景；模式按聊天保存，旧元数据自动补齐', async () => {
    const h = harness(); await h.agent.load(); assert.equal(h.agent.state.scene.mode, 'chat');
    await h.agent.setInteractionMode('scene'); const saved = structuredClone(h.ctx.chatMetadata);
    await h.agent.load(); assert.equal(h.agent.state.scene.mode, 'scene');
    h.ctx.chatId = 'chat-B'; h.ctx.chatMetadata = {}; await h.agent.load();
    assert.equal(h.agent.state.scene.mode, 'chat');
    assert.equal(await h.agent.setInteractionMode('scene', saved[KEY].owner), false);
    h.ctx.chatId = 'chat-A'; h.ctx.chatMetadata = saved; await h.agent.load();
    assert.equal(h.agent.state.scene.mode, 'scene');
    delete h.ctx.chatMetadata[KEY].scene; await h.agent.load(); assert.equal(h.agent.state.scene.mode, 'chat');
});

test('WAIT 可展示实际动作而不发对白，并按模型时间继续等待', async () => {
    const h = await setup();
    h.responses.push(action('WAIT', { narration: '团团转身走到货架前，继续贴剩下的价签。', next_check_minutes: 8 }));
    await h.user('我再看看'); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
    assert.match(h.ctx.chat.at(-1).mes, /团团转身走到货架前/);
    assert.equal(h.ctx.chat.at(-1).extra.xiaoqing_agent.scene.has_dialogue, false);
    assert.equal(h.agent.episode().sentCount, 0); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.agent.episode().status, 'WAITING');
    assert.equal(h.agent.episode().dueAt - h.clock.now(), 8 * MINUTE);
    assert.equal(h.ctx.chatMetadata[KEY].episode.history.at(-1).scene_outcome, 'DISPLAYED');
    assert.equal(h.agent.state.lastSentAt, 0);
});

test('下一次判断带入实际动作、完整场景、人设和玩家视角边界', async () => {
    const h = await setup();
    h.responses.push(action('WAIT', { narration: '团团来到货架旁开始贴标签。' }), action('WAIT', { narration: '团团贴好最后一张标签，将空纸收起。' }));
    await h.user('我看看'); await h.clock.advance(10 * MINUTE);
    const context = data(h.calls[1]);
    assert.match(context.character_card.scenario, /面包店/);
    assert.equal(context.scene.committed_updates.length, 1);
    assert.match(context.scene.committed_updates[0].text, /开始贴标签/);
    assert.match(context.scene.narration_audience, /不自动等于戏内角色知情/);
    assert.equal(context.environment.silence_minutes, 10);
    assert.match(h.calls[1].systemPrompt, /不得替玩家决定动作/);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().narrationCount, 2);
});

test('场景没有新的可见行动时安静 WAIT，不向聊天抄写心理计划也不占额度', async () => {
    const h = await setup();
    h.responses.push(action('WAIT', { thought: '打算稍后去贴标签。', pending_intention: '等五分钟后再去。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().narrationCount, 0);
    assert.equal(h.agent.episode().status, 'WAITING');
    assert.equal(h.agent.episode().error, null); assert.equal(h.agent.episode().outputCount, 0);
    assert.equal(h.agent.episode().history.length, 1);
});

test('动作和对白同时显示为一条原生消息，不额外请求模型', async () => {
    const h = await setup();
    h.responses.push(action('SEND_MESSAGE', { narration: '团团拿起手边的价签。', message: '你慢慢选，我先贴标签。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1);
    assert.equal(h.ctx.chat.at(-1).mes, '*团团拿起手边的价签。*\n\n你慢慢选，我先贴标签。');
    assert.equal(h.ctx.chat.at(-1).is_system, false);
    assert.equal(h.agent.episode().sentCount, 1); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.agent.episode().status, 'WAITING');
});

test('对白与动作共享三条总上限，达到后停止请求且不再追加动作', async () => {
    const h = await setup();
    h.responses.push(action('SEND_MESSAGE', { narration: '团团开始贴标签。' }),
        ...['一', '二', '三', '四'].map(n => action('WAIT', { narration: `她贴好第${n}层货架的标签。` })), action('END'));
    await h.user(); await h.clock.advance(30 * MINUTE);
    assert.equal(h.rendered.length, 3); assert.equal(h.agent.episode().sentCount, 1);
    assert.equal(h.agent.episode().narrationCount, 3); assert.equal(h.agent.episode().outputCount, 3);
    assert.equal(h.agent.episode().status, 'ENDED');
    await h.clock.advance(60 * MINUTE); assert.equal(h.calls.length, 3);
});

test('关闭主动对白仍可展示已选择启用的场景动作，不能顺带发出台词', async () => {
    const h = await setup({ allowSend: false });
    h.responses.push(action('SEND_MESSAGE', { narration: '团团低头整理标签。', message: '这句不应被发送' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 1); assert.doesNotMatch(h.rendered[0].mes, /这句不应被发送/);
    assert.equal(h.agent.episode().sentCount, 0); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.agent.episode().history[0].speech_outcome, 'BLOCKED_BY_POLICY');
});

test('对白联系冷却不挡住手头动作，受阻对白不会写入后续场景事实', async () => {
    const h = await setup({ maxMessages: 3, contactGapMinutes: 30 });
    h.responses.push(action('SEND_MESSAGE', { message: '你先选。' }),
        action('SEND_MESSAGE', { narration: '团团给第二层货架贴上价签。', message: '受冷却限制的台词' }), action('END'));
    await h.user(); await h.clock.advance(15 * MINUTE);
    assert.equal(h.agent.episode().sentCount, 1); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.rendered.length, 2); assert.doesNotMatch(h.calls[2].prompt, /受冷却限制的台词/);
    assert.match(h.calls[2].prompt, /第二层货架/);
});

test('新用户消息按原首检节奏判断，不给实际动作另加对白冷却', async () => {
    const h = await setup({ firstCheckMinutes: 1 });
    h.responses.push(action('WAIT', { narration: '团团整理好标签。' }), action('WAIT', { narration: '团团将整理好的标签贴到货架上。' }));
    await h.user(); await h.clock.advance(MINUTE); await h.user('嗯'); await h.clock.advance(MINUTE);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(data(h.calls[1]).permissions.allow_narration, true);
    assert.match(data(h.calls[1]).scene.committed_updates[0].text, /整理好标签/);
});

test('两次旁白加一条动作对白刚好三条，合并输出不会重复计数', async () => {
    const h = await setup();
    h.responses.push(...['一', '二'].map(n => action('WAIT', { narration: `她完成第${n}件手头事务。` })),
        action('SEND_MESSAGE', { narration: '她抬头望向柜台。', message: '你挑好了吗？' }), action('END'));
    await h.user(); await h.clock.advance(25 * MINUTE);
    assert.equal(h.rendered.length, 3); assert.equal(h.agent.episode().narrationCount, 3);
    assert.equal(h.agent.episode().outputCount, 3);
    assert.equal(h.agent.episode().sentCount, 1); assert.equal(h.agent.episode().status, 'ENDED');
    assert.equal(h.rendered[2].mes, '*她抬头望向柜台。*\n\n你挑好了吗？');
});

test('刷新恢复场景计数与绝对时间，不重复已显示动作', async () => {
    const h = await setup(); h.responses.push(action('WAIT', { narration: '团团转身回到货架边。' }), action('END'));
    await h.user(); await h.clock.advance(5 * MINUTE); const due = h.agent.episode().dueAt;
    await h.agent.load(); assert.equal(h.agent.state.scene.mode, 'scene');
    assert.equal(h.agent.episode().narrationCount, 1); assert.equal(h.agent.episode().dueAt, due);
    await h.clock.advance(5 * MINUTE); assert.equal(h.rendered.length, 1); assert.equal(h.calls.length, 2);
});

for (const change of ['新用户消息', '切换模式', '手动取消', '编辑聊天', '关闭插件']) {
    test(`场景生成中${change}，迟到动作和对白全部丢弃`, async () => {
        const h = await setup(), pending = deferred(); h.responses.push(() => pending.promise);
        await h.user(); await h.clock.advance(5 * MINUTE);
        if (change === '新用户消息') await h.user('我接着说');
        if (change === '切换模式') await h.agent.setInteractionMode('chat');
        if (change === '手动取消') await h.agent.cancel();
        if (change === '编辑聊天') { h.ctx.chat[0].mes += '（修改）'; await h.events.emit('MESSAGE_EDITED', 0); }
        if (change === '关闭插件') { h.storage.saveSettings({ ...h.agent.settings(), enabled: false }); await h.agent.settingsChanged(); }
        pending.resolve(JSON.stringify(action('SEND_MESSAGE', { narration: '过期动作', message: '过期对白' }))); await drain();
        assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().narrationCount, 0);
    });
}

test('场景模式同样遵守免打扰、草稿和绝对等待截止', async () => {
    const h = await setup({ dndEnabled: true, dndStart: '00:00', dndEnd: '00:00', maxWaitMinutes: 6 });
    await h.user(); await h.clock.advance(6 * MINUTE);
    assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().status, 'ENDED');
    const draft = await setup({ maxWaitMinutes: 6 }); draft.adapter.hasDraft = () => true;
    await draft.user(); await draft.clock.advance(6 * MINUTE);
    assert.equal(draft.calls.length, 0); assert.equal(draft.agent.episode().status, 'ENDED');
});

test('模型返回时才进入免打扰，动作与对白都不会显示', async () => {
    const h = await setup(), pending = deferred(); h.responses.push(() => pending.promise);
    await h.user(); await h.clock.advance(5 * MINUTE);
    h.storage.saveSettings({ ...h.agent.settings(), dndEnabled: true, dndStart: '00:00', dndEnd: '00:00' });
    pending.resolve(JSON.stringify(action('SEND_MESSAGE', { narration: '不能显示的动作' }))); await drain();
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().narrationCount, 0);
});

test('两页同一次沉默只显示一次动作，并共享旁白次数', async () => {
    const shared = { locks: new Locks(), local: new MemoryStorage() };
    const a = await setup({}, shared), b = await setup({}, shared), pending = deferred();
    a.responses.push(() => pending.promise); b.responses.push(action('WAIT', { narration: '另一页不应重复' }));
    await a.user('同一条消息'); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
    await a.clock.advance(5 * MINUTE); await b.clock.advance(5 * MINUTE);
    pending.resolve(JSON.stringify(action('WAIT', { narration: '团团在原位整理价签。' }))); await drain();
    await b.clock.advance(30_000);
    assert.equal(a.rendered.length + b.rendered.length, 1); assert.equal(b.calls.length, 0);
    assert.equal(b.agent.episode().narrationCount, 1);
});

test('渲染失败保守占用旁白额度，刷新后不重发不确定输出', async () => {
    const h = await setup(); h.ctx.addOneMessage = () => { throw new Error('模拟渲染失败'); };
    h.responses.push(action('WAIT', { narration: '已占用去重标记的动作。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.ctx.chat.length, 2); assert.equal(h.agent.episode().narrationCount, 1);
    assert.equal(h.coordinator.read(h.adapter.snapshot()).narrationCount, 1);
    assert.equal(h.agent.episode().history.at(-1).scene_outcome, 'COMMIT_RESERVED');
    await h.agent.load(); assert.equal(h.agent.episode().narrationCount, 1);
});

for (const edit of [true, false]) test(`${edit ? '编辑' : '删除'}旁白后按当前聊天判断，不从心理记录复活旧场景`, async () => {
    const h = await setup();
    h.responses.push(action('WAIT', { narration: 'OLD_SCENE_TEXT' }), action('END'));
    await h.user(); await h.clock.advance(5 * MINUTE);
    if (edit) h.ctx.chat[1].mes = '*她留在柜台旁整理袋子。*'; else h.ctx.chat.splice(1, 1);
    await h.events.emit(edit ? 'MESSAGE_EDITED' : 'MESSAGE_DELETED', 1); await h.clock.advance(5 * MINUTE);
    assert.doesNotMatch(h.calls[1].prompt, /OLD_SCENE_TEXT/);
    assert.equal(data(h.calls[1]).scene.committed_updates.length, edit ? 1 : 0);
    if (edit) assert.match(h.calls[1].prompt, /整理袋子/);
});

test('清心理记录与关闭保存不删除公开动作，也不复活等待', async () => {
    const h = await setup({ saveMemory: false });
    h.responses.push(action('WAIT', { narration: '她给货架贴好一张价签。', thought: 'PRIVATE_THOUGHT' }));
    await h.user(); await h.clock.advance(5 * MINUTE); await h.agent.clearMemory();
    assert.match(h.ctx.chat.at(-1).mes, /一张价签/);
    assert.equal(h.agent.episode().status, 'CANCELED'); assert.equal(h.agent.episode().narrationCount, 1);
    assert.doesNotMatch(JSON.stringify(h.ctx.chatMetadata), /PRIVATE_THOUGHT/);
});

test('场景短期接话承接已有动作和视角规则，但沿用五字段正常回复协议', async () => {
    const h = await setup(); h.responses.push(action('WAIT', { narration: '团团已经来到货架旁。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    h.responses.push({ action: 'REPLY', message: '她回过头：“选好了？”', next_check_seconds: null, thought: '听到他开口。', pending_intention: null });
    await h.normalUser('我选好了'); await h.clock.advance(5000);
    assert.match(h.calls[1].systemPrompt, /玩家扮演的角色自动知道/);
    assert.match(h.calls[1].prompt, /团团已经来到货架旁/);
    assert.equal(h.rendered.length, 2); assert.equal(h.agent.episode().sentCount, 0);
});

test('六字段场景协议严格校验；缺字段或异常旁白不会被发送', async () => {
    for (const narration of [7, {}, 'x'.repeat(2001)]) {
        assert.throws(() => parseDecision(JSON.stringify(action('WAIT', { narration })), { scene: true }), { code: 'INVALID_NARRATION' });
    }
    assert.throws(() => parseDecision(JSON.stringify(decision('WAIT')), { scene: true }), { code: 'INVALID_FIELDS' });
    assert.throws(() => parseDecision(JSON.stringify(action('WAIT'))), { code: 'INVALID_FIELDS' });
    const h = await setup(); h.responses.push(decision('WAIT')); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 0); assert.match(h.agent.episode().error, /INVALID_FIELDS/);
});

test('选择 END 时仍展示最后的实际离场动作，再结束任务', async () => {
    const h = await setup(); h.responses.push(action('END', { narration: '团团把价签放好，走进后面的烘焙间。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 1); assert.match(h.rendered[0].mes, /烘焙间/);
    assert.equal(h.agent.episode().status, 'ENDED'); assert.equal(h.coordinator.read(h.adapter.snapshot()).closed, true);
    await h.clock.advance(100 * MINUTE); assert.equal(h.calls.length, 1);
});

test('场景提示里的所有 JSON 示例通过生产解析；Schema 精确包含六字段', () => {
    const examples = SCENE_PROMPT.split('\n').filter(line => line.startsWith('{'));
    assert.equal(examples.length, 4);
    for (const line of examples) assert.ok(parseDecision(line, { scene: true }));
    assert.equal(decisionSchema(false, true).value.required.length, 6);
    assert.ok(decisionSchema(false, true).value.required.includes('narration'));
    assert.equal(decisionSchema(false, true).value.properties.narration.type, 'string');
    assert.deepEqual(Object.keys(decisionSchema(false, true).value.properties).slice(0, 3), ['action', 'narration', 'message']);
    assert.equal(decisionSchema().value.required.length, 5);
});

test('长独白加空旁白不变成动作；安静等待后只展示新返回的外部动作', async () => {
    const h = await setup();
    const monologue = 'PRIVATE_MONOLOGUE：我心里盘算着明天的面团，标签贴歪了，撕下来重贴。'.repeat(8);
    h.responses.push(action('WAIT', { thought: monologue, narration: null }),
        action('WAIT', { narration: '团团把贴歪的价签揭下来，重新对齐贴好。', thought: '继续处理手头事务。' }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.agent.episode().error, null);
    assert.equal(h.rendered.length, 0); assert.equal(h.agent.episode().history.length, 1);
    assert.doesNotMatch(JSON.stringify(h.ctx.chatMetadata), /PRIVATE_MONOLOGUE/);
    await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls.length, 2); assert.equal(h.rendered.length, 1);
    assert.match(h.rendered[0].mes, /重新对齐贴好/); assert.doesNotMatch(h.rendered[0].mes, /PRIVATE_MONOLOGUE/);
    assert.equal(h.agent.episode().history[1].scene_outcome, 'DISPLAYED'); assert.equal(h.agent.episode().error, null);
});

test('场景 WAIT 接受空旁白以保持沉默，规范化为空动作', () => {
    for (const narration of [null, '', '   ']) {
        assert.equal(parseDecision(JSON.stringify(action('WAIT', { narration })), { scene: true }).narration, null);
    }
});

test('有效旁白存在时省略过长辅助独白，不因摘要阻断动作或把独白当旁白发送', async () => {
    const h = await setup(); h.responses.push(action('WAIT', { narration: '团团正在贴标签。', thought: 'PRIVATE_LONG_THOUGHT'.repeat(100) }));
    await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.rendered.length, 1); assert.match(h.rendered[0].mes, /团团正在贴标签/);
    assert.equal(h.agent.episode().error, null); assert.match(h.agent.episode().history[0].thought, /摘要过长，已省略/);
    assert.doesNotMatch(JSON.stringify(h.ctx.chatMetadata), /PRIVATE_LONG_THOUGHT/);
    assert.doesNotMatch(h.rendered[0].mes, /PRIVATE_LONG_THOUGHT/);
});

test('场景 END 可用空字符串保持安静，SEND 可以只提供对白；都不伪造场景动作', async () => {
    for (const mode of ['END', 'SEND_MESSAGE']) {
        const h = await setup(); h.responses.push(action(mode, { narration: '' }));
        await h.user(); await h.clock.advance(5 * MINUTE);
        assert.equal(h.agent.episode().narrationCount, 0);
        assert.equal(h.agent.episode().history[0].scene_outcome, 'NO_CHANGE');
        assert.equal(h.rendered.length, mode === 'SEND_MESSAGE' ? 1 : 0);
    }
});

test('目标 OpenRouter 连接场景调用附带六字段 Schema，未知连接保留严格本地解析', async () => {
    const h = await setup(); h.ctx.chatCompletionSettings = { chat_completion_source: 'openrouter' };
    h.ctx.getChatCompletionModel = () => 'deepseek/deepseek-v4.1-flash';
    h.responses.push(action('WAIT', { narration: '她整理好货架。' })); await h.user(); await h.clock.advance(5 * MINUTE);
    assert.equal(h.calls[0].jsonSchema.name, 'xiaoqing_scene_decision');
    assert.equal(h.calls[0].jsonSchema.value.required.length, 6); assert.equal(h.rendered.length, 1);
});
