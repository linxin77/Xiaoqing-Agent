export function listen(getContext, agent) {
    const { eventSource, eventTypes: types } = getContext();
    const bindings = [];
    const on = (name, handler) => {
        if (!types[name]) return;
        const safe = (...args) => {
            // 事件函数同步启动，让 invalidate 在其他异步回调运行前生效。
            try { Promise.resolve(handler(...args)).catch(() => { agent.pause('事件处理失败，请查看插件设置'); }); }
            catch { agent.pause('事件处理失败，请查看插件设置'); }
        };
        eventSource.on(types[name], safe); bindings.push([types[name], safe]);
    };
    on('CHAT_CHANGED', () => { agent.buffer?.cancel('切换聊天，旧接话已取消'); return agent.load(); });
    on('MESSAGE_SENT', index => {
        const ctx = getContext();
        if (ctx.chat[index]?.is_user && !ctx.chat[index]?.is_system) {
            agent.buffer?.userMessage(); return agent.userMessage();
        }
    });
    on('MESSAGE_RECEIVED', (index, type) => {
        if (!['xiaoqing', 'xiaoqing_buffer'].includes(type)) agent.buffer?.cancel('已有其他回复，本轮缓冲取消');
        return type !== 'xiaoqing' ? agent.contextChanged() : undefined;
    });
    // STARTED 在 slash 命令前触发；AFTER_COMMANDS 才代表确实进入正常生成流程。
    on('GENERATION_STARTED', (_type, _options, dryRun) => {
        if (dryRun) return;
        agent.buffer?.cancel('开始新的生成，旧接话已取消');
        return agent.contextChanged({ generation: true });
    });
    on('GENERATION_AFTER_COMMANDS', (_type, _options, dryRun) => !dryRun ? agent.generationStarted() : undefined);
    on('GENERATION_ENDED', () => agent.generationEnded());
    on('GENERATION_STOPPED', () => {
        if (agent.state?.hold) { agent.generationEnded(); return; }
        agent.buffer?.cancel('用户停止了生成'); return agent.generationStopped();
    });
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'CHARACTER_EDITED']) {
        on(name, () => agent.contextChanged({ destructive: true, event: name }));
    }
    for (const name of ['MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED', 'PERSONA_CHANGED']) {
        on(name, () => agent.contextChanged({ destructive: true, event: name }));
    }
    const syncPause = event => {
        if (agent.state?.owner && event.key === agent.coordinator.timePauseKey({ key: agent.state.owner })) {
            void agent.timePauseChanged().catch(() => agent.pause('时间暂停同步失败，请检查本地存储'));
        }
    };
    globalThis.addEventListener?.('storage', syncPause);
    return () => {
        for (const [type, handler] of bindings) eventSource.removeListener(type, handler);
        globalThis.removeEventListener?.('storage', syncPause);
    };
}
