# dsh-work-diary

English | [中文](README.zh.md)

A daily work diary for the DSH Web GUI. The sidebar gains a "Diary" icon; opening it gathers the sessions that had activity on a given day and turns them into one Markdown diary entry. It can run on a schedule every day or on demand, and the model used for the summary is configurable.

A dozen sessions and a few dozen tool calls in one day, and by the evening you rarely remember what you actually did. This plugin flips through those sessions for you and saves them into a readable diary — you do not read the whole thing, it only has to say roughly "what got done today". The default tier costs about 8900-11600 tokens once a day.

## What it does

- Picks the sessions that had activity on one day in local time (today by default, switchable to yesterday or any date). "Active" is judged by the last real human question, so a long session that keeps running across days is not missed.
- Each session contributes only metadata, its first user request, and its last assistant conclusion, plus the file names its tool calls touched, assembled into a digest handed to the model. The last assistant conclusion answers "what finally got done", which is more direct than the first request — the request says what you wanted; when the last line is only half a sentence it falls back to the previous complete conclusion and is marked "(in progress)".
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
2. Pick a date at the top (today / yesterday / date box) and click "Generate summary"; the body streams in.
3. To change the schedule or the model: click "Settings" at the top right, the settings area expands inline, then click "Save settings".

For a date that already has a summary the button reads "Regenerate" — every click is a real model call.
When the model output hits the length cap it is marked below the body, and that run's ending may be half a sentence.

## Expected cost

Basis: **input = that day's digests of every session + the fixed template** (267 characters for the brief template, 299 for the complete one). Reading sessions and scanning file names out of tool calls are local disk I/O and cost no tokens; only the generation call hits the model. The table below samples a day of 13 sessions; doubling the session count roughly doubles the input and leaves the output unchanged.

| Item | Brief (default) | Complete |
| --- | --- | --- |
| Input characters (digest + fixed template) | about 10-12k | about 13-17k |
| Input tokens (at 1.5 characters/token) | about 6700-8000 | about 8700-11300 |
| Output + thinking tokens | about 2200-3600 | about 2600-4000 |
| Total tokens for the day | about 8900-11600 | about 11300-15300 |

