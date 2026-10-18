import { MINUTE } from './settings.js';

export const isDual = ep => ep?.dualPhase === true;
export const isFastPhase = ep => isDual(ep) && ep.phase === 'fast';
export const isBetween = ep => isDual(ep) && ep.phase === 'between';
export const phaseSentCount = ep => isDual(ep) && ep.phase === 'slow' ? ep.slowSentCount ?? 0 : ep?.sentCount ?? 0;
export const phaseNarrationCount = ep => isDual(ep) && ep.phase === 'slow' ? ep.slowNarrationCount ?? 0 : ep?.narrationCount ?? 0;
export const phaseOutputCount = ep => isDual(ep) ? ep.phase === 'slow' ? ep.slowOutputCount ?? 0 : ep.fastOutputCount ?? 0 : ep?.outputCount ?? 0;

export function configurePhases(ep, settings) {
    if (!settings.dualPhaseEnabled) { ep.dualPhase = false; return; }
    if (!isDual(ep)) {
        ep.dualPhase = true; ep.phase = 'fast'; ep.slowSentCount = 0; ep.slowNarrationCount = 0;
        ep.fastOutputCount = ep.outputCount ?? 0; ep.slowOutputCount = 0;
    }
    ep.fastDeadlineAt = ep.startAt + settings.fastPhaseMaxMinutes * MINUTE;
    if (ep.phase !== 'slow') ep.slowEligibleAt = Math.max(ep.startAt + settings.slowStartMinutes * MINUTE,
        ep.fastEndedAt == null ? 0 : ep.fastEndedAt + settings.fastTestSeconds * 1000);
}

export function receiptSnapshot(snapshot, ep, phase = null) {
    return isDual(ep) ? { ...snapshot, phaseKey: phase ?? (ep.phase === 'slow' ? 'slow' : 'fast') } : snapshot;
}

export function phasePrompt(ep) {
    if (!isDual(ep)) return '';
    return `\n当前是同一角色的快慢两阶段互动，当前阶段为 ${ep.phase === 'slow' ? '慢速重新联系' : '快速连续互动'}。
本双阶段协议把 action 枚举扩展为 WAIT、SEND_MESSAGE、END、STOP，其余字段和格式规则沿用。
快阶段 END 只表示本轮即时互动收尾；真实用户沉默超过门槛后，系统仍会重新判断慢阶段。慢阶段 END 则结束整次跟进。
STOP 仅用于实际用户明确要求不再主动联系、停止跟进的情况，终止两个阶段；message 和等待时间必须为 null，场景 narration 必须为空字符串。角色暂时没有话说应选 END，不能选 STOP。
可见输出额度是整轮快慢阶段共享的最高次数，不是任务指标，不需要使用完所有自主行动机会。快阶段 END 后剩余额度可供慢阶段使用；若快阶段已用完总额度，整轮停止，不补发慢阶段。
慢阶段参考真实沉默时间，不沿用快阶段的测试倍率。沿用实际聊天中已发生的动作、人物位置和事务进度，剧情时间不要倒退；快阶段的加速等待参考不等于现实离线时间。
刚才已问过、用户未回答的问题不要反复催问。可以自然分享新见闻、换话题，或继续等，也可以 END。五分钟门槛不是必须发送的命令。玩家明确说不再联系时选 STOP，不得用新话题绕过。`;
}
