import { STAdapter } from './modules/st-adapter.js';
import { Storage } from './modules/storage.js';
import { DecisionEngine } from './modules/decision-engine.js';
import { BrowserCoordinator } from './modules/coordination.js';
import { Agent } from './modules/agent.js';
import { listen } from './modules/event-listener.js';
import { mountSettings } from './ui/settings.js';
import { ConversationBuffer, listenForDraft } from './modules/conversation-buffer.js';

let agent, panel, unlisten, unlistenDraft, readyHandler, lifecycle = 0;
const getContext = () => globalThis.SillyTavern.getContext();
const REQUIRED = ['generateRaw', 'getCharacterCardFields', 'unshallowCharacter', 'saveMetadata',
    'saveChat', 'saveSettingsDebounced', 'addOneMessage', 'timestampToMoment'];

export function activate() {
    if (readyHandler || agent) return;
    const generation = ++lifecycle;
    const ctx = getContext();
    globalThis.xiaoqingAgentInterceptGeneration = interceptGeneration;
    readyHandler = () => {
        setTimeout(() => {
            if (generation !== lifecycle) return;
            initialize(generation).catch(() => {
                agent?.shutdown();
                agent?.buffer?.shutdown(); unlistenDraft?.();
                unlisten?.(); panel?.destroy();
                console.error('[Xiaoqing] 初始化失败，请确认 SillyTavern 版本与插件文件完整性。');
                globalThis.toastr?.error('小晴初始化失败，请确认 SillyTavern ≥ 1.19.0，详见控制台。');
            });
        }, 0);
    };
    ctx.eventSource.on(ctx.eventTypes.APP_READY, readyHandler);
}

async function initialize(generation) {
    const ctx = getContext();
    for (const name of REQUIRED) if (typeof ctx[name] !== 'function') throw new Error(`缺少接口 ${name}`);
    const adapter = new STAdapter(getContext);
    agent = new Agent({ adapter, storage: new Storage(getContext), engine: new DecisionEngine(adapter),
        coordinator: new BrowserCoordinator(), onChange: () => panel?.render() });
    agent.buffer = new ConversationBuffer(agent);
    unlistenDraft = listenForDraft(agent.buffer);
    unlisten = listen(getContext, agent);
    const mounted = await mountSettings(agent);
    if (generation !== lifecycle) { mounted.destroy(); return; }
    panel = mounted;
    await agent.load();
}

export function disable() {
    lifecycle++;
    agent?.buffer?.shutdown(); agent?.shutdown(); unlisten?.(); unlistenDraft?.(); panel?.destroy();
    if (globalThis.xiaoqingAgentInterceptGeneration === interceptGeneration) delete globalThis.xiaoqingAgentInterceptGeneration;
    if (readyHandler) {
        const ctx = getContext(); ctx.eventSource.removeListener(ctx.eventTypes.APP_READY, readyHandler);
    }
    readyHandler = null; agent = null; panel = null; unlisten = null; unlistenDraft = null;
}

export function interceptGeneration(chat, contextSize, abort, type) {
    return agent?.buffer?.intercept(chat, contextSize, abort, type);
}
