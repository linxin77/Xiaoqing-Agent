import { KEY, normalizeSettings } from './settings.js';
import { identity } from './context-builder.js';
import { normalizeScene } from './scene.js';

export class Storage {
    constructor(getContext) { this.getContext = getContext; }
    settings() {
        const ctx = this.getContext();
        const value = normalizeSettings(ctx.extensionSettings[KEY]);
        ctx.extensionSettings[KEY] = value;
        return value;
    }
    saveSettings(settings) {
        const ctx = this.getContext();
        ctx.extensionSettings[KEY] = normalizeSettings(settings);
        ctx.saveSettingsDebounced();
    }
    load(snapshot) {
        const value = this.getContext().chatMetadata[KEY];
        if (value?.version === 1 && value.owner === snapshot.key && Array.isArray(value.archives)) {
            const state = structuredClone(value);
            state.scene = normalizeScene(state.scene);
            if (!Number.isFinite(state.hold?.since) || state.hold.since < 0) state.hold = null;
            if (!Array.isArray(state.bufferHistory)) state.bufferHistory = [];
            const ep = state.episode;
            if (ep && (!Array.isArray(ep.history) || !Number.isFinite(ep.startAt)
                || !Number.isFinite(ep.deadlineAt) || !Number.isFinite(ep.dueAt)
                || !Number.isFinite(ep.sentCount) || !Number.isFinite(ep.decisionCount)
                || !ep.summary?.actions)) return this.empty(snapshot);
            if (ep) ep.narrationCount = Number.isSafeInteger(ep.narrationCount) && ep.narrationCount >= 0 ? ep.narrationCount : 0;
            if (ep) {
                if (!Number.isSafeInteger(ep.requestCount) || ep.requestCount < 0) ep.requestCount = Math.max(0, ep.decisionCount + (ep.failures ?? 0));
                if (!Number.isSafeInteger(ep.silentWaitCount) || ep.silentWaitCount < 0) ep.silentWaitCount = 0;
            }
            if (ep && (!Number.isSafeInteger(ep.outputCount) || ep.outputCount < 0)) ep.outputCount = Math.max(ep.sentCount, ep.narrationCount);
            if (ep?.dualPhase) {
                if (!['fast', 'between', 'slow'].includes(ep.phase)) return this.empty(snapshot);
                for (const key of ['slowSentCount', 'slowNarrationCount', 'fastSentCount', 'fastNarrationCount', 'fastOutputCount', 'slowOutputCount']) {
                    if (!Number.isSafeInteger(ep[key]) || ep[key] < 0) ep[key] = 0;
                }
                if (ep.fastEndedAt != null && !Number.isFinite(ep.fastEndedAt)) delete ep.fastEndedAt;
            }
            return state;
        }
        return this.empty(snapshot);
    }
    empty(snapshot) { return { version: 1, owner: snapshot.key, episode: null, archives: [], bufferHistory: [], lastSentAt: 0, scene: normalizeScene(), hold: null }; }
    write(state) {
        const ctx = this.getContext();
        if (identity(ctx)?.key !== state.owner) return false;
        ctx.chatMetadata[KEY] = structuredClone(state);
        return true;
    }
    async save(state) {
        if (!this.write(state)) return;
        await this.getContext().saveMetadata();
    }
}
