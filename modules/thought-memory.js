const HISTORY_LIMIT = 20;
export function emptySummary() { return { total: 0, actions: { WAIT: 0, SEND_MESSAGE: 0, END: 0 }, last_simulated_state: null }; }

export function remember(episode, decision, now, saveMemory, outcome = 'PROPOSED') {
    const record = {
        id: `${episode.id}:${episode.decisionCount++}`, time: now,
        elapsed_minutes: Math.max(0, (now - episode.startAt) / 60_000),
        excluded_pause_milliseconds: episode.pausedMilliseconds ?? 0,
        action: decision.action, next_check_minutes: decision.next_check_minutes,
        thought: saveMemory ? decision.thought : null,
        pending_intention: saveMemory ? decision.pending_intention : null,
        outcome,
    };
    episode.history.push(record);
    while (episode.history.length > HISTORY_LIMIT) {
        const old = episode.history.shift();
        episode.summary.total++;
        episode.summary.actions[old.action] = (episode.summary.actions[old.action] ?? 0) + 1;
        if (saveMemory && old.thought) episode.summary.last_simulated_state = {
            label: '角色模拟状态，可能包含猜测，不是客观事实',
            thought: old.thought, pending_intention: old.pending_intention,
        };
    }
    return record;
}

export function archiveEpisode(episode, now) {
    const counts = { ...episode.summary.actions };
    for (const record of episode.history) counts[record.action] = (counts[record.action] ?? 0) + 1;
    return {
        id: episode.id, startAt: episode.startAt, endAt: now,
        status: episode.status, reason: episode.reason,
        facts: { sent_count: episode.sentCount, narration_count: episode.narrationCount ?? 0, last_user_marker: episode.userMarker },
        decisions: counts,
        simulated_state: episode.history.at(-1)?.thought ?? episode.summary.last_simulated_state ?? null,
    };
}

export function removeThoughts(state) {
    for (const record of state.bufferHistory ?? []) { record.thought = null; record.pending_intention = null; }
    for (const record of state.episode?.history ?? []) { record.thought = null; record.pending_intention = null; }
    if (state.episode) state.episode.summary.last_simulated_state = null;
    for (const archived of state.archives) archived.simulated_state = null;
}
