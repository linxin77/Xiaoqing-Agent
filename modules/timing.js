import { MINUTE } from './settings.js';

// 同一套状态机的测试节奏；保留所有正式分钟设置，关闭快测即可恢复。
export function timing(settings, ep = null) {
    if (ep?.dualPhase) {
        const maximum = settings.maxWaitMinutes * MINUTE;
        if (ep.phase === 'slow') return { profile: 'dual:slow', first: 0, interval: settings.minCheckMinutes * MINUTE,
            contact: settings.contactGapMinutes * MINUTE, maximum, busy: 30_000 };
        const step = settings.fastTestSeconds * 1000;
        return { profile: `dual:fast:${settings.fastTestSeconds}:${settings.slowStartMinutes}:${settings.fastPhaseMaxMinutes}`,
            first: step, interval: step, contact: step, maximum, busy: 1000 };
    }
    if (settings.fastTestEnabled) {
        const step = settings.fastTestSeconds * 1000;
        return { profile: `fast:${settings.fastTestSeconds}`, first: step, interval: step, contact: step,
            maximum: Math.min(settings.maxWaitMinutes, 5) * MINUTE, busy: 1000 };
    }
    return { profile: 'normal', first: settings.firstCheckMinutes * MINUTE,
        interval: settings.minCheckMinutes * MINUTE, contact: settings.contactGapMinutes * MINUTE,
        maximum: settings.maxWaitMinutes * MINUTE, busy: 30_000 };
}

export function waitDuration(settings, requestedMinutes, ep = null) {
    const fast = ep?.dualPhase ? ep.phase !== 'slow' : settings.fastTestEnabled;
    const minimum = timing(settings, ep).interval;
    if (!settings.adaptiveWaitEnabled) return fast ? minimum
        : Math.min(1440, Math.max(settings.minCheckMinutes, requestedMinutes)) * MINUTE;
    const maximum = Math.max(minimum, fast ? settings.fastWaitMaxSeconds * 1000 : settings.quietWaitMaxMinutes * MINUTE);
    const suggested = requestedMinutes * (fast ? 1000 : MINUTE);
    const backoff = minimum * settings.quietWaitFactor ** Math.min(10, Math.max(0, (ep?.silentWaitCount ?? 0) - 1));
    return Math.max(minimum, Math.min(maximum, Math.max(suggested, backoff)));
}

export function fastTestPrompt(settings, ep = null) {
    if (!settings || (ep?.dualPhase ? ep.phase === 'slow' : !settings.fastTestEnabled)) return '';
    return `\n用户明确开启了快速测试节奏。首次检查和对白联系冷却为 ${settings.fastTestSeconds} 秒，当前快阶段有独立时限。
${settings.adaptiveWaitEnabled ? `WAIT 建议按一分钟压缩为一秒换算；实际至少 ${settings.fastTestSeconds} 秒、至多 ${Math.max(settings.fastTestSeconds, settings.fastWaitMaxSeconds)} 秒。连续安静 WAIT 会逐步延长间隔，不要求每次检查都有新内容。` : `后续 WAIT 固定为 ${settings.fastTestSeconds} 秒，不管你提出等多少分钟。`}
environment.test_silence_minutes 与 test_since_last_decision_minutes 是按真实有效等待的 60 倍换算的测试时间。请据此评估通常等几分钟后会采取什么行动，让用户能快速验证循环；真实 silence_minutes 和 now 仍保留原值。
这是测试换算，不是玩家角色已站了这么久、世界时间已经流逝的事实；不可因此代写玩家行为。用户明确说要开会、构思或安静若干分钟时，以有效世界时间尊重这个约定，不能用测试倍率提前认定约定已过。保留人设、发送权限、暂停和免打扰规则，不强迫开口；仍可自然等待或 END。`;
}
