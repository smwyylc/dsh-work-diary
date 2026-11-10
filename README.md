# dsh-work-diary

English | [中文](README.zh.md)

A daily work diary for the DSH Web GUI. The sidebar gains a "Diary" icon; opening it gathers the sessions that had activity on a given day and turns them into one Markdown diary entry. It can run on a schedule every day or on demand, and the model used for the summary is configurable.

A dozen sessions and a few dozen tool calls in one day, and by the evening you rarely remember what you actually did. This plugin flips through those sessions for you and saves them into a readable diary — you do not read the whole thing, it only has to say roughly "what got done today".

## What it does

- Picks the sessions that had activity on one day in local time (today by default, switchable to yesterday or any date). "Active" is judged by the last real human question, so a long session that keeps running across days is not missed.
- A session often spans several days, so its events are first cut by day: only the rounds between local 00:00 and the next 00:00 of the target date are kept. Work done on other days is never sent — the diary is about *this* day.
- Each round sends two lines: the human request (first 50 characters) plus that round's AI conclusion (first 200 characters). A round is one human input plus the "conclusion for the user" that follows it before the next human input; assistant messages followed by tool calls are internal process and are dropped entirely. Above "rounds per session" (50 by default) the rounds are sampled: first 25% all, middle 50% evenly spaced, last 25% all.
- Generation is split by project: sessions are grouped by `cwd`, each project gets one request that writes its own section, and once all of them return one merge request assembles the full diary (including the overview). With a single project on that day it degrades to one request.
- The model writes fixed sections: today's overview / the work done today listed by project; the complete tier adds one more section for leftovers and the next step.
- The panel always lists that day's sessions below; clicking a card jumps straight to that session.

## Install

From npm, or from any plugin market that indexes it:

```sh
dsh plugin --profile web add @smwyylc/dsh-work-diary
```

Or install a checkout as a local bundle: `lib/index.js` is the Host half, `lib/client.js` is the Client half, `cordis.patch.yml` declares the row to mount, and `icon.svg` is the sidebar icon; there is no build step.

1. Put this directory anywhere (next to your other plugins is fine).
2. Use the DSH plugin manager's "Install local bundle" to install it into the current profile. This step writes the profile's dependency and mount for you; no hand-editing of the profile.
3. Restart DSH and a "Diary" icon appears in the sidebar.

After changing the code a restart is required: modules are loaded at process start.

## Usage

1. Click the "Diary" icon in the sidebar.
2. Pick a date at the top (today / yesterday / date box) and click "Generate summary"; the body streams in. On a multi-project day a "generating per project (2/5)…" draft shows first and is replaced by the real diary once every project is written.
3. To change the schedule, the model or the sampling budget: click "Settings" at the top right, the settings area expands inline, then click "Save settings".

For a date that already has a summary the button reads "Regenerate" — every click is a real model call.
When the model output hits the length cap it is marked below the body, and that run's ending may be half a sentence.

## Expected cost

Basis: **input = that day's round records (50 characters of user request plus 200 of AI conclusion per round) + the fixed template of each request**; **output = one request per project plus one merge request** (a single request when the day has only one project). Reading sessions and cutting rounds are local disk I/O and cost no tokens.

| Item | Brief (default) | Complete |
| --- | --- | --- |
| Input tokens (a 14-session day with 296 rounds, 171 kept after sampling) | about 20.8k | about 21k |
| Output + thinking per request | about 2600 | about 2600-3000 |
| Number of requests | projects + 1 (1 for a single project) | same |

The daily total is roughly "input + per-request output × request count". The busiest measured day (14 sessions, 296 rounds, 171 kept) already costs about 20.8k input tokens; assuming 6 projects, the total lands near 38k tokens. A quiet day with one or two projects sits at about 8000-11000 tokens.

This version is clearly more expensive than the previous one (one request for the whole diary, about 8900-11600 tokens), for two reasons at once: the input went from "first and last line per session" to "a slice of every round that day", roughly triple, and the thinking half of the output is paid again on every request, so the more projects the higher the total. What it buys is a diary that can finally answer "what happened in the middle". To push the cost down, lower "rounds per session" or turn the schedule off and generate on demand only.

