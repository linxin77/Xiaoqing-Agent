export const KEY = 'xiaoqing_agent';
export const MINUTE = 60_000;
export const DEFAULTS = Object.freeze({
    enabled: false, allowSend: false, paused: false,
    firstCheckMinutes: 5, maxWaitMinutes: 180, minCheckMinutes: 5,
    recentMessages: 20, saveMemory: true, debug: false,
    maxMessages: 5, contactGapMinutes: 30, maxRetries: 2, timeoutSeconds: 90,
    dndEnabled: false, dndStart: '23:00', dndEnd: '08:00', characters: {},
    bufferEnabled: true, bufferSeconds: 5,
    fastTestEnabled: true, fastTestSeconds: 10,
    dualPhaseEnabled: true, slowStartMinutes: 5, fastPhaseMaxMinutes: 5,
    adaptiveWaitEnabled: true, fastWaitMaxSeconds: 60, quietWaitMaxMinutes: 60, quietWaitFactor: 2,
    maxDecisionCalls: 30,
});

const bounds = {
    firstCheckMinutes: [1, 1440], maxWaitMinutes: [1, 10080], minCheckMinutes: [1, 1440],
    recentMessages: [1, 100], maxMessages: [1, 100], contactGapMinutes: [1, 1440],
    maxRetries: [0, 2], timeoutSeconds: [10, 300],
    bufferSeconds: [2, 60],
    fastTestSeconds: [1, 3600],
    slowStartMinutes: [1, 1440], fastPhaseMaxMinutes: [1, 60],
    fastWaitMaxSeconds: [1, 3600], quietWaitMaxMinutes: [1, 1440], quietWaitFactor: [1, 4], maxDecisionCalls: [1, 1000],
};

export function normalizeSettings(input = {}) {
    const out = structuredClone(DEFAULTS);
    for (const key of ['enabled', 'allowSend', 'paused', 'saveMemory', 'debug', 'dndEnabled', 'bufferEnabled', 'fastTestEnabled', 'dualPhaseEnabled', 'adaptiveWaitEnabled']) {
        if (typeof input[key] === 'boolean') out[key] = input[key];
    }
    for (const [key, [min, max]] of Object.entries(bounds)) {
        const n = Number(input[key]);
        if (Number.isFinite(n)) out[key] = Math.min(max, Math.max(min, Math.round(n)));
    }
    for (const key of ['dndStart', 'dndEnd']) {
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(input[key])) out[key] = input[key];
    }
    if (input.characters && typeof input.characters === 'object' && !Array.isArray(input.characters)) {
        out.characters = Object.fromEntries(Object.entries(input.characters).map(([key, value]) => [key, {
            enabled: value?.enabled !== false,
            lastSentAt: Number.isFinite(value?.lastSentAt) ? value.lastSentAt : 0,
            lastSlowSentAt: Number.isFinite(value?.lastSlowSentAt) ? value.lastSlowSentAt : 0,
        }]));
    }
    return out;
}

export function isEnabled(settings, characterKey) {
    return settings.enabled && !settings.paused && settings.characters[characterKey]?.enabled !== false;
}

export function quietUntil(settings, now) {
    if (!settings.dndEnabled) return null;
    const toMinutes = value => value.split(':').map(Number).reduce((h, m) => h * 60 + m);
    const start = toMinutes(settings.dndStart), end = toMinutes(settings.dndEnd);
    const date = new Date(now), current = date.getHours() * 60 + date.getMinutes();
    const quiet = start === end || (start < end ? current >= start && current < end : current >= start || current < end);
    if (!quiet) return null;
    const next = new Date(now);
    next.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (next.getTime() <= now || start === end) next.setDate(next.getDate() + 1);
    return next.getTime();
}
