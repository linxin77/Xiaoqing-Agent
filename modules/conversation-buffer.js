import { Scheduler } from './scheduler.js';
import { isEnabled } from './settings.js';
import { BufferEngine, buildBufferContext } from './buffer-engine.js';
import { DecisionError, describeFailure } from './errors.js';
import { sceneContext } from './scene.js';

const ACTIVE = new Set(['BUFFERING', 'WAITING', 'CHECKING']);
const MAX_CHECKS = 3;
const MAX_LIFETIME = 120_000;

// 秒级接话与 Agent 的分钟级主动联系各有一只计时器，共用模型锁和最终提交检查。
export class ConversationBuffer {
    constructor(agent) {
        this.agent = agent; this.adapter = agent.adapter; this.clock = agent.clock;
        this.coordinator = agent.coordinator; this.engine = new BufferEngine(this.adapter);
        this.scheduler = new Scheduler(this.clock);
        this.state = null; this.incoming = null; this.revision = 0; this.inFlight = false; this.stopped = false;
    }
    changed() { this.agent.changed(); }
    enabled(snapshot) {
        const settings = this.agent.settings();
        const timeHeld = !!this.agent.state?.hold || this.state?.resumeFromTimePause && ACTIVE.has(this.state.status);
        return !!snapshot && !this.stopped && (settings.bufferEnabled || timeHeld) && isEnabled(settings, snapshot.characterKey);
    }
    blocksProactive() { return !!this.state && ACTIVE.has(this.state.status); }
    syncTimePause(record) {
        this.revision++; this.scheduler.cancel();
        const state = this.state;
        if (state && ACTIVE.has(state.status)) {
            const delta = Math.max(0, record.total - (state.pauseClockMilliseconds ?? 0));
            for (const key of ['startAt', 'lastActivityAt', 'dueAt', 'deadlineAt']) state[key] += delta;
            state.pauseClockMilliseconds = Math.max(state.pauseClockMilliseconds ?? 0, record.total);
            if (record.held) state.heldAt = record.since + Math.max(0, state.pauseClockMilliseconds - record.total);
            else delete state.heldAt;
            if (state.status === 'CHECKING') {
                state.status = 'BUFFERING';
                state.dueAt = (state.heldAt ?? this.clock.now()) + this.agent.settings().bufferSeconds * 1000;
            }
            this.changed();
        }
        this.schedule();
    }
    closeReceipt(state) {
        try {
            const receipt = this.coordinator.readBuffer(state.snapshot);
            this.coordinator.writeBuffer(state.snapshot, { ...receipt, done: true, nextAt: 0 }, this.clock.now());
        } catch { /* 存储不可用时不发送；不能让输入事件因保存失败而崩溃。 */ }
    }
    cancel(reason = '本轮缓冲已取消') {
        this.revision++; this.scheduler.cancel(); this.incoming = null;
        if (this.state && ACTIVE.has(this.state.status)) {
            this.closeReceipt(this.state);
            this.state.status = 'CANCELED'; this.state.reason = reason;
        }
        this.changed();
    }
    userMessage() {
        const snapshot = this.adapter.snapshot();
        if (this.incoming?.userMarker === snapshot?.userMarker && this.incoming?.key === snapshot?.key) return;
        if (this.state?.snapshot.userMarker === snapshot?.userMarker && this.state.snapshot.key === snapshot?.key) return;
        this.cancel('用户继续发送消息，旧回复已作废');
        if (this.enabled(snapshot)) this.incoming = { key: snapshot.key, userMarker: snapshot.userMarker };
    }
    intercept(_chat, _contextSize, abort, type) {
        // 只接管刚发送用户文本后的普通回复，重生成、继续、quiet、群聊与附件仍走原流程。
        if (type !== undefined && type !== 'normal') return false;
        const snapshot = this.adapter.snapshot();
        if (!this.enabled(snapshot) || !this.adapter.canBuffer()
            || this.incoming?.key !== snapshot.key || this.incoming.userMarker !== snapshot.userMarker) return false;
        abort(false); // 官方接口负责恢复酒馆按钮与生成状态，不修改核心变量、不模拟点击。
        this.incoming = null;
        const now = this.clock.now();
        this.state = {
            id: `buffer_${globalThis.crypto.randomUUID()}`, snapshot,
            status: 'BUFFERING', startAt: now, lastActivityAt: now,
            dueAt: now + this.agent.settings().bufferSeconds * 1000,
            deadlineAt: now + MAX_LIFETIME, history: [], failures: 0,
            reason: '等待用户是否还有下一条消息', error: null,
            heldAt: this.agent.state?.hold ? now : null,
            pauseClockMilliseconds: this.agent.pauseClockValue(),
            resumeFromTimePause: !!this.agent.state?.hold && !this.agent.settings().bufferEnabled,
        };
        this.revision++; this.schedule(); this.changed();
        return true;
    }
    inputChanged() {
        if (this.agent.state?.hold) return;
        const state = this.state;
        if (!state || !ACTIVE.has(state.status)) return;
        this.revision++;
        state.lastActivityAt = this.clock.now(); state.status = 'BUFFERING';
        state.dueAt = this.clock.now() + this.agent.settings().bufferSeconds * 1000;
        state.reason = '正在输入，等待停止输入或发送草稿';
        this.schedule(); this.changed();
    }
    contextChanged(snapshot) {
        const state = this.state;
        if (!state || !ACTIVE.has(state.status)) return;
        if (!snapshot || snapshot.key !== state.snapshot.key || snapshot.userMarker !== state.snapshot.userMarker) {
            this.cancel('聊天或用户消息已变化'); return;
        }
        if (snapshot.conversationMark === state.snapshot.conversationMark && snapshot.cardMark === state.snapshot.cardMark) return;
        this.revision++;
        state.snapshot = snapshot; state.status = 'BUFFERING'; state.lastActivityAt = this.clock.now();
        state.reason = '上下文已更新，重新等待后读取最新内容';
        state.dueAt = this.clock.now() + this.agent.settings().bufferSeconds * 1000;
        this.schedule(); this.changed();
    }
    schedule() {
        this.scheduler.cancel();
        const state = this.state;
        if (!state || !['BUFFERING', 'WAITING'].includes(state.status) || this.stopped || this.agent.state?.hold) return;
        this.scheduler.at(Math.min(state.dueAt, state.deadlineAt), () => this.tick());
    }
    defer(seconds, reason) {
        const state = this.state;
        state.status = 'WAITING'; state.reason = reason;
        state.dueAt = Math.min(this.clock.now() + seconds * 1000, state.deadlineAt);
        this.schedule(); this.changed();
    }
    finish(status, reason) {
        this.scheduler.cancel();
        this.state.status = status; this.state.reason = reason;
        this.changed();
    }
    valid(token, snapshot, state) {
        const current = this.adapter.snapshot();
        this.agent.syncTimePause(current);
        return !this.agent.state?.hold && this.state === state && token === this.revision && state.status === 'CHECKING'
            && this.enabled(current) && !this.agent.busy && !this.adapter.hasDraft()
            && current.key === snapshot.key && current.userMarker === snapshot.userMarker
            && current.conversationMark === snapshot.conversationMark && current.cardMark === snapshot.cardMark
            && this.clock.now() < state.deadlineAt && !this.coordinator.readBuffer(snapshot).done;
    }
    async tick() {
        if (this.agent.syncTimePause()) {
            await this.agent.persist(); this.agent.schedule();
            if (this.clock.now() < (this.state?.dueAt ?? 0)) return;
        }
        const state = this.state, now = this.clock.now();
        if (!state || !['BUFFERING', 'WAITING'].includes(state.status) || this.stopped || this.agent.state?.hold) return;
        if (now >= state.deadlineAt) {
            this.finish('DONE', '本轮短期等待已结束，长期主动联系仍按原计时运行'); this.closeReceipt(state); return;
        }
        const initial = this.adapter.snapshot();
        if (!this.enabled(initial) || initial.key !== state.snapshot.key || initial.userMarker !== state.snapshot.userMarker) {
            this.cancel('聊天、用户消息或设置已变化'); return;
        }
        const seconds = this.agent.settings().bufferSeconds;
        if (this.adapter.hasDraft() || now - state.lastActivityAt < seconds * 1000) {
            this.defer(seconds, '等待用户完成输入，未发送草稿不会交给模型'); return;
        }
        if (this.inFlight || this.agent.inFlight || this.agent.busy || !this.adapter.available()) {
            this.defer(1, '等待现有模型请求结束或连接恢复'); return;
        }
        const token = this.revision;
        let stage = '标签页协调';
        this.inFlight = true;
        try {
            const acquired = await this.coordinator.exclusive(initial.key, async () => {
                if (this.state !== state || token !== this.revision) return true;
                stage = '读取接话去重记录';
                const receipt = this.coordinator.readBuffer(initial);
                if (receipt.done) { this.finish('DONE', '本条用户消息已在其他标签页处理'); return true; }
                if (receipt.nextAt > this.clock.now()) { this.defer((receipt.nextAt - this.clock.now()) / 1000, '遵守其他标签页的缓冲间隔'); return true; }
                if (receipt.checks >= MAX_CHECKS) { this.finish('DONE', '本轮短期判断次数已用完'); this.closeReceipt(state); return true; }
                state.status = 'CHECKING'; state.reason = '正在判断是否适合接话'; this.changed();
                stage = '保存接话去重记录';
                this.coordinator.writeBuffer(initial, { checks: receipt.checks + 1, nextAt: this.clock.now() + seconds * 1000, done: false }, this.clock.now());
                const watchdog = this.clock.setTimeout(() => {
                    if (this.state !== state || token !== this.revision) return;
                    state.error = describeFailure(new DecisionError('REQUEST_TIMEOUT'), stage);
                    this.revision++; this.finish('PAUSED', '本轮接话请求超时，迟到回复会丢弃'); this.closeReceipt(state);
                }, Math.min(this.agent.settings().timeoutSeconds * 1000, state.deadlineAt - this.clock.now()));
                try {
                    stage = '加载角色资料';
                    await this.adapter.prepare();
                    if (this.state !== state || token !== this.revision) return true;
                    stage = '读取聊天上下文';
                    const snapshot = this.adapter.snapshot();
                    if (snapshot?.key !== initial.key || snapshot?.userMarker !== initial.userMarker) return true;
                    stage = '构建接话上下文';
                    const scene = sceneContext(this.agent, snapshot);
                    const prompt = buildBufferContext(snapshot, state, this.agent.settings(), this.clock.now(), scene);
                    stage = '模型请求';
                    const decision = await this.engine.decide(prompt, { scene: !!scene });
                    stage = '校验当前聊天状态';
                    if (!this.valid(token, snapshot, state)) return true;
                    state.failures = 0; state.error = null;
                    stage = '记录接话决策';
                    const record = { time: this.clock.now(), action: decision.action,
                        next_check_seconds: decision.next_check_seconds, outcome: 'PROPOSED',
                        thought: this.agent.settings().saveMemory ? decision.thought : null,
                        pending_intention: this.agent.settings().saveMemory ? decision.pending_intention : null };
                    state.history.push(record);
                    if (this.agent.state?.owner === snapshot.key) {
                        this.agent.state.bufferHistory ??= [];
                        this.agent.state.bufferHistory.push(record);
                        this.agent.state.bufferHistory = this.agent.state.bufferHistory.slice(-10);
                    }
                    if (decision.action === 'REPLY') {
                        stage = '提交接话消息';
                        const sent = await this.adapter.append(snapshot, decision.message,
                            { kind: 'buffered_reply', episode_id: state.id, decision_id: `${state.id}:${receipt.checks}`, sent_at: this.clock.now() },
                            () => this.valid(token, snapshot, state),
                            () => {
                                this.coordinator.writeBuffer(snapshot, { checks: receipt.checks + 1, nextAt: 0, done: true }, this.clock.now());
                                this.finish('DONE', '已综合连续消息回复一次'); record.outcome = 'REPLIED';
                                if (this.agent.state?.owner === snapshot.key) this.agent.storage.write(this.agent.state);
                            });
                        if (!sent) { record.outcome = 'DISCARDED'; if (state.status === 'CHECKING') this.defer(seconds, '提交前状态变化，旧回复已丢弃'); }
                    } else if (decision.action === 'END') {
                        record.outcome = 'ENDED';
                        this.finish('DONE', '模型选择暂不接话；长期主动联系仍按原计时运行'); this.closeReceipt(state);
                    } else if (receipt.checks + 1 >= MAX_CHECKS) {
                        record.outcome = 'WAITING_LONG';
                        this.finish('DONE', '模型继续等待，本轮短期判断结束'); this.closeReceipt(state);
                    } else {
                        record.outcome = 'WAITING';
                        const wait = Math.min(60, Math.max(seconds, decision.next_check_seconds));
                        this.defer(wait, '模型认为用户可能还没说完，继续等待');
                        this.coordinator.writeBuffer(snapshot, { checks: receipt.checks + 1, nextAt: state.dueAt, done: false }, this.clock.now());
                    }
                } finally { this.clock.clearTimeout(watchdog); }
                return true;
            });
            if (!acquired && this.state === state && token === this.revision) this.defer(1, '其他标签页正在使用模型');
        } catch (error) {
            if (this.state === state && token === this.revision && ACTIVE.has(state.status)) {
                state.failures++; state.error = `接话失败（第 ${state.failures} 次）。${describeFailure(error, stage)}`;
                if (this.agent.settings().debug) console.warn('[Xiaoqing]', state.error);
                if (state.failures >= 2) { this.finish('PAUSED', '接话重试已用尽；未发送异常回复'); this.closeReceipt(state); }
                else this.defer(seconds, '接话决策失败，稍后重试一次');
            }
        } finally {
            this.inFlight = false;
            if (this.state === state && state.status === 'CHECKING') this.defer(seconds, '过期接话结果已丢弃，重新等待');
            else this.schedule();
            if (this.agent.state?.owner === state.snapshot.key) await this.agent.persist();
            this.changed();
        }
    }
    clearMemory() {
        this.cancel('已删除本轮接话状态');
        if (this.state) { this.state.history = []; this.state.error = null; }
        this.changed();
    }
    shutdown() { this.cancel('插件已停用'); this.stopped = true; }
}

export function listenForDraft(buffer, document = globalThis.document) {
    const listener = event => { if (event.target?.id === 'send_textarea') buffer.inputChanged(); };
    document?.addEventListener('input', listener);
    return () => document?.removeEventListener('input', listener);
}
