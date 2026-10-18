import { fingerprint } from './context-builder.js';

// Web Locks 跨标签互斥；小型 localStorage 收据跨刷新去重，不保存聊天或模型文本。
export class BrowserCoordinator {
    constructor(locks = globalThis.navigator?.locks, storage = globalThis.localStorage) {
        this.locks = locks; this.storage = storage;
    }
    async exclusive(_key, task) {
        if (!this.locks?.request || !this.storage) throw new Error('自动行为需要 Web Locks 和本地存储，请使用 localhost 或 HTTPS');
        // 当前模型配置在各聊天间共享；同源所有小晴标签页共用一把生成锁。
        return this.locks.request('xiaoqing:model', { ifAvailable: true }, lock => lock ? task() : false);
    }
    receiptKey(snapshot) { return `xiaoqing.receipt:${fingerprint(snapshot.phaseKey ? [snapshot.key, snapshot.userMarker, snapshot.phaseKey] : [snapshot.key, snapshot.userMarker])}`; }
    read(snapshot) {
        const value = this.storage.getItem(this.receiptKey(snapshot));
        if (!value) return { sentCount: 0, nextAt: 0, closed: false };
        const receipt = JSON.parse(value);
        if (!receipt || typeof receipt !== 'object' || !Number.isFinite(receipt.sentCount) || !Number.isFinite(receipt.nextAt)
            || (receipt.narrationCount !== undefined && (!Number.isSafeInteger(receipt.narrationCount) || receipt.narrationCount < 0))
            || ['outputCount', 'totalOutputCount', 'requestCount'].some(key => receipt[key] !== undefined && (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0))) {
            throw new Error('去重收据损坏，已停止任务');
        }
        return receipt;
    }
    write(snapshot, receipt, now) {
        const old = this.read(snapshot);
        receipt = { ...receipt };
        for (const key of ['sentCount', 'narrationCount', 'outputCount', 'totalOutputCount', 'requestCount']) {
            if (old[key] !== undefined) receipt[key] = Math.max(receipt[key] ?? 0, old[key]);
        }
        this.storage.setItem(this.receiptKey(snapshot), JSON.stringify({ ...receipt, updatedAt: now }));
        // 仅清理本扩展过期收据；超过最长任务寿命才允许删除。
        for (let i = this.storage.length - 1; i >= 0; i--) {
            const key = this.storage.key(i);
            if (!key?.startsWith('xiaoqing.receipt:')) continue;
            try {
                const value = JSON.parse(this.storage.getItem(key));
                if (now - value.updatedAt > 30 * 86400_000) this.storage.removeItem(key);
            } catch { /* 损坏收据保留，避免绕过去重。 */ }
        }
    }
    lastContact(characterKey) { return Number(this.storage.getItem(`xiaoqing.contact:${fingerprint(characterKey)}`)) || 0; }
    contact(characterKey, now) { this.storage.setItem(`xiaoqing.contact:${fingerprint(characterKey)}`, String(now)); }
    lastSlowContact(characterKey) { return Number(this.storage.getItem(`xiaoqing.slow-contact:${fingerprint(characterKey)}`)) || 0; }
    slowContact(characterKey, now) { this.storage.setItem(`xiaoqing.slow-contact:${fingerprint(characterKey)}`, String(now)); }
    timePauseKey(snapshot) { return `xiaoqing.time-pause:${fingerprint(snapshot.key)}`; }
    readTimePause(snapshot) {
        const raw = this.storage.getItem(this.timePauseKey(snapshot));
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value.held !== 'boolean' || !Number.isFinite(value.total) || value.total < 0
            || !Number.isFinite(value.changedAt) || typeof value.revision !== 'string'
            || value.held && (!Number.isFinite(value.since) || value.since < 0)) {
            throw new Error('时间暂停标记损坏，请检查本地存储');
        }
        return value;
    }
    async setTimePause(snapshot, held, now, since = now) {
        if (!this.locks?.request || !this.storage) throw new Error('时间暂停同步需要 Web Locks 和本地存储');
        return this.locks.request(this.timePauseKey(snapshot), { mode: 'exclusive' }, lock => {
            if (!lock) throw new Error('时间暂停操作正在其他标签页进行');
            const old = this.readTimePause(snapshot);
            if (old && old.held === held) return old;
            const total = old?.total ?? 0;
            const value = { held, since: held ? Math.min(now, since) : null,
                total: total + (old?.held && !held ? Math.max(0, now - old.since) : 0),
                changedAt: now, revision: globalThis.crypto.randomUUID() };
            this.storage.setItem(this.timePauseKey(snapshot), JSON.stringify(value)); return value;
        });
    }
    bufferKey(snapshot) { return `xiaoqing.buffer:${fingerprint([snapshot.key, snapshot.userMarker])}`; }
    readBuffer(snapshot) {
        const text = this.storage.getItem(this.bufferKey(snapshot));
        if (!text) return { checks: 0, nextAt: 0, done: false };
        const value = JSON.parse(text);
        if (!value || !Number.isFinite(value.checks) || !Number.isFinite(value.nextAt)) throw new Error('接话收据损坏');
        return value;
    }
    writeBuffer(snapshot, value, now) {
        this.storage.setItem(this.bufferKey(snapshot), JSON.stringify({ ...value, updatedAt: now }));
        for (let i = this.storage.length - 1; i >= 0; i--) {
            const key = this.storage.key(i);
            if (!key?.startsWith('xiaoqing.buffer:')) continue;
            try {
                const old = JSON.parse(this.storage.getItem(key));
                if (now - old.updatedAt > 30 * 86400_000) this.storage.removeItem(key);
            } catch { /* 保留损坏的标记，拒绝绕过去重。 */ }
        }
    }
}
