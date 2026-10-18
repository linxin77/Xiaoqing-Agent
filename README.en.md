# Xiaoqing Agent · 小晴 v0.5.0 Beta

[English](README.en.md) | [简体中文](README.md)

**Let characters decide what happens next, even when you have not sent another message.**

Xiaoqing Agent is a personality-driven autonomous interaction extension for single-character chats in SillyTavern. Using the character card, recent conversation, and current scene, the model can choose to speak, act, wait, or end an interaction. The extension manages timing, permissions, budgets, and delivery.

Imagine pausing during a conversation in a bakery. The shopkeeper might carry on labeling bread, tidy the shelves, and later look up to ask whether you need anything else. In scene mode, visible actions appear in the chat so the scene can continue. In chat mode, the focus stays on conversation and appropriate silence.

**MIT licensed. Public beta.** The extension and proactive dialogue permission are disabled by default. Model calls made after enabling it may incur API charges. It requires APIs available in SillyTavern 1.19.0 or later; the isolated compatibility fixture is based on 1.19.0. Compatibility with every later release or combination of extensions has not been verified.

## What's new in v0.5.0

- **Consistent world time:** The current time, last user message time, and effective silence supplied to the model account for time pauses consistently. Physical timestamps are omitted from model-facing history; original chat timestamps and deduplication markers are preserved.
- **Adaptive waiting:** Consecutive empty `WAIT` decisions gradually extend the check interval. Longer model-suggested waits are respected within configurable limits. Fast and slow timing, backoff, and maximum intervals are adjustable; adaptive waiting can also be disabled.
- **Request budgets:** By default, each round allows up to 30 autonomous decision attempts, including failed attempts. The limit is adjustable from 1 to 1,000 and is shared across phases, same-origin tabs, and reloads. Short-term reply buffering has a separate budget.
- **Room to compose:** Autonomous model calls are deferred while a draft is in the input box, and draft text is not submitted. Prompts give stronger guidance for requests such as "I'm thinking; don't interrupt." A time-pause control is available near the chat input.
- **Release documentation:** Installation, contribution, security, attribution, known limitations, automated checks, an optional browser test, and a bug report template are included.

## Installation and updates

### Install from GitHub

In SillyTavern, open **Extensions → Install extension** and paste this repository's Git URL. A local ZIP file is not a Git URL.

The repository root must directly contain `manifest.json`, `index.js`, and the other extension files. When uploading through GitHub's website, upload the contents of the extension folder rather than its outer extraction folder.

### Install manually

1. Extract the release ZIP and locate the `Xiaoqing-Agent` folder.
2. Place it in `SillyTavern/public/scripts/extensions/third-party/Xiaoqing-Agent/`, or in the current user's `data/<user-directory>/extensions/Xiaoqing-Agent/` directory.
3. Check that the final extension directory directly contains `manifest.json`, `index.js`, and `modules/`. Avoid nested copies of the extension folder.
4. Refresh SillyTavern. After an update, use **Ctrl+F5** if necessary and check that the panel displays **v0.5.0 Beta**.
5. Connect your model, enable Xiaoqing Agent, and allow proactive dialogue if desired. Choose chat or scene mode, then send a new message to start a round.

Keep a copy of the previous extension folder before updating. Reloading, increasing a budget, or changing modes does not revive a canceled or completed round. Previously configured output limits are retained.

## Interaction modes

- **Chat mode:** Suitable for messaging-style conversations. A character may follow up, keep waiting, or end the current interaction.
- **Scene roleplay mode:** New visible actions can be narrated, with dialogue and actions combined in one message. Narration is information for the player; it does not imply that the player's character knows everything described. The mode is saved per chat.
- **Consecutive message buffering:** By default, the extension waits five seconds before responding. Sending another message or continuing to type restarts the timer, and the model can choose to wait longer rather than answering each fragment separately.
- **Time pause:** Pause while planning your next move. Autonomous behavior, scene progression, and reply buffering driven by this extension stop, then resume with their remaining time. Pause state is synchronized across same-origin tabs. It does not control other extensions or SillyTavern time macros.

Explicit character-state summaries are generated roleplay text, not hidden reasoning or evidence of consciousness. A future intention is not an event that has already happened in the story.

## Fast and slow phases

The default fast phase starts with a ten-second interval. When the model ends the fast phase, or its duration expires, the extension waits until effective user silence reaches the default five-minute threshold before entering the slow phase. Thresholds, phase duration, intervals, and cooldowns are configurable. A silence episode can have one fast phase followed by one slow phase; the phases do not run in parallel or repeat indefinitely.

- `WAIT`: Stay quiet for now and reconsider later. In scene mode, a wait decision may still include a visible action; an empty wait has no chat output.
- `SEND_MESSAGE`: Produce proactive dialogue when permitted.
- `END`: End the current phase. Ending the fast phase does not prevent a later slow phase.
- `STOP`: End both phases when the user explicitly asks to stop proactive contact.

Manual cancellation ends both phases. A new user message invalidates pending results and starts a new round.

### Adaptive waiting

