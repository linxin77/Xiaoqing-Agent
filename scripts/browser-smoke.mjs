// 可选浏览器集成测试。Playwright 只用于开发，不是扩展的运行依赖。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(process.env.XQ_MODULE_ROOT ? path.join(process.env.XQ_MODULE_ROOT, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const server = createServer(async (req, res) => {
    try {
        if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
        const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain');
        res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1400 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log('浏览器：', message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/browser.html`);
    await page.locator('#xiaoqing-agent-settings').waitFor();
    assert.equal(await page.locator('[data-setting="enabled"]').isChecked(), false);
    assert.equal(await page.locator('[data-setting="allowSend"]').isChecked(), false);
    assert.equal(await page.locator('[data-setting="fastTestEnabled"]').isChecked(), true);
    assert.equal(await page.locator('[data-setting="adaptiveWaitEnabled"]').isChecked(), true);
    await page.locator('[data-setting="adaptiveWaitEnabled"]').uncheck(); // 既有固定节奏回归；自然等待有独立计时测试。
    assert.equal(await page.locator('[data-setting="dualPhaseEnabled"]').isChecked(), true);
    assert.equal(await page.locator('[data-setting="fastTestEnabled"]').isDisabled(), true);
    // 先关闭快测运行原分钟模式回归，最后单独验证真实秒级定时。
    await page.locator('[data-setting="dualPhaseEnabled"]').uncheck();
    await page.locator('[data-setting="fastTestEnabled"]').uncheck();
    await page.locator('[data-setting="maxMessages"]').fill('1');
    await page.locator('[data-setting="maxMessages"]').dispatchEvent('change');
    await page.locator('[data-setting="enabled"]').check();
    await page.locator('[data-setting="allowSend"]').check();
    assert.equal(await page.locator('[data-setting="bufferEnabled"]').isChecked(), true);
    await page.locator('[data-setting="bufferSeconds"]').fill('2');
    await page.locator('[data-setting="bufferSeconds"]').dispatchEvent('change');
    await page.evaluate(async () => {
        window.testOutputs.push({ action: 'REPLY', message: '他把你的文件删了？有没有备份能找回来？', next_check_seconds: null, thought: '等他说完后一起回复。', pending_intention: null });
        await window.testSend('我跟你说');
        await window.testSend('那个同学把我文件删了');
    });
    assert.equal(await page.evaluate(() => window.modelCalls.length), 0);
    assert.equal(await page.evaluate(() => window.normalGenerations), 0);
    await page.waitForFunction(() => window.testContext.chat.length === 3, null, { timeout: 7000 });
    assert.equal(await page.evaluate(() => window.modelCalls.length), 1);
    assert.equal(await page.evaluate(() => window.modelCalls[0].jsonSchema.name), 'xiaoqing_buffer_decision');
    assert.match(await page.evaluate(() => window.modelCalls[0].prompt), /我跟你说\\n那个同学把我文件删了/);
    assert.equal(await page.evaluate(() => window.testContext.chat.at(-1).extra.xiaoqing_agent.kind), 'buffered_reply');
    await page.screenshot({ path: path.join(root, 'docs', 'settings-preview.png'), fullPage: true });
    // 关闭秒级缓冲后，再独立验证分钟级 WAIT/SEND。
    await page.locator('[data-setting="bufferEnabled"]').uncheck();
    await page.evaluate(async () => {
        window.testOutputs.push({ action: 'WAIT', message: null, next_check_minutes: 10, thought: '故事说到一半，先等等他。', pending_intention: '想知道后续。' });
        await window.testSend('今天班里发生一件离谱的事，那个同学他居然……');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent?.episode?.status === 'WAITING');
    await page.evaluate(() => window.testWake());
    try { await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.length === 1, null, { timeout: 5000 }); }
    catch (error) { console.log(await page.evaluate(() => ({ episode: window.testContext.chatMetadata.xiaoqing_agent.episode, status: document.querySelector('#xq-status').textContent, calls: window.modelCalls.length, locks: !!navigator.locks }))); throw error; }
    assert.equal(await page.evaluate(() => window.modelCalls.length), 2);
    assert.equal(await page.evaluate(() => window.modelCalls[1].jsonSchema.name), 'xiaoqing_proactive_decision');
    assert.equal(await page.evaluate(() => window.testContext.chat.length), 5);
    assert.equal(await page.evaluate(() => window.normalGenerations), 1);
    const dueBeforeUpdate = await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.dueAt);
    await page.evaluate(() => window.testContext.eventSource.emit('MESSAGE_UPDATED', 4));
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status), 'WAITING');
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.dueAt), dueBeforeUpdate);
    // 去重收据的间隔同样加速，不等待真实十分钟；仅测试夹具允许这样做。
    await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('xiaoqing.receipt:')) continue;
            const value = JSON.parse(localStorage.getItem(key)); value.nextAt = 0; localStorage.setItem(key, JSON.stringify(value));
        }
        window.testOutputs.push({ action: 'SEND_MESSAGE', message: '喂，你刚才的话还没说完呢。', next_check_minutes: null, thought: '还是很好奇后续。', pending_intention: null });
        window.testContext.chatMetadata.xiaoqing_agent.episode.status = 'CANCELED';
        window.testContext.chatMetadata.xiaoqing_agent.episode.reason = '聊天或角色资料被编辑、删除或切换候选回复';
        await window.testWake();
    });
    await page.waitForFunction(() => window.testContext.chat.length === 6);
    assert.equal(await page.locator('#chat .msg').count(), 6);
    assert.equal(await page.evaluate(() => window.savedChats.at(-1).chat.at(-1).extra.xiaoqing_agent != null), true);
    // 仅注入模拟错误：验证用户能看出是输出解析失败，且原文不会进入面板/聊天/元数据。
    await page.evaluate(async () => {
        window.testOutputs.push('private-invalid-model-output');
        await window.testSend('我接着讲刚才的事');
        await window.testWake();
    });
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('NON_JSON_OUTPUT'));
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status), 'WAITING');
    assert.equal(await page.evaluate(() => JSON.stringify(window.testContext.chatMetadata).includes('private-invalid-model-output')), false);
    assert.equal(await page.locator('#xq-status').textContent().then(text => text.includes('private-invalid-model-output')), false);
    await page.screenshot({ path: path.join(root, 'docs', 'diagnostics-preview.png'), fullPage: true });
    await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('xiaoqing.receipt:')) continue;
            const value = JSON.parse(localStorage.getItem(key)); value.nextAt = 0; localStorage.setItem(key, JSON.stringify(value));
        }
        window.testOutputs.push({ action: 'WAIT', message: null, next_check_minutes: 5, thought: '先留些时间。', pending_intention: null });
        await window.testWake();
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.length === 1);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.error), null);
    // 独立场景聊天，全部仍是本页模拟 Context；不接触真实酒馆或 API。
    await page.evaluate(async () => {
        const ctx = window.testContext;
        ctx.characters[0] = { name: '团团', avatar: 'scene-smoke.png', description: '面包店店员，亲切而忙碌。',
            scenario: '顾客在柜台挑选面包，团团有些货架标签还没贴。', data: { description: '完整测试角色卡' } };
        ctx.chatId = 'scene-smoke'; ctx.chat = []; ctx.chatMetadata = {};
        document.querySelector('#chat').replaceChildren();
        await ctx.eventSource.emit('CHAT_CHANGED');
    });
    await page.waitForFunction(() => document.querySelector('#xq-interaction-mode').value === 'chat');
    await page.locator('#xq-interaction-mode').selectOption('scene');
    await page.locator('[data-setting="maxMessages"]').fill('3');
    await page.locator('[data-setting="maxMessages"]').dispatchEvent('change');
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent?.scene.mode === 'scene');
    assert.equal(await page.locator('#xq-scene-hint').isVisible(), true);
    await page.evaluate(async () => {
        window.testOutputs.push({ action: 'WAIT', message: null, next_check_minutes: 8,
            thought: '先忙手头的事。', pending_intention: '等顾客接着说。', narration: '团团转身来到货架旁，继续贴剩下的价签。' });
        await window.testSend('我再看看'); await window.testWake();
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.narrationCount === 1);
    assert.match(await page.locator('#chat').textContent(), /团团转身来到货架旁/);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status), 'WAITING');
    assert.equal(await page.evaluate(() => window.modelCalls.at(-1).jsonSchema.name), 'xiaoqing_scene_decision');
    assert.equal(await page.evaluate(() => window.modelCalls.at(-1).jsonSchema.value.required.length), 6);
    const sceneCalls = await page.evaluate(() => window.modelCalls.length);
    await page.locator('#xq-chat-hold').click();
    await page.waitForFunction(() => !!window.testContext.chatMetadata.xiaoqing_agent.hold);
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('时间已暂停'));
    assert.match(await page.locator('#xq-chat-hold').textContent(), /继续/);
    const frozenStatus = await page.locator('#xq-status').textContent();
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => window.modelCalls.length), sceneCalls);
    assert.equal(await page.locator('#xq-status').textContent(), frozenStatus);
    await page.locator('#xq-chat-hold').click();
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.hold === null);
    await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('xiaoqing.receipt:')) continue;
            const value = JSON.parse(localStorage.getItem(key)); value.nextAt = 0; localStorage.setItem(key, JSON.stringify(value));
        }
        window.testOutputs.push({ action: 'SEND_MESSAGE', message: '你慢慢选，我先把这边贴完。', next_check_minutes: null,
            thought: '给顾客留些时间。', pending_intention: null, narration: '团团贴好一张标签，又拿起下一张。' });
        await window.testWake();
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.narrationCount === 2);
    const lastScene = await page.evaluate(() => window.testContext.chat.at(-1));
    assert.match(lastScene.mes, /贴好一张标签/); assert.match(lastScene.mes, /你慢慢选/);
    assert.equal(lastScene.extra.xiaoqing_agent.scene.has_dialogue, true);
    assert.match(await page.evaluate(() => window.modelCalls.at(-1).prompt), /团团转身来到货架旁/);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status), 'WAITING');
    // 空旁白是安静 WAIT；不能把辅助独白当动作，不能消耗输出额度。
    const beforeMissingNarration = await page.evaluate(() => window.testContext.chat.length);
    await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('xiaoqing.receipt:')) continue;
            const value = JSON.parse(localStorage.getItem(key)); value.nextAt = 0; localStorage.setItem(key, JSON.stringify(value));
        }
        window.testOutputs.push({ action: 'WAIT', narration: null, message: null, next_check_minutes: 5,
            thought: 'PRIVATE_SCENE_MONOLOGUE：标签贴歪了，我在心里盘算着明天的事情。'.repeat(7), pending_intention: null });
        await window.testWake();
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.length === 3);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.error), null);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.outputCount), 2);
    assert.equal(await page.evaluate(() => window.testContext.chat.length), beforeMissingNarration);
    assert.equal(await page.evaluate(() => JSON.stringify(window.testContext.chatMetadata).includes('PRIVATE_SCENE_MONOLOGUE')), false);
    assert.doesNotMatch(await page.locator('#xq-status').textContent(), /PRIVATE_SCENE_MONOLOGUE/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, 'docs', 'scene-diagnostics-preview.png'), fullPage: true });
    await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('xiaoqing.receipt:')) continue;
            const value = JSON.parse(localStorage.getItem(key)); value.nextAt = 0; localStorage.setItem(key, JSON.stringify(value));
        }
        window.testOutputs.push({ action: 'WAIT', narration: '团团揭下贴歪的价签，将它重新对齐贴好。', message: null,
            next_check_minutes: 5, thought: 'PRIVATE_LONG_AUXILIARY'.repeat(100), pending_intention: null });
        await window.testWake();
    });
    await page.waitForFunction(() => {
        const ep = window.testContext.chatMetadata.xiaoqing_agent.episode;
        return ep.narrationCount === 3 && ep.history.at(-1).scene_outcome === 'DISPLAYED' && ep.error === null;
    });
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('已写入聊天并完成渲染流程'));
    assert.match(await page.locator('#chat').textContent(), /重新对齐贴好/);
    assert.equal(await page.evaluate(() => JSON.stringify(window.testContext.chatMetadata).includes('PRIVATE_LONG_AUXILIARY')), false);
    assert.match(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.at(-1).thought), /摘要过长，已省略/);
    assert.equal(await page.evaluate(() => window.modelCalls.at(-1).jsonSchema.value.properties.narration.type), 'string');
    assert.equal(await page.evaluate(() => window.modelCalls.at(-1).jsonSchema.value.properties.thought.maxLength), 120);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, 'docs', 'scene-preview.png'), fullPage: true });
    // 新测试聊天，避免复用上面角色的联系时间。此段不使用 testWake 加速，实际等秒级计时。
    await page.evaluate(async () => {
        const ctx = window.testContext;
        ctx.characters[0] = { name: '快测角色', avatar: 'fast-smoke.png', description: '敏捷好奇的店员。',
            scenario: '角色在柜台整理标签。', data: { description: '固定测试卡' } };
        ctx.chatId = 'fast-smoke'; ctx.chat = []; ctx.chatMetadata = {};
        document.querySelector('#chat').replaceChildren(); await ctx.eventSource.emit('CHAT_CHANGED');
    });
    await page.waitForFunction(() => document.querySelector('#xq-interaction-mode').value === 'chat');
    await page.locator('[data-setting="fastTestEnabled"]').check();
    await page.locator('[data-setting="maxMessages"]').fill('1');
    await page.locator('[data-setting="maxMessages"]').dispatchEvent('change');
    await page.locator('[data-setting="fastTestSeconds"]').fill('3');
    await page.locator('[data-setting="fastTestSeconds"]').dispatchEvent('change');
    assert.equal(await page.locator('[data-setting="firstCheckMinutes"]').isDisabled(), true);
    const fastCalls = await page.evaluate(() => window.modelCalls.length);
    await page.evaluate(async () => {
        window.testOutputs.push({ action: 'WAIT', message: null, next_check_minutes: 120, thought: '想等一会再问。', pending_intention: null },
            { action: 'SEND_MESSAGE', message: '你刚才说的事，后来呢？', next_check_minutes: null, thought: '好奇后续。', pending_intention: null });
        await window.testSend('我还有件事想说');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent?.episode?.sentCount === 1, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.modelCalls.length), fastCalls + 2);
    assert.match(await page.locator('#chat').textContent(), /后来呢/);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history[0].scheduled_minutes), 3 / 60);
    assert.match(await page.evaluate(() => window.modelCalls.at(-1).systemPrompt), /快速测试/);
    await page.locator('#xq-interaction-mode').selectOption('scene');
    await page.locator('[data-setting="maxMessages"]').fill('3');
    await page.locator('[data-setting="maxMessages"]').dispatchEvent('change');
    await page.evaluate(async () => {
        window.testOutputs.push({ action: 'WAIT', narration: '店员转身整理手边的标签。', message: null,
            next_check_minutes: 60, thought: '先忙手头事务。', pending_intention: null },
        { action: 'END', narration: '店员把最后一张标签贴好。', message: null, next_check_minutes: null, thought: '暂时告一段落。', pending_intention: null });
        await window.testSend('我先挑一下');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.narrationCount === 1, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history[0].scheduled_minutes), 3 / 60);
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status === 'ENDED', null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.narrationCount), 2);
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('快速测试'));
    assert.match(await page.locator('#chat').textContent(), /最后一张标签/);
    await page.screenshot({ path: path.join(root, 'docs', 'fast-test-preview.png'), fullPage: true });
    await page.locator('[data-setting="fastTestEnabled"]').uncheck();
    assert.equal(await page.locator('[data-setting="firstCheckMinutes"]').isDisabled(), false);
    assert.equal(await page.locator('[data-setting="firstCheckMinutes"]').inputValue(), '5');
    // 双阶段夹具：快二条后自主 END，慢阶段最多再一条。只在此模拟页移动任务时间，不访问实际酒馆。
    await page.evaluate(async () => {
        const ctx = window.testContext;
        ctx.characters[0] = { name: '团团', avatar: 'dual-smoke.png', description: '忙碌的面包店员。',
            scenario: '团团在柜台后贴标签，玩家在店内。', data: { description: '固定双阶段测试卡' } };
        ctx.chatId = 'dual-smoke'; ctx.chat = []; ctx.chatMetadata = {};
        document.querySelector('#chat').replaceChildren(); await ctx.eventSource.emit('CHAT_CHANGED');
    });
    await page.locator('[data-setting="dualPhaseEnabled"]').check();
    await page.locator('#xq-interaction-mode').selectOption('scene');
    assert.equal(await page.locator('[data-setting="minCheckMinutes"]').isDisabled(), false);
    assert.equal(await page.locator('[data-setting="contactGapMinutes"]').isDisabled(), false);
    const dualCalls = await page.evaluate(() => window.modelCalls.length);
    await page.evaluate(async () => {
        window.testOutputs.push(...['团团贴好货架上的价签。', '她收好标签，走回柜台边。'].map(narration => ({
            action: 'WAIT', narration, message: null, next_check_minutes: 5, thought: '继续手头事务。', pending_intention: null,
        })), { action: 'END', narration: '', message: null, next_check_minutes: null, thought: '暂时没有新内容，自主收尾。', pending_intention: null });
        await window.testSend('我再想想');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent?.episode?.phase === 'between', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.outputCount), 2);
    assert.equal(await page.evaluate(() => window.modelCalls.length), dualCalls + 3);
    const betweenCount = await page.evaluate(() => window.testContext.chat.length);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.modelCalls.length), dualCalls + 3);
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('整轮主动消息：2 / 3'));
    await page.screenshot({ path: path.join(root, 'docs', 'dual-phase-preview.png'), fullPage: true });
    await page.evaluate(async () => {
        const ep = window.testContext.chatMetadata.xiaoqing_agent.episode;
        ep.startAt -= 5 * 60_000; ep.fastEndedAt -= 5 * 60_000; ep.fastDeadlineAt -= 5 * 60_000;
        ep.slowEligibleAt = Date.now() - 1; ep.dueAt = Date.now() - 1;
        window.testOutputs.push({ action: 'SEND_MESSAGE', narration: '团团在柜台边摆好一盘新面包。',
            message: '刚烤好的，你想尝一小块吗？', next_check_minutes: null, thought: '自然开启新话题。', pending_intention: null });
        await window.testContext.eventSource.emit('CHAT_CHANGED');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status === 'ENDED');
    assert.equal(await page.evaluate(() => window.testContext.chat.length), betweenCount + 1);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.outputCount), 3);
    assert.equal(await page.evaluate(() => window.modelCalls.length), dualCalls + 4);
    const slowContext = JSON.parse(await page.evaluate(() => window.modelCalls.at(-1).prompt.split('\n')[1]));
    assert.equal(slowContext.interaction_phase.name, 'slow');
    assert.equal(slowContext.environment.fast_test, undefined);
    assert.ok(slowContext.environment.silence_minutes >= 5);
    assert.match(JSON.stringify(slowContext.scene.committed_updates), /走回柜台边/);
    assert.equal(slowContext.permissions.remaining_outputs, 1);
    assert.equal(await page.evaluate(() => window.modelCalls.at(-1).jsonSchema.value.properties.action.enum.includes('STOP')), true);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.modelCalls.length), dualCalls + 4);
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('整轮主动消息：3 / 3'));
    await page.screenshot({ path: path.join(root, 'docs', 'output-limit-preview.png'), fullPage: true });
    // 两个真实标签页共享同源 localStorage，验证 storage 事件同步暂停/继续。
    const peer = await page.context().newPage();
    peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/browser.html`);
    await peer.locator('#xiaoqing-agent-settings').waitFor();
    const sharedScene = await page.evaluate(() => ({
        characters: window.testContext.characters, chatId: window.testContext.chatId,
        chat: window.testContext.chat, chatMetadata: window.testContext.chatMetadata,
        extensionSettings: window.testContext.extensionSettings,
    }));
    await peer.evaluate(async data => { Object.assign(window.testContext, data); await window.testContext.eventSource.emit('CHAT_CHANGED'); }, sharedScene);
    await peer.waitForFunction(() => !document.querySelector('#xq-chat-hold').disabled);
    await page.evaluate(() => window.testContext.eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false));
    await page.locator('#xq-chat-hold').click();
    await page.waitForFunction(() => window.stopGenerationCalls === 1);
    assert.equal(await page.evaluate(() => window.stopGenerationCalls), 1);
    await peer.waitForFunction(() => !!window.testContext.chatMetadata.xiaoqing_agent.hold);
    await peer.waitForFunction(() => document.querySelector('#xq-chat-hold').textContent.includes('继续时间'));
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('时间已暂停'));
    await page.screenshot({ path: path.join(root, 'docs', 'time-pause-preview.png'), fullPage: true });
    await peer.locator('#xq-chat-hold').click();
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.hold === null);
    assert.match(await page.locator('#xq-chat-hold').textContent(), /暂停时间/);
    await peer.close();
    // v0.5 自然等待：真实浏览器秒级计时，三次空 WAIT 后由请求额度停止，不借助模型 END。
    await page.evaluate(async () => {
        const ctx = window.testContext;
        ctx.characters[0] = { name: '自然等待测试角色', avatar: 'natural-smoke.png', description: '此刻保持安静。', data: {} };
        ctx.chatId = 'natural-smoke'; ctx.chat = []; ctx.chatMetadata = {};
        document.querySelector('#chat').replaceChildren(); await ctx.eventSource.emit('CHAT_CHANGED');
    });
    await page.locator('[data-setting="dualPhaseEnabled"]').uncheck();
    await page.locator('[data-setting="fastTestEnabled"]').check();
    await page.locator('[data-setting="adaptiveWaitEnabled"]').check();
    for (const [key, value] of Object.entries({ fastTestSeconds: 1, fastWaitMaxSeconds: 3, quietWaitFactor: 2, maxDecisionCalls: 3 })) {
        await page.locator(`[data-setting="${key}"]`).fill(String(value));
        await page.locator(`[data-setting="${key}"]`).dispatchEvent('change');
    }
    const naturalCalls = await page.evaluate(() => window.modelCalls.length);
    await page.evaluate(async () => {
        window.testOutputs.push(...Array.from({ length: 3 }, () => ({ action: 'WAIT', message: null, next_check_minutes: 1, thought: '安静等待。', pending_intention: null })));
        await window.testSend('我先构思一下。');
    });
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.status === 'ENDED', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.modelCalls.length), naturalCalls + 3);
    assert.equal(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.outputCount), 0);
    assert.deepEqual(await page.evaluate(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.map(row => Math.round(row.scheduled_minutes * 60))), [1, 2, 3]);
    await page.waitForFunction(() => document.querySelector('#xq-status').textContent.includes('自主判断请求：3 / 3'));
    await page.screenshot({ path: path.join(root, 'docs', 'natural-wait-preview.png'), fullPage: true });
    await page.locator('#xq-clear').click();
    await page.waitForFunction(() => window.testContext.chatMetadata.xiaoqing_agent.episode.history.length === 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => window.disableXiaoqing());
    assert.equal(await page.locator('#xiaoqing-agent-settings').count(), 0);
    assert.equal(await page.locator('#xiaoqing-chat-controls').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.xiaoqingAgentInterceptGeneration), 'undefined');
    assert.deepEqual(errors, []);
    console.log('浏览器模拟集成测试通过：分钟回归、原始响应与Schema、连续接话、场景与时间暂停、安静WAIT不输出不计次数；单阶段3秒真实计时；双阶段快END和慢阶段共享总上限；两个同源真实标签页通过storage事件双向同步暂停时间/继续时间；390px布局及停用清理；无页面错误。全部为独立固定模型夹具，无真实酒馆/API连接。');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
