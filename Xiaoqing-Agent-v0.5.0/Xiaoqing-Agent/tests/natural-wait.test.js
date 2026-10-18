import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decision, Locks, MemoryStorage } from './helpers.js';
import { normalizeSettings, MINUTE } from '../modules/settings.js';
const data = call => JSON.parse(call.prompt.split('\n')[1]);
const natural = extra => harness({ adaptiveWaitEnabled: true, fastTestEnabled: true, maxMessages: 10, ...extra });

test('自然等待默认开启，所有上限可调且越界值被规范化', () => {
  const defaults = normalizeSettings();
  assert.equal(defaults.adaptiveWaitEnabled, true); assert.equal(defaults.maxDecisionCalls, 30);
  assert.equal(defaults.fastWaitMaxSeconds, 60); assert.equal(defaults.quietWaitFactor, 2);
  const settings = normalizeSettings({ fastWaitMaxSeconds: 0, quietWaitMaxMinutes: 9999, quietWaitFactor: 9, maxDecisionCalls: 0 });
  assert.deepEqual([settings.fastWaitMaxSeconds, settings.quietWaitMaxMinutes, settings.quietWaitFactor, settings.maxDecisionCalls], [1, 1440, 4, 1]);
});

test('连续空 WAIT 的快间隔10→20→40，达到自定上限；消息发出后退避重置', async () => {
  const h = natural({ fastWaitMaxSeconds: 40 });
  h.responses.push(...Array.from({ length: 3 }, () => decision('WAIT', { next_check_minutes: 1 })), decision('SEND_MESSAGE'));
  await h.user();
  for (const [advance, expected] of [[10000, 10000], [10000, 20000], [20000, 40000]]) {
    await h.clock.advance(advance); assert.equal(h.agent.episode().dueAt - h.clock.now(), expected);
  }
  await h.clock.advance(40000); assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().silentWaitCount, 0);
  assert.equal(h.agent.episode().dueAt - h.clock.now(), 10000);
});

test('快速 WAIT 尊重模型较长建议但受可调上限约束，关闭后兼容旧固定节奏', async () => {
  for (const [enabled, expected] of [[true, 60000], [false, 10000]]) {
    const h = natural({ adaptiveWaitEnabled: enabled }); h.responses.push(decision('WAIT', { next_check_minutes: 120 }));
    await h.user(); await h.clock.advance(10000); assert.equal(h.agent.episode().dueAt - h.clock.now(), expected);
  }
});

test('三分钟固定复现：自然等待减少空判断，仍允许模型一直保持沉默', async () => {
  const counts = [];
  for (const enabled of [false, true]) {
    const h = natural({ adaptiveWaitEnabled: enabled }); h.responses.push(...Array.from({ length: 30 }, () => decision('WAIT', { next_check_minutes: 1 })));
    await h.user(); await h.clock.advance(3 * MINUTE); counts.push(h.calls.length); assert.equal(h.rendered.length, 0);
  }
  assert.deepEqual(counts, [18, 5]);
});

test('分钟模式同样渐进等待，最长间隔不能低于最短间隔', async () => {
  const h = natural({ fastTestEnabled: false, firstCheckMinutes: 1, minCheckMinutes: 1, quietWaitMaxMinutes: 3 });
  h.responses.push(...Array.from({ length: 3 }, () => decision('WAIT', { next_check_minutes: 1 })));
  await h.user();
  for (const [advance, delay] of [[1, 1], [1, 2], [2, 3]]) { await h.clock.advance(advance * MINUTE); assert.equal(h.agent.episode().dueAt - h.clock.now(), delay * MINUTE); }
});

test('场景安静等待后真正展示动作，会重新开始等待节奏', async () => {
  const h = natural(); await h.agent.load(); await h.agent.setInteractionMode('scene');
  h.responses.push(...['', '', '她把剩下的托盘叠好。'].map(narration => decision('WAIT', { narration, next_check_minutes: 1 })));
  await h.user(); await h.clock.advance(40000);
  assert.equal(h.calls.length, 3); assert.equal(h.rendered.length, 1); assert.equal(h.agent.episode().silentWaitCount, 0);
  assert.equal(h.agent.episode().dueAt - h.clock.now(), 10000);
});

test('新用户消息重置退避与请求额度', async () => {
  const h = natural(); h.responses.push(...Array.from({ length: 2 }, () => decision('WAIT', { next_check_minutes: 1 })));
  await h.user(); await h.clock.advance(20000); assert.equal(h.agent.episode().silentWaitCount, 2);
  await h.user('我说完了。'); assert.equal(h.agent.episode().silentWaitCount, 0); assert.equal(h.agent.episode().requestCount, 0);
  assert.equal(h.agent.episode().dueAt - h.clock.now(), 10000);
});

