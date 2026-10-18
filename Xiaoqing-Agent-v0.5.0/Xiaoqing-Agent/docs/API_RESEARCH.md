# SillyTavern 接口核对

核对日期：2026-10-18。工作目录最初只有 `work/` 与 `outputs/`，未发现现有 SillyTavern 安装或源码。因此选取当时选定的官方发布 **1.19.0**（发布页显示提交 `7e8663c`）作为明确基线；没有把“实际用户已安装版本”假设为该版本。

随后使用 SillyTavern 1.19.0 安装作为接口核对基线。v0.2 的缓冲实现直接核对了该实际安装目录的 public/script.js、public/scripts/extensions.js、slash-commands.js、index.html 和 locales/zh-cn.json，不读取聊天内容或密钥文件。

参考：[官方 UI Extension 文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)、[1.19.0 发布](https://github.com/SillyTavern/SillyTavern/releases/tag/1.19.0)。manifest 声明 `minimum_client_version: 1.19.0`，入口以模块导出 activate/disable 生命周期钩子。

| 需求 | 实际采用的接口 | 核对内容 |
|---|---|---|
| 当前角色、聊天、设置 | `SillyTavern.getContext()` | `characterId`、`characters`、`chatId`、`chat`、`extensionSettings`、`chatMetadata` |
| 完整角色卡 | `unshallowCharacter(characterId)`、`getCharacterCardFields({ chid })` | 加载浅卡后同时读取原始卡数据与处理后的字段 |
| 事件 | `eventSource`、`eventTypes` | MESSAGE_SENT、CHAT_CHANGED、生成及消息修改事件 |
| 当前模型 | `generateRaw({ systemPrompt, prompt, trimNames: false })` | 复用当前 main API；不改变模型配置或临时回复长度 |
| v0.2.3 原始决策 | `generateRawData`、`extractMessageFromData(data, mainApi)` | 公开 Context 导出，跳过 generateRaw 内的聊天正则、Markdown 与停止串清理；旧环境兼容原 generateRaw |
| 推理正文分离 | `parseReasoningFromString(raw, { strict: true })` | 使用当前酒馆推理模板；只将 content 送入严格 JSON 校验，不存 reasoning |
| 全局设置 | `extensionSettings`、`saveSettingsDebounced()` | 使用唯一命名空间，不修改核心设置格式 |
| 聊天状态 | `chatMetadata`、`saveMetadata()` | 归属校验后读写独立命名空间 |
| 消息 | mutable `chat`、`addOneMessage()`、`saveChat()` | 插入并渲染原生角色消息，发送兼容事件 |

公开 Context 导出依据：[st-context.js，1.19.0](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/st-context.js)。扩展未使用内部跨目录 import，没有读取或修改 `is_send_press` 等内部变量。

模型参数签名与停止行为核对：[script.js，L4000](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/script.js#L4000)、[generateRaw，L4122](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/script.js#L4122)。raw 生成有内部 AbortController，监听 GENERATION_STOPPED，但公开参数没有外部 signal；它也不发送正常 Generate 的开始/结束通知。本扩展用逻辑失效标记及请求锁，不擅自中止其他任务。

v0.2.2 直接核对实际安装的 reasoning.js L1461 和 st-context.js L296：公开 `parseReasoningFromString` 返回 `{ reasoning, content }` 或 null，strict 模式只匹配当前模板的开头推理块。generateRaw 本身只进行 cleanUpMessage，没有 quiet 路径的 removeReasoningFromString，因此扩展显式分离正文。对 openai.js L3158 的非成功响应错误 `Got response status NNN` 做固定 HTTP 分类，其余仅识别固定类别，不保存异常原文。

v0.2.3 核对 st-context.js L206 / L287、script.js L4000 / L6276 与 cleanUpMessage L6442：原始接口和文本提取均已公开。带 jsonSchema 的 generateRawData 会调用 extractJsonFromData，返回字符串；returnInvalid 保留无效原文交给本地校验，无 Schema 时才有原始 finish_reason 可读。未把字符串中的未结束括号当成已确认的 token 超限。

用户截图确认使用 DeepSeek V4.1 Flash。[OpenRouter 模型页](https://openrouter.ai/deepseek/deepseek-v4.1-flash) 和 [Structured Outputs 文档](https://openrouter.ai/docs/guides/features/structured-outputs) 确认其 JSON Schema 能力及端点支持差异。实际后端 chat-completions.js L2357 把 json_schema 转成 OpenRouter response_format。仅对该已查证连接启用，接口拒绝时按原有限重试降级；未假设全部模型支持，也未修改核心或供应商路由。

消息插入顺序核对了官方 [sendMessageAs，L5930](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/slash-commands.js#L5930) 的原生聊天结构和事件。实际实现直接使用公开 Context 的可变聊天与渲染/保存函数，不把模型文本拼接成 slash command。没有使用 `saveReply()`，因为该路径内部异步处理和生成上下文会扩大提交竞态窗口。

保存实现见 [script.js，L9408](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/script.js#L9408)。saveMetadata 委托聊天保存；部分异常被核心捕获，因此 README 明确了落盘确认的限制。

消息时间戳核对了 [utils.js，L998](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/utils.js#L998)：timestampToMoment 接受 ISO 8601 以及酒馆原生时间格式。本插件插入 ISO 8601 时间戳，首检与截止均按原用户消息时间计算，不把保存完成后才到达的事件时间误当作发送时间。

事件定义见 [events.js](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/events.js)，初始化方式核对了 [extensions.js](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/extensions.js)。APP_READY 回调延迟执行异步挂载，避免阻塞酒馆加载器；停用移除事件、计时器与设置面板。

v0.2 缓冲：官方文档的 [Prompt Interceptors](https://docs.sillytavern.app/for-contributors/writing-extensions/#prompt-interceptors) 支持 manifest.generate_interceptor。实际 extensions.js L2024–2051 依次调用注册函数并提供 abort；script.js L4564–4570 在用户消息已插入后检查 abort，调用 unblockGeneration 恢复 UI 并返回。缓冲据此拦截普通文本生成，独立等待后以公开 generateRaw 进行接话判断，并通过同一 STAdapter 提交。

GENERATION_STARTED 在 slash 命令之前发送，命令提前返回时未必有 GENERATION_ENDED。v0.2 先在 STARTED 失效旧决策，仅在 GENERATION_AFTER_COMMANDS 设置忙碌，防止命令导致永远 busy。正式生成拦截后，酒馆已有 deactivateSendButtons，abort 的 unblockGeneration 会清理发送状态并触发结束通知。

注册的全局函数 xiaoqingAgentInterceptGeneration 是官方 manifest 协议要求的回调，不改酒馆私有全局变量。输入活动仅监听 #send_textarea 的 input 事件、判断是否存在草稿，不发送草稿、不模拟按钮。普通回复通过 raw 上下文重建，因此完整世界书/作者注释/其他预设提示流水线是明确限制。

本记录是源码核对，不是实际安装或远程服务可用性的证明。

v0.3.2-test.1 只增加前端 timing 辅助模块，不新增后台、接口或第二套模型循环。首检、WAIT、发送冷却和重试都从同一配置取有效时长。任务及收据记录 timingProfile，跨配置的旧 nextAt 会按旧收据更新时间与新最短间隔裁剪；关闭/计数标记继续保留。真实时间字段不替换，测试等待参考另设字段，并在系统提示中标为测试换算。原 1.19.0 公开 Context 调用保持不变。

v0.3.1 没有增加模型请求步骤或私有 API。场景 Schema 将 narration 放在 action 后，要求字符串并将 thought 最大长度设为 120；本地再验证 WAIT 旁白非空。SEND/END 空字符串统一为无动作，兼容旧 null。原生 append 返回前只标记去重额度已预占；返回后才确认场景/对白展示。酒馆内部仍可能捕获部分保存错误，不能以该标记宣称独立验证了服务端落盘。

v0.3 场景模式没有新增后台、slash 命令或私有 API。动作和对白通过已有 STAdapter 一次 append 写入同一原生角色消息，保留既有 guard、收据先写、渲染/保存与事件流程。场景事实读取当前快照的实际消息正文，消息 extra 只增加场景标记；不从心理摘要生成隐藏场景状态。

构思暂停仅在 chatMetadata 的本扩展命名空间保存暂停起点。继续时顺延任务 startAt、dueAt、deadlineAt；模型上下文保留真实最后用户时间，同时明确有效等待与排除的暂停分钟数。缓冲在本页同步顺延自己的计时。控制栏挂在已核对的 1.19.0 public/index.html 的 #send_form 前（同属 #form_sheld）；不可用时退到 #send_textarea 前，停用时移除。没有改写酒馆核心或模拟发送按钮。跨标签设置实时广播不在本次范围内，建议在一个页面运行自主行为。

v0.2.1 修正了事件语义：MESSAGE_UPDATED / MESSAGE_EDITED / CHARACTER_EDITED 通知本身不等于用户明确要求永久取消等待。现在比较实际角色、聊天、用户消息和卡快照；纯通知忽略，真实上下文变化失效旧决策并继续调度，记录事件来源。没有读取实际聊天文件，用户截图只证明当时状态为 CANCELED，无法从旧记录确认具体是哪种事件触发。

## v0.4.0 两阶段与统一额度

本版继续使用 1.19.0 的公开 Context、生成拦截器和原生消息提交，不增加后台或供应商接口。Phases 只扩展同一 Agent 状态机，阶段为 fast / between / slow。双阶段协议 action 增加 STOP，其余五/六字段不变；纯场景 WAIT 允许空字符串旁白，规范化为空动作。

阶段收据以同一角色/聊天/用户消息标记加 fast 或 slow 区分；整轮 outputCount 与分阶段输出计数单调合并，每条实际自主气泡一次，混合消息不重复计数。提交前保守预留，跨页共用模型锁。快慢共享用户可调总上限，模型提前 END 与程序硬上限分开。没有固定快四慢一或三条上限。

全局设置保存整轮上限、快间隔、快阶段时限、慢门槛和慢间隔；旧值保留。慢阶段联系时间独立记录在设置与 localStorage 的 xiaoqing.slow-contact 哈希键中，不把快阶段新发送误当慢阶段联系冷却。实际模型仍由用户现有连接决定，不额外生成隐藏推理。

## v0.4.1 共享时间暂停

不增加酒馆或模型接口。使用 Web Locks 为单聊天暂停操作串行化，localStorage 的 xiaoqing.time-pause 哈希键保存暂停起点、累计完成时长和随机版本标记，不保存角色名或聊天原文。storage 事件同步其他同源标签页；任务检查和最终提交时同步复核。每个任务保存累计时钟检查点，防止错过多次操作后少算或重复计算。内部 hold 字段保持兼容，用户界面统一显示时间暂停。

核对用户安装的 public/scripts/st-context.js 和 public/script.js：Context 公开 stopGeneration()，可停止当前普通生成/流式输出并发出 GENERATION_STOPPED。时间暂停时如正在普通生成则调用该接口；暂停引发的停止事件保留待接话状态，不误变为错误暂停。接口可选，旧模拟环境无此接口仍执行最终提交检查。