Adaptive waiting is enabled by default. In the fast phase, a model-suggested minute is scaled to one second, bounded by the configured minimum and maximum fast wait intervals. Consecutive empty waits extend the interval by the configured backoff factor. The slow phase uses effective real minutes and its own configurable cap. Visible output, a phase change, or a new user message resets the empty-wait streak.

Fast timing is a pacing conversion. It does not mean that the player or character has actually spent those suggested minutes in the scene. A promise such as "please stay quiet for ten minutes" should be interpreted using effective world time. Prompt instructions cannot guarantee correct interpretation on every model call; use time pause when you want the extension's world progression to remain still.

| Setting | Default | Range |
|---|---:|---:|
| Minimum fast-phase interval | 10 seconds | 1–3,600 seconds |
| Maximum fast `WAIT` interval | 60 seconds | 1–3,600 seconds |
| Maximum slow `WAIT` interval | 60 minutes | 1–1,440 minutes |
| Empty-wait backoff factor | 2 | 1–4 |
| Slow-phase silence threshold | 5 minutes | 1–1,440 minutes |
| Maximum fast-phase duration | 5 minutes | 1–60 minutes |
| Maximum round duration | 180 minutes | 1–10,080 minutes |
| Autonomous visible output limit | 5 messages | 1–100 messages |
| Autonomous decision request limit | 30 attempts | 1–1,000 attempts |

A maximum wait interval cannot be lower than its corresponding minimum. Round and phase deadlines, cancellation, and pause take precedence. Two-phase mode can be disabled to use fast testing or minute-based timing on its own.

## Budgets, costs, and permissions

Each delivered autonomous chat message counts as one visible output. Pure narration counts as one, and a message combining actions and dialogue also counts as one. An empty `WAIT` does not use the visible output budget. Both phases share the total limit. The character can stop early and does not need to use every available output.

Ordinary SillyTavern replies and replies from the short-term buffer do not count toward the autonomous output limit. **If the buffer has already ended and the main autonomous module sends an initial acknowledgment afterward, that acknowledgment does count as autonomous output.** This is the current counting rule.

An autonomous request is reserved before the call starts. Failed calls, discarded results, and storage failures do not refund that reservation, which helps prevent duplicate calls. Reaching either the visible output limit or the request limit ends the entire round, including any pending slow phase. Normal reply buffering allows at most three requests and at most one retry after a failure; both restrictions apply, independently of the autonomous budget.

Selecting scene mode permits action narration. Proactive dialogue requires separate permission. Do-not-disturb periods suppress decisions and output. The extension does not run after the page is closed, and browser background throttling may delay checks. Raising a limit does not require the model to send a message.

## Models and response format

The extension reuses the current SillyTavern model connection. It does not store its own API keys and is not tied to a single provider. JSON Schema is enabled for the verified OpenRouter / `deepseek/deepseek-v4.1-flash` combination. Other combinations are not forced to use Schema, but returned JSON is still validated strictly.

Invalid format, truncation, authentication failures, and rate limits are reported by category and handled with bounded attempts. Incomplete JSON is not repaired into a message and forcibly sent. Error text is not posted as character dialogue. Generation latency depends on the provider; a check interval is not a guarantee of response time.

## Data and security

The character card, recent messages, and explicit character-state summaries are sent to the currently selected model provider. Extension state is saved in separate metadata for the current chat. Browser storage holds deduplication, pause, and contact interval markers. There is no separate telemetry service, and the extension does not read API key files. See [SECURITY.md](SECURITY.md) for details in Chinese.

Model text is not executed as slash commands or injected as settings HTML. Clearing the character-state history does not remove actions or dialogue already shown in the chat, and does not refund the current round's budgets.

## Development and verification

The core checks and tests do not require dependency installation:

```sh
node scripts/check.mjs
node --test tests/*.test.js
```

Optional browser verification and development instructions are documented in [CONTRIBUTING.md](CONTRIBUTING.md). Test scope and results are recorded in [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md). These supporting documents are currently in Chinese. A GitHub Actions workflow is included; consult the repository's Actions tab for actual remote results. Passing local checks does not establish that remote CI has run.

## Current limitations

This beta does not provide an offline background service, system push notifications, group chat support, or unlimited long-term memory. Recent chat context and previous decisions do not replace full World Info triggering or guarantee continuity across hundreds of turns. Different models and other extensions that edit messages, apply regular expressions, or intercept generation need separate compatibility testing.

Deterministic fixtures check scheduling and message delivery behavior. They do not establish how natural a character feels or whether a follow-up is welcome; those questions require real model samples and user feedback.

## License and contributions

[MIT License](LICENSE). Xiaoqing Agent is an unofficial SillyTavern extension with no additional runtime dependencies or separate backend. Optional development tools and attribution are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Character cards, images, and chats imported by users are not automatically covered by this repository's license.

Bug reports with a minimal example and sensitive information removed are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [docs/OPEN_SOURCE_READINESS.md](docs/OPEN_SOURCE_READINESS.md) for the release assessment, both currently in Chinese.