test('有未发草稿时不调用自主模型，也不消耗请求额度，清空后恢复', async () => {
  const h = natural(); h.adapter.hasDraft = () => true; await h.user(); await h.clock.advance(20000);
  assert.equal(h.calls.length, 0); assert.equal(h.agent.episode().requestCount, 0);
  h.adapter.hasDraft = () => false; h.responses.push(decision('END')); await h.clock.advance(1000);
  assert.equal(h.calls.length, 1);
});

test('自主判断硬上限包含失败请求；无可见输出时也停止整轮', async () => {
  const h = natural({ maxDecisionCalls: 1, maxRetries: 2 }); h.responses.push(new Error('模拟请求失败'));
  await h.user(); await h.clock.advance(20000);
  assert.equal(h.calls.length, 1); assert.equal(h.agent.episode().requestCount, 1);
  assert.equal(h.agent.episode().status, 'ENDED'); assert.match(h.agent.episode().reason, /请求上限/);
  await h.agent.load(); await h.clock.advance(60 * MINUTE); assert.equal(h.calls.length, 1);
});

test('快慢阶段共用自主请求额度，快END不为慢阶段补发额度', async () => {
  const h = natural({ dualPhaseEnabled: true, maxDecisionCalls: 2, minCheckMinutes: 1, contactGapMinutes: 1 });
  h.responses.push(decision('END'), decision('SEND_MESSAGE'));
  await h.user(); await h.clock.advance(6 * MINUTE);
  assert.equal(h.calls.length, 2); assert.equal(h.agent.episode().requestCount, 2); assert.equal(h.agent.episode().status, 'ENDED');
  assert.match(h.agent.episode().reason, /请求上限/);
});

test('同源标签页和刷新不能重新领取已用完的自主请求额度', async () => {
  const shared = { locks: new Locks(), local: new MemoryStorage() };
  const a = harness({ fastTestEnabled: true, maxDecisionCalls: 1 }, shared);
  const b = harness({ fastTestEnabled: true, maxDecisionCalls: 1 }, shared);
  await a.user(); b.ctx.chat = structuredClone(a.ctx.chat); await b.agent.userMessage();
  a.responses.push(decision('WAIT')); await a.clock.advance(10000);
  await b.clock.advance(10000); assert.equal(b.calls.length, 0); assert.equal(b.agent.episode().status, 'ENDED');
  await b.agent.load(); await b.clock.advance(MINUTE); assert.equal(b.calls.length, 0);
});

test('暂停后模型主时间、上条用户时间、有效沉默一致，旧现实时间不混入聊天和决策历史', async () => {
  const h = natural(); const origin = h.clock.now(); h.responses.push(decision('WAIT', { next_check_minutes: 1 }), decision('END'));
  await h.user(); await h.clock.advance(10000); await h.agent.setHold(true); await h.clock.advance(20 * MINUTE); await h.agent.setHold(false);
  await h.clock.advance(10000); const prompt = data(h.calls[1]);
  assert.equal(Date.parse(prompt.environment.now), origin + 20000);
  assert.equal((Date.parse(prompt.environment.now) - Date.parse(prompt.environment.last_user_time)) / MINUTE, prompt.environment.silence_minutes);
  assert.equal(prompt.recent_chat[0].time, undefined); assert.equal(prompt.previous_decisions.history[0].time, undefined);
  assert.equal(h.ctx.chat[0].send_date, new Date(origin).toISOString());
  await h.user('继续'); h.responses.push(decision('END')); await h.clock.advance(10000);
  assert.equal(Date.parse(data(h.calls[2]).environment.now), origin + 30000);
});

test('秒级接话和场景事实都不泄入暂停前后的现实时间戳', async () => {
  const h = natural(); const origin = h.clock.now(); await h.agent.load(); await h.agent.setInteractionMode('scene');
  await h.normalUser('我先看看。'); await h.clock.advance(1000); await h.agent.setHold(true);
  await h.clock.advance(20 * MINUTE); await h.agent.setHold(false);
  h.responses.push({ action: 'REPLY', message: '你慢慢选。', next_check_seconds: null, thought: '不催。', pending_intention: null });
  await h.clock.advance(4000); const prompt = data(h.calls[0]);
  assert.equal(Date.parse(prompt.environment.now), origin + 5000);
  assert.equal(prompt.user_burst[0].time, undefined); assert.equal(prompt.recent_chat[0].time, undefined);
});
