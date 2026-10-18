import { isScene } from '../modules/scene.js';
import { timing } from '../modules/timing.js';
import { isDual } from '../modules/phases.js';
const STATUS = { WAITING: '等待中', CHECKING: '决策生成中', PAUSED: '已暂停', ENDED: '已结束', CANCELED: '已取消' };
const SCENE_OUTCOME = { DISPLAYED: '已写入聊天并完成渲染流程', NO_CHANGE: '本轮没有旁白',
    PROPOSED: '准备提交', COMMIT_RESERVED: '已占用去重额度，渲染/保存尚未确认；查看错误信息，避免手动重复发送',
    BLOCKED_BY_POLICY: '未写入（免打扰限制）', DISCARDED: '未写入（上下文已变化，旧结果丢弃）' };
const SPEECH_OUTCOME = { SENT: '已写入聊天并完成渲染流程', COMMIT_RESERVED: '已占用去重额度，渲染/保存尚未确认',
    BLOCKED_BY_POLICY: '未写入（发送权限、次数、联系间隔或免打扰限制）', DISCARDED: '未写入（上下文已变化）' };
export async function mountSettings(agent, container = document.querySelector('#extensions_settings2')) {
    if (!container) throw new Error('找不到酒馆扩展设置容器');
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) throw new Error('无法读取小晴设置界面');
    const template = document.createElement('template');
    template.innerHTML = await response.text(); // 仅加载插件随附静态 HTML，无模型/用户内容。
    container.append(template.content.cloneNode(true));
    const root = container.querySelector('#xiaoqing-agent-settings');
    const controls = document.createElement('div');
    controls.id = 'xiaoqing-chat-controls'; controls.className = 'xq-chat-controls';
    const holdButton = document.createElement('button');
    holdButton.type = 'button'; holdButton.className = 'menu_button';
    holdButton.id = 'xq-chat-hold'; controls.append(holdButton);
    const holdNotice = document.createElement('span');
    holdNotice.setAttribute('role', 'status'); holdNotice.setAttribute('aria-live', 'polite'); controls.append(holdNotice);
    const composer = document.querySelector('#send_form') ?? document.querySelector('#send_textarea');
    composer?.before(controls);
    const notice = message => { root.querySelector('#xq-notice').textContent = message; };
    const render = () => {
        const settings = agent.settings();
        const snapshot = agent.adapter.snapshot(), ep = agent.episode(), now = agent.effectiveNow();
        const secondsMode = isDual(ep) ? ep.phase !== 'slow' : settings.dualPhaseEnabled || settings.fastTestEnabled;
        const duration = (milliseconds, seconds = secondsMode) => seconds ? `${Math.max(0, Math.ceil(milliseconds / 1000))} 秒`
            : `${Math.max(0, milliseconds / 60_000).toFixed(1)} 分钟`;
        for (const input of root.querySelectorAll('[data-setting]')) {
            if (input === document.activeElement) continue;
            const value = settings[input.dataset.setting];
            if (input.type === 'checkbox') input.checked = value;
            else input.value = value;
        }
        for (const key of ['firstCheckMinutes', 'minCheckMinutes', 'contactGapMinutes']) {
            root.querySelector(`[data-setting="${key}"]`).disabled = settings.dualPhaseEnabled
                ? key === 'firstCheckMinutes' : settings.fastTestEnabled;
        }
        root.querySelector('[data-setting="fastTestSeconds"]').disabled = !settings.dualPhaseEnabled && !settings.fastTestEnabled;
        root.querySelector('[data-setting="fastTestEnabled"]').disabled = settings.dualPhaseEnabled;
        for (const key of ['slowStartMinutes', 'fastPhaseMaxMinutes']) root.querySelector(`[data-setting="${key}"]`).disabled = !settings.dualPhaseEnabled;
        root.querySelector('#xq-fast-test-hint').hidden = settings.dualPhaseEnabled || !settings.fastTestEnabled;
        root.querySelector('#xq-dual-phase-hint').hidden = !settings.dualPhaseEnabled;
        const mode = root.querySelector('#xq-interaction-mode');
        mode.disabled = !snapshot || agent.state?.owner !== snapshot.key;
        root.dataset.owner = mode.disabled ? '' : snapshot.key;
        if (mode !== document.activeElement) mode.value = isScene(agent.state) ? 'scene' : 'chat';
        root.querySelector('#xq-scene-hint').hidden = !isScene(agent.state);
        const char = root.querySelector('#xq-character-enabled');
        char.disabled = !snapshot; char.checked = snapshot ? settings.characters[snapshot.characterKey]?.enabled !== false : false;
        const held = !!agent.state?.hold;
        for (const button of [holdButton, root.querySelector('#xq-hold')]) {
            button.disabled = mode.disabled || !settings.enabled;
            button.textContent = held ? '▶ 继续时间' : '⏸ 暂停时间';
            button.setAttribute('aria-pressed', String(held));
            button.title = '暂停当前聊天的世界时间：角色自主行为、场景推进和插件接话全部冻结；继续后从剩余时间运行。同浏览器标签页同步。';
        }
        controls.hidden = !snapshot || !settings.enabled;
        holdNotice.textContent = held ? '时间已暂停，安心构思；准备好后继续时间。' : '需要构思时可暂停时间，角色与场景会等你。';
        root.querySelector('#xq-resume').disabled = held || ep?.status !== 'PAUSED';
        root.querySelector('#xq-cancel').disabled = !ep || !['WAITING', 'CHECKING', 'PAUSED'].includes(ep.status);
        const lines = [`角色：${snapshot?.characterName ?? '请选择单角色聊天'}`, `状态：${held ? '时间已暂停（角色与场景停止推进）' : STATUS[ep?.status] ?? '无任务（等待新的用户消息）'}`];
        lines.push(`互动模式：${isScene(agent.state) ? '场景角色扮演' : '纯聊天'}`);
        const phaseName = { fast: '快速互动', between: '等待慢阶段门槛', slow: '慢速重新联系' };
        lines.push(isDual(ep) || settings.dualPhaseEnabled
            ? `计时：快慢两阶段 · 快阶段 ${settings.fastTestSeconds} 秒 / 慢阶段沉默门槛 ${settings.slowStartMinutes} 分钟`
            : settings.fastTestEnabled ? `计时：快速测试 · 首检 / WAIT / 冷却 ${settings.fastTestSeconds} 秒，最长 ${duration(timing(settings, ep).maximum)}` : '计时：分钟设置');
        const buffer = agent.buffer?.state;
        const bufferStatus = { BUFFERING: '等你继续说', WAITING: '继续等待', CHECKING: '判断是否接话', DONE: '本轮完成', PAUSED: '已暂停', CANCELED: '已取消' };
        lines.unshift(`连续消息缓冲：${settings.bufferEnabled ? '开启' : '关闭'}`,
            `短期接话：${bufferStatus[buffer?.status] ?? '等待新消息'}`);
        if (buffer) {
            lines.splice(2, 0, `接话说明：${buffer.reason ?? ''}`);
            if (['BUFFERING', 'WAITING'].includes(buffer.status)) lines.splice(3, 0, `约 ${Math.max(0, Math.ceil((buffer.dueAt - now) / 1000))} 秒后重新判断`);
            if (buffer.error) lines.splice(3, 0, buffer.error);
            const lastBufferDecision = buffer.history.at(-1);
            if (lastBufferDecision) lines.splice(3, 0, `接话决定：${lastBufferDecision.action}${lastBufferDecision.thought ? ' · ' + lastBufferDecision.thought : ''}`);
        }
        if (ep) {
            if (isDual(ep)) lines.push(`互动阶段：${phaseName[ep.phase]}`,
                `阶段输出：快 ${ep.fastOutputCount ?? 0}；慢 ${ep.slowOutputCount ?? 0}（共用整轮额度）`);
            lines.push(`有效等待：${duration(now - ep.startAt)}（扣除时间暂停）`,
                `整轮主动消息：${ep.outputCount ?? 0} / ${settings.maxMessages}（含动作旁白）`,
                `自主判断请求：${ep.requestCount ?? 0} / ${settings.maxDecisionCalls}（含失败，短期接话另计）`,
                `连续安静等待：${ep.silentWaitCount ?? 0} 次；自然等待${settings.adaptiveWaitEnabled ? '开启' : '关闭'}`,
                `任务剩余最长时间：${duration(ep.deadlineAt - now, false)}`);
            if (isScene(agent.state)) lines.push(`其中含对白 ${ep.sentCount} 条，含场景旁白 ${ep.narrationCount ?? 0} 条（合并输出只计一次）`);
            if (ep.status === 'WAITING') lines.push(held ? `继续后约 ${duration(ep.dueAt - now)}检查`
                : `下一次检查：${new Date(ep.dueAt).toLocaleString()}（${duration(ep.dueAt - now)}后）`);
            if (ep.reason) lines.push(`说明：${ep.reason}`);
            if (ep.lastContextEvent) lines.push(`最近上下文事件：${ep.lastContextEvent.type}（${new Date(ep.lastContextEvent.time).toLocaleTimeString()}）`);
            if (ep.error) lines.push(`错误：${ep.error}`);
            for (const record of ep.history.slice(-5)) {
                lines.push('', `${new Date(record.time).toLocaleTimeString()} · ${record.action} · ${record.outcome}`);
                if (record.phase) lines.push(`决策阶段：${phaseName[record.phase]}`);
                if (record.scene_outcome) lines.push(`场景旁白：${SCENE_OUTCOME[record.scene_outcome] ?? '执行结果未知，请查看错误信息'}`);
                if (record.speech_outcome) lines.push(`对白：${SPEECH_OUTCOME[record.speech_outcome] ?? '执行结果未知，请查看错误信息'}`);
                if (record.thought) lines.push(`角色状态摘要：${record.thought}`);
                if (record.pending_intention) lines.push(`待定意图（非事实）：${record.pending_intention}`);
                const recordSeconds = record.phase ? record.phase === 'fast' : !isDual(ep) && settings.fastTestEnabled;
                if (recordSeconds && record.action === 'WAIT') lines.push(`模型提出等待：${record.next_check_minutes} 分钟（秒级节奏会覆盖）`);
                if (record.scheduled_minutes != null) lines.push(`实际安排等待：${duration(record.scheduled_minutes * 60_000, recordSeconds)}`);
            }
            if (ep.summary.total) lines.push('', `较早的 ${ep.summary.total} 次决策已压缩为行动计数与带标签的模拟状态。`);
        }
        if (agent.inFlight && ep?.status !== 'CHECKING') lines.push('', '先前请求尚未返回，迟到结果不会发送。');
        root.querySelector('#xq-status').textContent = lines.join('\n');
    };
    const toggleHold = async () => {
        await agent.setHold(!agent.state?.hold, root.dataset.owner); render();
    };
    for (const button of [holdButton, root.querySelector('#xq-hold')]) button.addEventListener('click', () => {
        void toggleHold().catch(() => notice('暂停状态未能保存，请检查当前聊天。'));
    });
    root.querySelector('#xq-interaction-mode').addEventListener('change', async event => {
        const changed = await agent.setInteractionMode(event.target.value, root.dataset.owner);
        render(); notice(changed ? `已保存：${isScene(agent.state) ? '场景角色扮演' : '纯聊天'}。旧模式结果已失效；已结束任务请发新消息开始。` : '聊天已切换，请重新选择模式。');
    });
    for (const input of root.querySelectorAll('[data-setting]')) {
        input.addEventListener('change', async () => {
            const settings = agent.settings();
            settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            agent.storage.saveSettings(settings);
            await agent.settingsChanged(); render(); notice('设置已保存。暂停任务需手动恢复；已结束任务不会重新启动。');
        });
    }
    root.querySelector('#xq-character-enabled').addEventListener('change', async event => {
        const snapshot = agent.adapter.snapshot();
        if (!snapshot) return;
        const settings = agent.settings();
        settings.characters[snapshot.characterKey] = { ...settings.characters[snapshot.characterKey], enabled: event.target.checked };
        agent.storage.saveSettings(settings); await agent.settingsChanged(); render();
    });
    const bind = (selector, action, message) => root.querySelector(selector).addEventListener('click', async () => {
        try { await action(); notice(message); render(); }
        catch { notice('操作未完成，请检查当前聊天和模型连接。'); }
    });
    bind('#xq-cancel', () => agent.cancel(), '已取消；同一次沉默不会重新唤醒。');
    bind('#xq-resume', () => agent.resume(), '已尝试恢复，下一次检查遵守最短间隔。');
    bind('#xq-clear', () => agent.clearMemory(), '已删除当前聊天的心理历程并取消任务；保留最小去重标记。');
    const interval = setInterval(render, 1000);
    render();
    return { render, destroy() { clearInterval(interval); controls.remove(); root.remove(); } };
}


