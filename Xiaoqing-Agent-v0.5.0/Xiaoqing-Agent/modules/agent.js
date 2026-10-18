import { MINUTE, isEnabled, quietUntil } from './settings.js';
import { buildDecisionContext } from './context-builder.js';
import { emptySummary, remember, archiveEpisode, removeThoughts } from './thought-memory.js';
import { Scheduler } from './scheduler.js';
import { DecisionError, describeFailure } from './errors.js';
import { isScene, sceneContext, executeScene } from './scene.js';
import { timing, waitDuration } from './timing.js';
import { isDual, isFastPhase, isBetween, phaseSentCount, phaseNarrationCount, phaseOutputCount, configurePhases, receiptSnapshot } from './phases.js';

const ACTIVE = new Set(['WAITING', 'CHECKING']);
export class Agent {
    constructor({ adapter, storage, engine, coordinator, clock = {
        now: () => Date.now(),
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: timer => globalThis.clearTimeout(timer),
    }, onChange = () => {} }) {
        Object.assign(this, { adapter, storage, engine, coordinator, clock, onChange });
        this.scheduler = new Scheduler(clock);
        this.state = null; this.revision = 0; this.busy = false; this.inFlight = false; this.stopped = false;
        this.observedContext = null;
    }
    settings() { return this.storage.settings(); }
    changed() { this.onChange(this); }
    async persist() {
        if (!this.state) return;
        if (!this.settings().saveMemory) removeThoughts(this.state);
        await this.storage.save(this.state);
        this.changed();
    }
    episode() { return this.state?.episode; }
    effectiveNow() { return this.state?.hold?.since ?? this.clock.now(); }
    pauseClockValue() {
        const record = this.timePauseRecord;
        return (record?.total ?? 0) + (record?.held ? Math.max(0, this.clock.now() - record.since) : 0);
    }
    syncTimePause(snapshot = this.adapter.snapshot(), record = null) {
        if (!snapshot || this.state?.owner !== snapshot.key) return false;
        try { record ??= this.coordinator.readTimePause(snapshot); }
        catch {
            this.timePauseUnavailable = true;
            this.buffer?.cancel('时间暂停同步不可用'); this.pause('时间暂停同步失败，请检查本地存储'); return false;
        }
        this.timePauseUnavailable = false;
        this.timePauseRecord = record;
        if (!record || this.state.pauseClockRevision === record.revision) return false;
        this.invalidate();
        const ep = this.episode();
        if (ep) {
            const delta = Math.max(0, record.total - (ep.pauseClockMilliseconds ?? 0));
            if (['WAITING', 'CHECKING', 'PAUSED'].includes(ep.status)) {
                for (const key of ['startAt', 'dueAt', 'deadlineAt', 'fastDeadlineAt', 'slowEligibleAt', 'fastEndedAt', 'phaseStartedAt']) {
                    if (Number.isFinite(ep[key])) ep[key] += delta;
                }
                ep.pausedMilliseconds = (ep.pausedMilliseconds ?? 0) + delta;
            }
            ep.pauseClockMilliseconds = Math.max(ep.pauseClockMilliseconds ?? 0, record.total);
        }
        const freezeAt = record.held ? record.since + Math.max(0, (ep?.pauseClockMilliseconds ?? record.total) - record.total) : null;
        this.state.hold = record.held ? { since: freezeAt } : null;
        this.state.pauseClockRevision = record.revision;
        if (ep?.status === 'CHECKING') {
            ep.status = 'WAITING'; ep.dueAt = (freezeAt ?? this.clock.now()) + this.currentTiming().interval;
        }
        this.buffer?.syncTimePause(record);
        if (record.held && this.busy) this.adapter.stopGeneration(snapshot);
        this.changed(); return true;
    }
    async timePauseChanged() {
        if (this.syncTimePause()) { await this.persist(); this.schedule(); }
    }
    currentTiming() { return timing(this.settings(), this.episode()); }
    requestDeadline() {
        const ep = this.episode();
        return isFastPhase(ep) ? Math.min(ep.deadlineAt, ep.fastDeadlineAt) : ep.deadlineAt;
    }
    readReceipt(snapshot, phase = null) { return this.coordinator.read(receiptSnapshot(snapshot, this.episode(), phase)); }
    writeReceipt(snapshot, receipt, now = this.clock.now()) {
        const ep = this.episode();
        receipt = { ...receipt, outputCount: ep.outputCount ?? 0, requestCount: ep.requestCount ?? 0 };
        if (isDual(ep)) receipt = { ...receipt, sentCount: phaseSentCount(ep), narrationCount: phaseNarrationCount(ep),
            outputCount: phaseOutputCount(ep), totalOutputCount: ep.outputCount ?? 0,
            ...(isBetween(ep) ? { closed: true, fastFinished: true, slowEligibleAt: ep.slowEligibleAt } : {}) };
        this.coordinator.write(receiptSnapshot(snapshot, ep), { ...receipt, timingProfile: this.currentTiming().profile }, now);
    }
    mergeReceipt(receipt, phase = this.episode()?.phase) {
        const ep = this.episode();
        ep.requestCount = Math.max(ep.requestCount ?? 0, receipt.requestCount ?? 0);
        const receivedOutputs = receipt.outputCount ?? Math.max(receipt.sentCount, receipt.narrationCount ?? 0);
        if (isDual(ep)) {
            const key = phase === 'slow' ? 'slowOutputCount' : 'fastOutputCount';
            ep[key] = Math.max(ep[key] ?? 0, receivedOutputs);
            ep.outputCount = Math.max(ep.outputCount ?? 0, receipt.totalOutputCount ?? 0,
                (ep.fastOutputCount ?? 0) + (ep.slowOutputCount ?? 0));
        } else ep.outputCount = Math.max(ep.outputCount ?? 0, receivedOutputs);
        if (isDual(ep) && phase === 'slow') {
            ep.slowSentCount = Math.max(ep.slowSentCount ?? 0, receipt.sentCount);
            ep.slowNarrationCount = Math.max(ep.slowNarrationCount ?? 0, receipt.narrationCount ?? 0);
            ep.sentCount = Math.max(ep.sentCount, (ep.fastSentCount ?? 0) + ep.slowSentCount);
            ep.narrationCount = Math.max(ep.narrationCount ?? 0, (ep.fastNarrationCount ?? 0) + ep.slowNarrationCount);
        } else {
            ep.sentCount = Math.max(ep.sentCount, receipt.sentCount);
            ep.narrationCount = Math.max(ep.narrationCount ?? 0, receipt.narrationCount ?? 0);
        }
    }
    finishFast(reason, eligibleAt = null) {
        const ep = this.episode(), settings = this.settings(), now = this.clock.now();
        this.scheduler.cancel();
        ep.fastEndedAt = now; ep.fastEndReason = reason;
        ep.silentWaitCount = 0;
        ep.fastSentCount = ep.sentCount; ep.fastNarrationCount = ep.narrationCount ?? 0;
        ep.slowEligibleAt = Math.max(ep.startAt + settings.slowStartMinutes * MINUTE,
            eligibleAt ?? now + settings.fastTestSeconds * 1000);
        ep.phase = 'between'; ep.status = 'WAITING'; ep.dueAt = Math.min(ep.deadlineAt, ep.slowEligibleAt);
        ep.reason = '快阶段已收尾，等待真实沉默门槛后重新评估';
        delete ep.endedAt; this.changed();
    }
    endCurrentPhase(reason) {
        if (isFastPhase(this.episode())) this.finishFast(reason);
        else this.finish('ENDED', reason);
    }
    contactTime(snapshot) {
        if (isDual(this.episode()) && this.episode().phase === 'slow') return Math.max(this.state.lastSlowSentAt || 0,
            this.settings().characters[snapshot.characterKey]?.lastSlowSentAt || 0, this.coordinator.lastSlowContact(snapshot.characterKey));
        return Math.max(this.state.lastSentAt || 0, this.settings().characters[snapshot.characterKey]?.lastSentAt || 0,
            this.coordinator.lastContact(snapshot.characterKey));
    }
    countSpeech(snapshot, now) {
        const ep = this.episode(), settings = this.settings();
        ep.sentCount++; this.state.lastSentAt = now; this.coordinator.contact(snapshot.characterKey, now);
        const character = { ...settings.characters[snapshot.characterKey], lastSentAt: now };
        if (isDual(ep) && ep.phase === 'slow') {
            ep.slowSentCount = (ep.slowSentCount ?? 0) + 1; this.state.lastSlowSentAt = now;
            character.lastSlowSentAt = now; this.coordinator.slowContact(snapshot.characterKey, now);
        }
        settings.characters[snapshot.characterKey] = character; this.storage.saveSettings(settings);
    }
    countNarration() {
        const ep = this.episode(); ep.narrationCount = (ep.narrationCount ?? 0) + 1;
        if (isDual(ep) && ep.phase === 'slow') ep.slowNarrationCount = (ep.slowNarrationCount ?? 0) + 1;
    }
    countOutput() {
        const ep = this.episode(); ep.outputCount = (ep.outputCount ?? 0) + 1;
        if (isDual(ep)) {
            const key = ep.phase === 'slow' ? 'slowOutputCount' : 'fastOutputCount'; ep[key] = (ep[key] ?? 0) + 1;
        }
    }
    hasOutputBudget() {
        const ep = this.episode(), settings = this.settings();
        return (ep?.outputCount ?? 0) < settings.maxMessages;
    }
    enforceOutputLimit() {
        const ep = this.episode(), settings = this.settings();
        if ((ep.outputCount ?? 0) >= settings.maxMessages) {
            this.finish('ENDED', '达到整轮主动消息上限（含对白和动作旁白）'); return true;
        }
        return false;
    }
    invalidate() { this.revision++; this.scheduler.cancel(); }
    async load() {
        this.invalidate();
        const snapshot = this.adapter.snapshot();
        this.observedContext = snapshot;
        this.state = snapshot ? this.storage.load(snapshot) : null;
        if (snapshot) {
            try {
                let pause = this.coordinator.readTimePause(snapshot);
                if (!pause && this.state.hold) pause = await this.coordinator.setTimePause(snapshot, true, this.clock.now(), this.state.hold.since);
                this.syncTimePause(snapshot, pause);
            } catch { this.timePauseUnavailable = true; this.pause('时间暂停同步失败，请检查本地存储'); }
        }
        const ep = this.episode();
        if (ep) ep.outputCount = Math.max(ep.outputCount ?? 0,
            snapshot.chat.filter(message => !message.is_user && message.proactive?.episode_id === ep.id
                && message.proactive?.kind !== 'buffered_reply').length);
        if (ep && ACTIVE.has(ep.status)) {
            configurePhases(ep, this.settings());
            const currentTiming = this.currentTiming();
            if ((ep.timingProfile ?? 'normal') !== currentTiming.profile) {
                ep.deadlineAt = ep.startAt + currentTiming.maximum;
                ep.dueAt = isBetween(ep) ? ep.slowEligibleAt : this.effectiveNow() + currentTiming.interval;
                ep.timingProfile = currentTiming.profile;
            }
        }
        // 只迁移旧版“更新事件一律取消”的任务，绝不复活用户手动取消的任务。
        if (ep?.status === 'CANCELED' && ep.reason === '聊天或角色资料被编辑、删除或切换候选回复'
            && ep.userMarker === snapshot.userMarker && this.clock.now() < ep.deadlineAt) {
            ep.status = 'WAITING'; ep.reason = '已恢复旧版因上下文更新而取消的任务，将读取最新内容';
            ep.dueAt = Math.max(this.clock.now(), ep.dueAt); delete ep.endedAt;
        }
        if (ep && ACTIVE.has(ep.status)) {
            if (ep.userMarker !== snapshot.userMarker) this.finish('CANCELED', '聊天中的用户消息已变化');
            else if (this.state.hold) { ep.status = 'WAITING'; }
            else if (ep.status === 'CHECKING') this.pause('上次决策被刷新或切换打断，请手动恢复');
            else if (this.clock.now() >= ep.deadlineAt) this.finish('ENDED', '达到最大等待时间');
            else if (!isEnabled(this.settings(), snapshot.characterKey)) this.pause('插件或当前角色已暂停');
            else this.enforceOutputLimit();
            await this.persist();
        }
        this.schedule(); this.changed();
    }
    async userMessage(reason = '用户发送了新消息', event = null) {
        this.invalidate(); // 必须在任何 await 前让旧模型结果失效。
        const snapshot = this.adapter.snapshot();
        this.observedContext = snapshot;
        if (!snapshot?.userMarker) return;
        if (!this.state || this.state.owner !== snapshot.key) this.state = this.storage.load(snapshot);
        this.syncTimePause(snapshot);
        const old = this.episode();
        // MESSAGE_SENT/USER_MESSAGE_RENDERED 或第三方重复事件不能创建两份任务。
        if (old?.userMarker === snapshot.userMarker) { this.schedule(); return; }
        if (old) {
            if (ACTIVE.has(old.status) || old.status === 'PAUSED') { old.status = 'CANCELED'; old.reason = reason; }
            this.state.archives.push(archiveEpisode(old, this.clock.now()));
            this.state.archives = this.state.archives.slice(-5);
        }
        const settings = this.settings();
        if (!isEnabled(settings, snapshot.characterKey)) { this.state.episode = null; await this.persist(); return; }
        const now = this.clock.now();
        if (this.state.hold) this.state.hold.since = now;
        const startAt = Number.isFinite(snapshot.userTime) && snapshot.userTime <= now ? snapshot.userTime : now;
        this.state.episode = {
            id: `ep_${globalThis.crypto.randomUUID()}`, character_id: snapshot.characterKey,
            userMarker: snapshot.userMarker, startAt,
            deadlineAt: startAt + timing(settings).maximum,
            dueAt: startAt + timing(settings).first, timingProfile: timing(settings).profile,
            status: 'WAITING', reason: null, sentCount: 0, narrationCount: 0, outputCount: 0, decisionCount: 0,
            failures: 0, history: [], summary: emptySummary(), error: null,
            requestCount: 0, silentWaitCount: 0,
            lastContextEvent: event ? { type: event, time: now } : null,
            pauseClockMilliseconds: this.pauseClockValue(),
        };
        configurePhases(this.state.episode, settings);
        this.state.episode.deadlineAt = startAt + this.currentTiming().maximum;
        this.state.episode.dueAt = startAt + this.currentTiming().first;
        this.state.episode.timingProfile = this.currentTiming().profile;
        if (this.timePauseUnavailable) this.pause('时间暂停同步失败，请检查本地存储');
        await this.persist(); this.schedule();
    }
    finish(status, reason) {
        this.scheduler.cancel();
        const ep = this.episode();
        if (ep) { ep.status = status; ep.reason = reason; ep.endedAt = this.clock.now(); }
        this.changed();
    }
    pause(reason) { this.invalidate(); this.finish('PAUSED', reason); }
    async cancel() {
        this.buffer?.cancel('用户取消本次等待');
        this.invalidate();
        this.finish('CANCELED', '用户取消本次任务');
        await this.closeReceipt(); await this.persist();
    }
    async closeReceipt() {
        const snapshot = this.adapter.snapshot();
        if (!snapshot || this.state?.owner !== snapshot.key || !this.episode()) return;
        try {
            if (isDual(this.episode())) {
                for (const phase of ['fast', 'slow']) {
                    const key = receiptSnapshot(snapshot, this.episode(), phase), receipt = this.coordinator.read(key);
                    this.coordinator.write(key, { ...receipt, closed: true, hardStop: true, fastFinished: false }, this.clock.now());
                }
            } else {
                const receipt = this.readReceipt(snapshot);
                this.writeReceipt(snapshot, { ...receipt, closed: true });
            }
        } catch { /* 本页的取消仍然有效；存储不可用时其他页也会停止。 */ }
    }
    async clearMemory() {
        this.buffer?.clearMemory();
        // 保留最小运行标记和发送收据，避免删除记忆后同一次沉默再次触发。
        await this.cancel();
        if (this.state) {
            this.state.archives = [];
            this.state.bufferHistory = [];
            const ep = this.episode();
            if (ep) { ep.history = []; ep.summary = emptySummary(); ep.error = null; }
            await this.persist();
        }
    }
    async resume() {
        const snapshot = this.adapter.snapshot(), ep = this.episode();
        if (!ep || this.state?.hold || ep.status !== 'PAUSED' || !snapshot || snapshot.key !== this.state.owner
            || snapshot.userMarker !== ep.userMarker || !isEnabled(this.settings(), snapshot.characterKey)) return;
        configurePhases(ep, this.settings());
        const currentTiming = this.currentTiming();
        ep.deadlineAt = ep.startAt + currentTiming.maximum; ep.timingProfile = currentTiming.profile;
        if (this.clock.now() >= ep.deadlineAt) this.finish('ENDED', '达到最大等待时间');
        else {
            ep.status = 'WAITING'; ep.error = null; ep.reason = null; ep.failures = 0;
            ep.dueAt = isBetween(ep) ? Math.max(this.clock.now(), ep.slowEligibleAt) : this.clock.now() + currentTiming.interval;
        }
        await this.persist(); this.schedule();
    }
    async settingsChanged() {
        this.buffer?.cancel('插件设置已变化');
        this.invalidate();
        const snapshot = this.adapter.snapshot(), ep = this.episode();
        if (ep && ACTIVE.has(ep.status)) {
            const settings = this.settings();
            if (!snapshot || !isEnabled(settings, snapshot.characterKey)) this.pause('设置已关闭或暂停主动行为');
            else {
                // 缩短上限立即生效；增加上限不复活已结束任务。
                configurePhases(ep, settings);
                const currentTiming = this.currentTiming(), profileChanged = (ep.timingProfile ?? 'normal') !== currentTiming.profile;
                ep.deadlineAt = ep.startAt + currentTiming.maximum;
                ep.status = 'WAITING';
                ep.dueAt = profileChanged ? this.effectiveNow() + currentTiming.interval
                    : Math.max(ep.dueAt, this.effectiveNow() + currentTiming.interval);
                if (isBetween(ep)) ep.dueAt = ep.slowEligibleAt;
                ep.timingProfile = currentTiming.profile;
                if (this.effectiveNow() >= ep.deadlineAt) this.finish('ENDED', '达到最大等待时间');
                else this.enforceOutputLimit();
            }
        }
        await this.persist(); this.schedule();
    }
    async setInteractionMode(mode, owner = this.state?.owner) {
        const snapshot = this.adapter.snapshot();
        if (!['chat', 'scene'].includes(mode) || !snapshot || snapshot.key !== owner || this.state?.owner !== owner) return false;
        this.state.scene.mode = mode;
        // settingsChanged 在首次 await 前使缓冲和正在返回的旧模式结果失效。
        await this.settingsChanged();
        return true;
    }
    async setHold(held, owner = this.state?.owner) {
        const snapshot = this.adapter.snapshot();
        if (!snapshot || snapshot.key !== owner || this.state?.owner !== owner) return false;
        const record = await this.coordinator.setTimePause(snapshot, !!held, this.clock.now());
        if (this.state?.owner !== owner || this.adapter.snapshot()?.key !== owner) return false;
        this.syncTimePause(snapshot, record);
        await this.persist(); this.schedule(); return true;
    }
    async contextChanged({ generation = false, destructive = false, event = 'CONTEXT_CHANGED' } = {}) {
        const snapshot = this.adapter.snapshot(), previous = this.observedContext;
        const same = snapshot && previous && snapshot.key === previous.key
            && snapshot.userMarker === previous.userMarker && snapshot.conversationMark === previous.conversationMark
            && snapshot.cardMark === previous.cardMark;
        // 更新通知可能只是界面刷新；没有内容变化时，保留计时器和正在进行的有效决策。
        const force = ['MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED', 'PERSONA_CHANGED'].includes(event);
        if (destructive && same && !force) return;
        this.observedContext = snapshot;
        if (destructive) this.buffer?.contextChanged(snapshot);
        this.revision++;
        const ep = this.episode();
        if (ep && ACTIVE.has(ep.status)) {
            ep.lastContextEvent = { type: event, time: this.clock.now() };
            if (!snapshot || snapshot.key !== this.state.owner || !snapshot.userMarker) {
                this.finish('CANCELED', `会话已变化或没有用户消息（${event}）`);
            } else if (destructive && snapshot.userMarker !== ep.userMarker) {
                // 编辑/删除最后用户消息时以最新消息重建，原决策不能继续执行。
                await this.userMessage(`用户消息变化（${event}），依据最新内容重建`, event); return;
            } else if (ep.status === 'CHECKING') {
                ep.status = 'WAITING'; ep.reason = generation ? '等待正常回复生成完成' : '聊天内容更新，过期决策已丢弃';
                ep.dueAt = this.effectiveNow() + this.currentTiming().interval;
            } else if (destructive) {
                ep.reason = '上下文已更新，将按原定时间读取最新内容';
            }
            await this.persist();
        }
        this.schedule();
    }
    async generationStarted() { this.busy = true; await this.contextChanged({ generation: true }); }
    generationEnded() { this.busy = false; this.schedule(); this.changed(); }
    async generationStopped() {
        this.busy = false;
        if (this.inFlight && this.episode()?.status === 'CHECKING') {
            this.pause('用户停止了模型生成，请手动恢复'); await this.persist();
        } else { this.schedule(); }
    }
    schedule() {
        this.scheduler.cancel();
        const ep = this.episode();
        if (this.stopped || this.state?.hold || !ep || ep.status !== 'WAITING') return;
        const now = this.clock.now();
        this.scheduler.at(Math.min(this.requestDeadline(), Math.max(now, ep.dueAt)), () => this.tick());
        this.changed();
    }
    valid(token, snapshot) {
        const current = this.adapter.snapshot(), ep = this.episode();
        this.syncTimePause(current);
        return !this.stopped && !this.timePauseUnavailable && !this.state?.hold && token === this.revision && ep?.status === 'CHECKING'
            && this.state.owner === snapshot.key && current?.key === snapshot.key
            && ep.userMarker === current.userMarker && current.conversationMark === snapshot.conversationMark
            && current.cardMark === snapshot.cardMark && this.clock.now() < this.requestDeadline()
            && isEnabled(this.settings(), current.characterKey) && !this.busy
            && this.hasOutputBudget()
            && !this.adapter.hasDraft()
            && !this.readReceipt(snapshot).closed;
    }
    defer(time, reason) {
        const ep = this.episode();
        ep.status = 'WAITING'; ep.dueAt = Math.min(time, ep.deadlineAt); ep.reason = reason;
    }
    async tick() {
        if (this.syncTimePause()) {
            await this.persist(); this.schedule();
            if (this.clock.now() < (this.episode()?.dueAt ?? 0)) return;
        }
        const ep = this.episode(), settings = this.settings(), now = this.clock.now();
        if (!ep || ep.status !== 'WAITING' || this.stopped || this.state?.hold) return;
        if (now >= ep.deadlineAt) { this.finish('ENDED', '达到最大等待时间'); await this.closeReceipt(); await this.persist(); return; }
        const initial = this.adapter.snapshot();
        if (!initial || initial.key !== this.state.owner || initial.userMarker !== ep.userMarker) {
            this.finish('CANCELED', '聊天状态发生变化'); await this.persist(); return;
        }
        if (!isEnabled(settings, initial.characterKey)) { this.pause('主动行为已关闭或暂停'); await this.persist(); return; }
        if (isFastPhase(ep) && now >= ep.fastDeadlineAt) {
            this.finishFast('快阶段达到自身时限'); await this.persist(); this.schedule(); return;
        }
        const quiet = quietUntil(settings, now);
        if (quiet) { this.defer(quiet, '免打扰时段'); await this.persist(); this.schedule(); return; }
        if (this.adapter.hasDraft()) {
            this.defer(now + this.currentTiming().busy, '正在输入，等待发送或清空草稿'); this.schedule(); return;
        }
        if (this.busy || this.inFlight || this.buffer?.blocksProactive() || !this.adapter.available()) {
            this.defer(now + this.currentTiming().busy, '等待模型连接、接话缓冲或现有生成结束'); this.schedule(); return;
        }
        const token = this.revision;
        let stage = '标签页协调';
        this.inFlight = true;
        try {
            const acquired = await this.coordinator.exclusive(initial.key, async () => {
                if (token !== this.revision) return true;
                stage = '读取去重记录';
                let receipt = this.readReceipt(initial);
                this.mergeReceipt(receipt);
                if (isDual(ep)) {
                    ep.requestCount = Math.max(ep.requestCount ?? 0, this.readReceipt(initial, 'fast').requestCount ?? 0,
                        this.readReceipt(initial, 'slow').requestCount ?? 0);
                }
                if ((ep.requestCount ?? 0) >= settings.maxDecisionCalls) {
                    this.finish('ENDED', '达到整轮自主判断请求上限'); await this.closeReceipt(); return true;
                }
                if (receipt.closed) {
                    if ((isFastPhase(ep) || isBetween(ep)) && receipt.fastFinished && !receipt.hardStop) {
                        if (isFastPhase(ep)) this.finishFast('其他标签页已结束快阶段', receipt.slowEligibleAt);
                    } else { this.finish('ENDED', '同一次沉默已在其他标签页结束'); return true; }
                }
                if (isBetween(ep)) {
                    if (this.clock.now() < ep.slowEligibleAt) { this.defer(ep.slowEligibleAt, '等待慢阶段门槛'); return true; }
                    this.writeReceipt(initial, { sentCount: ep.sentCount, nextAt: ep.slowEligibleAt, closed: true });
                    ep.phase = 'slow'; ep.phaseStartedAt = this.clock.now(); ep.failures = 0; ep.error = null;
                    ep.timingProfile = this.currentTiming().profile;
                    receipt = this.readReceipt(initial); this.mergeReceipt(receipt);
                    if (receipt.closed) { this.finish('ENDED', '慢阶段已在其他标签页结束'); return true; }
                }
                if (this.enforceOutputLimit()) {
                    this.writeReceipt(initial, { sentCount: ep.sentCount, nextAt: ep.dueAt, closed: ep.status === 'ENDED' }); return true;
                }
                const nextAt = (receipt.timingProfile ?? 'normal') === this.currentTiming().profile ? receipt.nextAt
                    : Math.min(receipt.nextAt, (receipt.updatedAt ?? this.clock.now()) + this.currentTiming().interval);
                if (nextAt > this.clock.now()) { this.defer(nextAt, '遵守其他标签页的检查间隔'); return true; }
                ep.status = 'CHECKING'; ep.reason = null;
                stage = '保存去重记录';
                this.writeReceipt(initial, { sentCount: ep.sentCount, nextAt: this.clock.now() + this.currentTiming().interval, closed: false });
                // 看门狗覆盖保存、浅卡加载和模型调用，而不只覆盖最后的 HTTP 请求。
                const watchdog = this.clock.setTimeout(() => {
                    if (token !== this.revision || this.episode() !== ep) return;
                    if (this.clock.now() >= this.requestDeadline()) {
                        this.invalidate();
                        if (this.clock.now() < ep.deadlineAt && isFastPhase(ep)) this.finishFast('快阶段时限已到，迟到结果丢弃');
                        else this.finish('ENDED', '达到最大等待时间');
                    } else {
                        ep.error = describeFailure(new DecisionError('REQUEST_TIMEOUT'), stage);
                        this.pause('模型请求超时；迟到结果会被丢弃，请待请求结束后手动恢复');
                    }
                    void this.persist().catch(() => console.error('[Xiaoqing] 保存超时状态失败，请检查当前聊天；不记录原始错误。'));
                }, Math.min(settings.timeoutSeconds * 1000, this.requestDeadline() - this.clock.now()));
                try {
                    stage = '保存任务状态';
                    await this.persist();
                    if (token !== this.revision) return true;
                    stage = '加载角色资料';
                    await this.adapter.prepare();
                    stage = '读取聊天上下文';
                    const snapshot = this.adapter.snapshot();
                    if (!snapshot || snapshot.key !== initial.key || snapshot.userMarker !== initial.userMarker || token !== this.revision) return true;
                    this.observedContext = snapshot;
                    stage = '构建决策上下文';
                    const scene = sceneContext(this, snapshot);
                    const prompt = buildDecisionContext(snapshot, ep, settings, this.clock.now(), this.state.bufferHistory ?? [], scene);
                    stage = '模型请求';
                    ep.requestCount = (ep.requestCount ?? 0) + 1;
                    this.writeReceipt(snapshot, { sentCount: ep.sentCount, nextAt: this.clock.now() + this.currentTiming().interval, closed: false });
                    await this.persist();
                    if (token !== this.revision) return true;
                    const decision = await this.engine.decide(prompt, { scene: !!scene, settings, episode: ep });
                    stage = '校验当前聊天状态';
                    if (!this.valid(token, snapshot)) return true;
                    ep.failures = 0; ep.error = null;
                    stage = '记录决策与调度';
                    const record = remember(ep, decision, this.clock.now(), this.settings().saveMemory);
                    record.interaction_mode = scene ? 'scene' : 'chat';
                    if (isDual(ep)) record.phase = ep.phase;
                    if (decision.action === 'STOP') {
                        record.outcome = 'STOPPED'; this.finish('ENDED', '用户明确要求停止主动跟进'); await this.closeReceipt();
                    } else if (scene) {
                        stage = '提交场景与对白'; await executeScene(this, decision, record, snapshot, token);
                    } else if (decision.action === 'END') {
                        record.outcome = 'ENDED'; this.endCurrentPhase('角色选择结束本轮互动');
                        this.writeReceipt(snapshot, { sentCount: ep.sentCount, nextAt: 0, closed: true });
                    } else if (decision.action === 'WAIT') {
                        ep.silentWaitCount = (ep.silentWaitCount ?? 0) + 1;
                        this.defer(this.clock.now() + waitDuration(this.settings(), decision.next_check_minutes, ep), this.currentTiming().busy === 1000 ? '快节奏：已将角色等待压缩为秒级' : '角色选择等待');
                        record.outcome = 'WAITING'; record.scheduled_minutes = (ep.dueAt - this.clock.now()) / MINUTE;
                        this.writeReceipt(snapshot, { sentCount: ep.sentCount, nextAt: ep.dueAt, closed: false });
                    } else { stage = '提交主动消息'; await this.send(decision, record, snapshot, token); }
                } finally { this.clock.clearTimeout(watchdog); }
                return true;
            });
            if (!acquired && this.episode() === ep && ep.status === 'WAITING') this.defer(this.clock.now() + this.currentTiming().busy, '其他标签页正在决策');
        } catch (error) {
            if (token === this.revision && this.episode() === ep && ACTIVE.has(ep.status)) {
                ep.failures++;
                // 不保存服务端原始错误或模型原文，防止密钥/私人内容进入日志。
                ep.error = `决策失败（第 ${ep.failures} 次）。${describeFailure(error, stage)}`;
                if (settings.debug) console.warn('[Xiaoqing]', ep.error);
                if (ep.failures > settings.maxRetries) this.pause('有限重试已用尽，请手动恢复');
                else this.defer(this.clock.now() + this.currentTiming().interval, '决策失败，等待有限重试');
            }
        } finally {
            this.inFlight = false;
            // 未经事件通知的上下文变更也必须从 CHECKING 状态退出。
            if (this.episode() === ep && ep.status === 'CHECKING') {
                this.defer(this.clock.now() + this.currentTiming().interval, '过期决策已丢弃');
            }
            await this.persist(); this.schedule(); this.changed();
        }
    }
    async send(decision, record, snapshot, token) {
        const ep = this.episode(), now = this.clock.now(), settings = this.settings();
        const lastContact = this.contactTime(snapshot);
        const quiet = quietUntil(settings, now);
        if (!settings.allowSend || quiet || now - lastContact < this.currentTiming().contact || phaseSentCount(ep) >= settings.maxMessages) {
            record.outcome = 'BLOCKED_BY_POLICY';
            if (!settings.allowSend || phaseSentCount(ep) >= settings.maxMessages) this.finish('ENDED', '主动发送权限未开启或次数已达上限');
            else this.defer(Math.max(quiet || 0, lastContact + this.currentTiming().contact), '免打扰或联系频率限制');
            return;
        }
        const sent = await this.adapter.append(snapshot, decision.message,
            { episode_id: ep.id, decision_id: record.id, sent_at: now },
            () => this.valid(token, snapshot) && this.settings().allowSend && !quietUntil(this.settings(), this.clock.now()),
            () => {
                // 在消息插入前记录发送，刷新、保存失败或事件异常均不会自动重发。
                this.countOutput(); this.countSpeech(snapshot, now); record.outcome = 'SENT';
                ep.silentWaitCount = 0;
                if (this.enforceOutputLimit()) { /* 已结束整轮或转入阶段间等待。 */ }
                else this.defer(now + this.currentTiming().interval, '已主动联系，稍后由角色重新判断');
                this.writeReceipt(snapshot, { sentCount: ep.sentCount, nextAt: ep.dueAt, closed: ep.status === 'ENDED' }, now);
                this.storage.write(this.state);
            });
        if (!sent && ep.status === 'CHECKING') {
            record.outcome = 'DISCARDED'; this.defer(now + this.currentTiming().interval, '提交前状态变化，丢弃消息');
        }
    }
    shutdown() { this.stopped = true; this.invalidate(); this.changed(); }
}
