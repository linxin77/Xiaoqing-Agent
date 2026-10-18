// 模型使用扣除暂停的世界时钟；调度、免打扰和界面诊断继续使用本机时钟。
export function modelClock(now, state = {}) {
    const paused = Math.max(0, Number(state.pauseClockMilliseconds ?? state.pausedMilliseconds) || 0);
    return { now: new Date(now - paused).toISOString(), local_time: new Date(now - paused).toString(),
        clock_basis: '扣除当前聊天累计时间暂停后的世界时间；最近消息按顺序排列，不用现实时间戳推算角色等待。',
        ...(Number.isFinite(state.startAt) ? { last_user_time: new Date(state.startAt - paused).toISOString() } : {}) };
}

export function modelChat(messages) {
    return messages.map(({ time: _time, proactive, ...message }) => ({ ...message,
        // 原始聊天与去重标记不变，避免历史现实时间戳与世界时钟冲突。
        ...(proactive ? { proactive: Object.fromEntries(Object.entries(proactive).filter(([key]) => key !== 'sent_at')) } : {}) }));
}
export const modelHistory = records => records.map(({ time: _time, ...record }) => record);