The input half comes from the conclusion budget being raised from 500 to 1000 characters (which pushed the brief tier's input from about 4400 tokens to about 6.7k) and from the "backfill the previous complete conclusion when the last line is too short" rule (see the next section). How much a backfill recovers depends on the session itself — measured on the same day, a backfill may add only 45 characters or recover 900, which is why the input bounds are far apart. Usually only one or two of the 13 sessions trigger it.

The output half is dominated by thinking, which the gateway will not let anyone switch off (see "How it saves token"). On 2026-10-28 the brief tier measured 2920 input tokens plus 2710 output tokens on a six-session day, and the complete tier 4185 plus 3067. Doubling the session count roughly doubles the input and leaves the output unchanged.

It runs automatically once a day. With "Generate daily on a schedule" turned off the fixed cost is 0 and a call only happens when you click "Generate summary".

## How it saves tokens

The default tier compresses layer by layer, from sampling to output, keeping only what is needed to answer "what got done today".

**Sampling**: each session sends two lines of body (first request + last conclusion), and the session header names a few files.

- Filter the noise first. A session's first and last lines are often not work content but pleasantries like "continue" or "thanks", short follow-ups, or pasted-in code and tables. Sending them as-is buys noise with tokens:
  - A sentence counts as a pleasantry only when, with punctuation stripped, it is nothing but words like "ok / thanks / continue";
  - A short follow-up is dropped only when three things hold at once: an interrogative opening ("so / then / wait / is it"), an interrogative ending, and fewer than 20 characters. This avoids killing a real instruction like "can you get the concurrency down to 4?";
  - Pasted code: the first word is `const` / `function` / `select` / `import` or similar and statement punctuation appears nearby, or multiple lines carry semicolons and braces. Looking only at the first word would misjudge a normal sentence like "delete the temp files";
  - A pasted log or command: 60 characters or more with under 25% Chinese characters. A real request is a Chinese sentence, while logs, error stacks and curl commands are almost pure ASCII, so the two separate cleanly. This one cannot be dropped: pasted content has the least overlap with its surroundings, and the complete tier's "most unlike" mainline pick would select it first;
  - Titles use a separate rule that only excludes code and over-long pastes; short titles ("git version") are kept as-is — otherwise every digest header would degrade to the project name and sessions would become indistinguishable.
- First request + last assistant conclusion. The first request declares what is to be done; the last assistant body says what finally got done — "cleaned up, the remote branch is deleted", "not done, only the plan is written, waiting for your call", "223153 is in the test MQ with no failures". This is the most direct answer to "what work got done today": the request says what you **wanted** to do, the conclusion says what was **done**. Only `text` blocks are collected from conclusions; the model's internal `reasoning` blocks (the thinking process) never enter the digest — "thought about" is not "did".
- The complete tier also sends one mainline line and two ending lines. The endings state what the user last asked for; the mainline covers the middle that the first and last lines cannot see, picking "least like the first and last, yet specific enough", discounted by length so a short detour cannot beat a slightly longer new topic — a topic turn is usually exactly the moment the goal changed. When the whole session circles one thing it falls back to the longest line; sessions under 40 requests do not pay for the mainline. The brief tier drops both lines: the ending and the conclusion ask the same thing and the conclusion answers it better; the mainline is the line most easily captured by an assistant reply the user **pasted back** in a long session — that text is least like the short anchors and long enough, hitting the mainline's criteria exactly, while the brief tier has only one first request to compare against, so being led astray costs more than the 120 characters saved.
- File names take the most-touched one. File names seen in tool calls are sorted by count and the first is listed in the session header (5 in the complete tier), extras only reported as `+N`. A file name is direct evidence of "what was really changed" — one line "touched CertStandardName.asp" is more concrete than any request, and it costs only a dozen characters. Only basenames are kept, directories dropped; a code or document suffix is required, while URLs and words inside sentences do not count.
- Truncate item by item: 200 characters for a brief request, 500 for a complete one; 400 for the mainline (complete tier only), 1000 for a brief conclusion, 1500 for a complete one. The conclusion and the request each get their own budget; several requests joined into one paragraph before truncation would share one budget. The conclusion budget is much wider than the request's: a request is one sentence, while a conclusion is often a complete reply of hundreds or thousands of characters, and cutting it in half answers nothing.
- Backfill when the last line is too short. An active session's last assistant message is often only a lead-in ("the message body has a single id field. now looking at who calls it"), and using it as "what got done" voids that signal. So when the last line is under 80 characters the last long-enough conclusion is used instead and the line is marked "(in progress)", telling the model this one is backfilled and the session was still running. The 80 line was measured: real replies can be short too, and the measured 97 / 248 / 278 character lines are all complete conclusions, all above the line and never replaced; when it is under 80 with no longer conclusion to backfill, the last line is still used — short beats nothing.
- The session header is compressed to one line: time, request count, files touched; the brief tier carries no long cwd path. A session spanning days shows dates at both ends (`10-23 17:46 - 10-26 17:35`), so it never displays as the upside-down-looking `17:46-17:35`.

**Output**:

- The request carries a hard `maxTokens` cap (4000 brief / 6000 complete). The cap has to cover **thinking plus body** together: on 2026-10-28 every one of eight tested models returned an empty body at 900 tokens, because their thinking runs 1500-9000 characters and eats the whole budget before any body appears. Word limits stay in the prompt (600 characters for brief, 800 for complete); measured at the 4000 cap two models wrote 724 and 741 characters, so they mostly obey.
- Thinking cannot be switched off through this gateway. Six spellings were tried on 2026-10-28 (`reasoning_effort=none/low/minimal`, `enable_thinking=false`, `thinking.type=disabled`, and sending nothing): the gateway accepts them all without error and forwards none of them, so thinking never drops below roughly 460 characters, and `reasoning_effort=none` on a real digest sometimes made it longer (6536 characters). The only lever left is the prompt, which now explicitly forbids thinking, analysis and draft output; in a controlled run that took the body from empty to 905 characters. Thinking is therefore the larger half of the output cost and the main reason the total sits where it does.

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

The settings panel can change the switch, the time, provider / model, language and detail level; `maxSessions` needs a hand edit of `settings.json` and takes effect on the next start.

Automatic execution: one run for the current day when the time arrives (the panel status shows "auto"). If the day has no result yet at DSH startup and the set time has passed, a catch-up run fires immediately; the word `catch-up` appears in the Host log.

Generated results are saved by date in `[DSH_HOME]/work-diary/last-runs.json`, keeping the latest 30. Opening the panel for a date that already has a result shows it directly without generating again.

## Where the data comes from

- The session list is the union of two paths: sessions whose `updatedAt` in `sessionController.list()` (the last real human question, taken from the persisted projection cache) falls on that day, plus sessions created in the last 7 days. The projection cache is not full coverage, so sessions it misses fall back to `updatedAt` = creation time and get dropped; the second path patches that hole, and `readSession`'s real event times give the final verdict. The second path is append-only: guessing wrong only reads a few extra sessions and never misses one.
- Each session is read exactly once through `sessionQuery.readSession`: header, title, counts, all real human requests, the last assistant conclusion and tool-call events in one go. listEvents / readEvent / readSession each load the full session log every time and the observation cache holds only 5 LRU entries, so one extra read multiplies the wait.
- Requests count only real human input: `source.kind === 'user'` on `user/message` counts, agent-injected context does not; a session with no real human input is skipped entirely.
- The conclusion takes `assistant/message`'s `data.message.content` (note: not `data.content`, which is the user message's path): from the block array only `type === 'text'` blocks are collected, multiple blocks joined with newlines, and the last non-empty one across the session — the last line is "where it got to", while middle assistant messages are process. An empty body (tool calls only) does not overwrite the previous one. The last conclusion of 80 characters or more (`resultFull`) is also recorded, used by the digest with "(in progress)" appended when the last line is under 80 characters, and both conclusions are returned to the panel with collect.
- The title takes the `session/title` event (last-wins, consistent with the official title projection); a title that is code or an over-long paste falls back to the project name.
- Generation goes through the `llm.stream` streaming interface; the model is decided by settings, and leaving it empty follows `agentDefaultModel`.
- Concurrent collection for the same day merges into one; results for past dates are reused from cache directly, while today's are trusted for only 5 minutes. The panel reads the saved summary from disk first, then collects the session list in the background. At most 8 run records are kept in memory.
- A single session failing to read skips only that session and logs one line, without affecting the whole summary.
