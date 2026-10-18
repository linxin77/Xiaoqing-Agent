import { MINUTE, quietUntil } from './settings.js';
import { timing, waitDuration } from './timing.js';
import { phaseSentCount, phaseNarrationCount } from './phases.js';

// 场景仍由现有任务、模型锁和计时器驱动。动作一旦执行就展示，不另设“是否展示”的决策。
export const isScene = state => state?.scene?.mode === 'scene';
export function normalizeScene(value) {
    return { mode: value?.mode === 'scene' ? 'scene' : 'chat' };
}
export function sceneContext(agent, snapshot) {
    if (!isScene(agent.state)) return null;
    const ep = agent.episode(), settings = agent.settings();
    const lastContact = agent.contactTime(snapshot);
    const now = agent.clock.now();
    return {
        interaction_mode: 'scene',
        scene: {
            source: '完整角色卡的 scenario 与实际聊天共同提供当前场景；无依据时不要自行假定线下见面。',
            narration_audience: '玩家可见，不自动等于戏内角色知情；双方是否在场以实际剧情为准。',
            // 从当前聊天读事实，绝不从心理记录恢复已删除/编辑的动作。
            committed_updates: snapshot.chat.filter(message => message.proactive?.scene?.has_narration).slice(-20)
                .map(message => ({ index: message.index, text: message.text, audience: 'player' })),
        },
        permissions: {
            allow_send: agent.hasOutputBudget() && settings.allowSend && phaseSentCount(ep) < settings.maxMessages
                && now >= lastContact + timing(settings, ep).contact,
            next_speech_after_seconds: lastContact ? Math.max(0, (lastContact + timing(settings, ep).contact - now) / 1000) : 0,
            allow_narration: agent.hasOutputBudget(), narration_count: phaseNarrationCount(ep),
        },
    };
}

// 一次原生消息提交即可同时承载动作与对白，避免拆成两个生成流程。
export async function executeScene(agent, decision, record, snapshot, token) {
    const ep = agent.episode(), settings = agent.settings(), now = agent.clock.now();
    const info = sceneContext(agent, snapshot);
    const quiet = quietUntil(settings, now);
    const speech = decision.action === 'SEND_MESSAGE' && info.permissions.allow_send && !quiet;
    const narration = decision.narration !== null && info.permissions.allow_narration && !quiet;
    record.scene_outcome = decision.narration === null ? 'NO_CHANGE' : 'PROPOSED';
    if (decision.narration !== null && !narration) record.scene_outcome = 'BLOCKED_BY_POLICY';
    if (decision.action === 'SEND_MESSAGE' && !speech) record.speech_outcome = 'BLOCKED_BY_POLICY';
    const plan = () => {
        if (decision.action === 'WAIT' && !speech && !narration) ep.silentWaitCount = (ep.silentWaitCount ?? 0) + 1;
        else ep.silentWaitCount = 0;
        const delay = decision.action === 'WAIT' ? waitDuration(settings, decision.next_check_minutes, ep) : timing(settings, ep).interval;
        const blocked = record.scene_outcome === 'BLOCKED_BY_POLICY' || record.speech_outcome === 'BLOCKED_BY_POLICY';
        if (agent.enforceOutputLimit()) { /* 所有新增聊天气泡均占额度，包括仅动作的气泡。 */ }
        else if (decision.action === 'END') agent.endCurrentPhase('角色选择结束本轮场景互动');
        else agent.defer(Math.max(now + delay, quiet || 0), blocked
            ? '对白受发送限制或当前处于免打扰；按实际写入的内容继续判断'
            : narration ? '已展示角色动作，继续等待用户或下次判断' : speech ? '已主动联系，稍后重新判断场景' : '角色选择等待，场景没有新变化');
        if (ep.status !== 'ENDED') record.scheduled_minutes = (ep.dueAt - now) / MINUTE;
        agent.writeReceipt(snapshot, { sentCount: ep.sentCount, narrationCount: ep.narrationCount ?? 0,
            nextAt: ep.status === 'ENDED' ? 0 : ep.dueAt, closed: ep.status === 'ENDED' }, now);
    };
    if (!speech && !narration) {
        record.outcome = record.speech_outcome === 'BLOCKED_BY_POLICY' || record.scene_outcome === 'BLOCKED_BY_POLICY'
            ? 'BLOCKED_BY_POLICY' : decision.action === 'END' ? 'ENDED' : 'WAITING';
        plan(); return;
    }
    const text = [narration ? `*${decision.narration}*` : null, speech ? decision.message : null].filter(Boolean).join('\n\n');
    const sent = await agent.adapter.append(snapshot, text,
        { episode_id: ep.id, decision_id: record.id, sent_at: now,
            scene: { has_narration: narration, narration_audience: 'player', has_dialogue: speech } },
        () => agent.valid(token, snapshot) && isScene(agent.state) && !quietUntil(agent.settings(), agent.clock.now())
            && (!speech || sceneContext(agent, snapshot).permissions.allow_send)
            && (!narration || sceneContext(agent, snapshot).permissions.allow_narration),
        () => {
            // 与原发送路径一样先占用额度和收据；保存/渲染失败不自动重复发送。
            agent.countOutput();
            if (narration) {
                agent.countNarration();
                record.scene_outcome = 'COMMIT_RESERVED';
            }
            if (speech) {
                agent.countSpeech(snapshot, now); record.speech_outcome = 'COMMIT_RESERVED';
            }
            record.outcome = 'COMMIT_RESERVED';
            plan(); agent.storage.write(agent.state);
        });
    if (sent) {
        if (narration) record.scene_outcome = 'DISPLAYED';
        if (speech) record.speech_outcome = 'SENT';
        record.outcome = speech ? 'SENT' : 'SCENE_DISPLAYED';
    } else if (ep.status === 'CHECKING') {
        if (narration) record.scene_outcome = 'DISCARDED';
        if (speech) record.speech_outcome = 'DISCARDED';
        record.outcome = 'DISCARDED'; agent.defer(now + timing(settings, ep).interval, '提交前状态变化，丢弃场景输出');
    }
}