## How it saves tokens

Every layer, from sampling to output, keeps only what is needed to answer "what got done today".

**Sampling**: one session sends its rounds for the day, two lines each (user request + that round's AI conclusion).

- Cut by day first. A session often spans several days, so only events between local 00:00 and the next 00:00 of the target date are kept — "what got done today" must not be mixed with the previous days' wrap-up. The timestamp is the event's own millisecond value or ISO string.
- A round is one human input (`user/message` with `source.kind === 'user'`; agent-injected context does not count) plus the AI's final reply before the next human input. The criterion is "not immediately followed by `tool/call`": within one turn DSH emits several assistant messages in a row, each followed by a batch of tool calls; those are the internal process, nine tenths of the log volume, and sending them only crowds out the real conclusions. The criterion is applied to the day-filtered sequence — an assistant message at the end of the day in a cross-day session is exactly the day's conclusion.
- Conclusions take `text` blocks only; `reasoning` (the thinking process) never enters the digest — "thought about" is not "did".
- Over the cap the rounds are sampled at a fixed ratio: first 25% all, middle 50% evenly spaced, last 25% all. The middle cannot be taken contiguously — a topic turn usually sits there, and taking 26 consecutive rounds means seeing only a few hours of the day; stepping through it keeps "how the day evolved". Sessions under the cap are sent whole, no sampling. How much was sampled is reported in the session header (`- 13:05-17:40 · 175 rounds (50 sampled)`), so the model does not read the omitted middle as empty.
- Per-round truncation: 50 characters for the user request, 200 for the AI conclusion. A request is one sentence; 200 characters of a conclusion covers "what got done", while a full reply often runs to a thousand characters, and sending it whole spends the budget on detail. Both budgets are fixed and do not follow the detail level — the tier should change how verbose the output is, not quietly change the input basis.
- Pleasantries, follow-ups and pasted code or logs do not get a request line of their own (the digest labels are Chinese, `用户:` / `AI:`), but **the round is not dropped**: the AI conclusion is still sent, and the conclusion after "continue" is often exactly what that round produced. The criteria:
  - A sentence counts as a pleasantry only when, with punctuation stripped, it is nothing but words like "ok / thanks / continue";
  - A short follow-up is dropped only when three things hold at once: an interrogative opening ("so / then / wait / is it"), an interrogative ending, and fewer than 20 characters. This avoids killing a real instruction like "can you get the concurrency down to 4?";
  - Pasted code: the first word is `const` / `function` / `select` / `import` or similar and statement punctuation appears nearby, or multiple lines carry semicolons and braces. Looking only at the first word would misjudge a normal sentence like "delete the temp files";
  - A pasted log or command: 60 characters or more with under 25% Chinese characters. A real request is a Chinese sentence, while logs, error stacks and curl commands are almost pure ASCII, so the two separate cleanly.
  - Titles use a separate rule that only excludes code and over-long pastes; short titles ("git version") are kept as-is — otherwise every digest header would degrade to the project name and sessions would become indistinguishable.
- File names are no longer sent. They were a stopgap from the version that only saw the first and last line; now that every round contributes text, a file list only takes up room.

**Output**:

- Requests are split by project. Sessions are grouped by `cwd` (different sessions in one directory count as one project), each project gets one `llm.stream` call, three in flight; when all of them return, one merge request writes the overview and ties the sections together. A single project degrades to one request so no extra thinking is paid for nothing. A failing project request loses only that section and logs a line, without sinking the whole diary.
- The request carries a hard `maxTokens` cap (4000 brief / 6000 complete). The cap has to cover **thinking plus body** together: on 2026-10-28 every one of eight tested models returned an empty body at 900 tokens, because their thinking runs 1500-9000 characters and eats the whole budget before any body appears. Word limits stay in the prompt (300 characters per project section for brief, 400 for complete; 600 and 800 for the merged diary); measured at the 4000 cap the bodies came out around 720-1000 characters, so they mostly obey.
- Thinking cannot be switched off through this gateway. Six spellings were tried on 2026-10-28 (`reasoning_effort=none/low/minimal`, `enable_thinking=false`, `thinking.type=disabled`, and sending nothing): the gateway accepts them all without error and forwards none of them, so thinking never drops below roughly 460 characters, and `reasoning_effort=none` on a real digest sometimes made it longer (6536 characters). The only lever left is the prompt, which now explicitly forbids thinking, analysis and draft output; in a controlled run that took the body from empty to 905 characters. Thinking is therefore the larger half of the output cost and the main reason the total grows once the work is split per project.

## Configuration

Settings are saved in `[DSH_HOME]/work-diary/settings.json` (`~/.dsh` when `DSH_HOME` is unset). Fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether to generate automatically on a schedule every day |
| `time` | `18:00` | Local time HH:MM, runs once when the time arrives |
| `provider` | empty | Provider of the summary model; empty provider and model means follow the default model |
| `model` | empty | Model of the summary model |
| `language` | `zh` | Output language, `zh` or `en` |
| `verbosity` | `brief` | Detail level: `brief` (token-saving) / `full` |
| `maxSessions` | `40` | Maximum sessions included in one summary; the panel reports the count beyond it |
| `roundsPerSession` | `50` | Maximum rounds sent per session; above it the first 25% / an even sample of the middle 50% / the last 25% are kept (fixed ratio, not configurable) |

The settings panel can change the switch, the time, provider / model, language, detail level and rounds per session; `maxSessions` needs a hand edit of `settings.json` and takes effect on the next start. A non-numeric or empty `roundsPerSession` falls back to the default 50; numbers are clamped between 1 and 200.

Automatic execution: one run for the current day when the time arrives (the panel status shows "auto"). If the day has no result yet at DSH startup and the set time has passed, a catch-up run fires immediately; the word `catch-up` appears in the Host log.

Generated results are saved by date in `[DSH_HOME]/work-diary/last-runs.json`, keeping the latest 30. Opening the panel for a date that already has a result shows it directly without generating again.

## Where the data comes from

- The session list is the union of two paths: sessions whose `updatedAt` in `sessionController.list()` (the last real human question, taken from the persisted projection cache) falls on that day, plus sessions created in the last 7 days. The projection cache is not full coverage, so sessions it misses fall back to `updatedAt` = creation time and get dropped; the second path patches that hole, and `readSession`'s real event times give the final verdict. The second path is append-only: guessing wrong only reads a few extra sessions and never misses one.
- Each session is read exactly once through `sessionQuery.readSession`: header, title, counts and every event in one go. listEvents / readEvent / readSession each load the full session log every time and the observation cache holds only 5 LRU entries, so one extra read multiplies the wait.
- Events are cut by `dayBounds` (local 00:00 to the next 00:00, capped at the current moment for today) and only the target date survives; a session with no human input that day is skipped entirely and occupies neither a slot nor the digest.
- A round is one human input plus that round's final AI reply. Human input counts only `user/message` with `source.kind === 'user'`; the final AI reply takes `assistant/message`'s `data.message.content` (note: not `data.content`, which is the user message's path), collects only `type === 'text'` blocks joined with newlines, and must not be immediately followed by `tool/call`.
- The title takes the `session/title` event (last-wins, consistent with the official title projection); a title that is code or an over-long paste falls back to the project name.
- Generation goes through the `llm.stream` streaming interface; the model is decided by settings, and leaving it empty follows `agentDefaultModel`. The rounds array stays inside the Host: `collect` / `poll` return a summary with the round bodies stripped, so dozens of KB are not transferred twice.
- Concurrent collection for the same day merges into one; results for past dates are reused from cache directly, while today's are trusted for only 5 minutes. The panel reads the saved summary from disk first, then collects the session list in the background. At most 8 run records are kept in memory.
- A single session failing to read skips only that session and logs one line, without affecting the whole summary.
