# Telegram Resume Native Claude Code Sessions Design

Date: 2026-05-06

## Goal

Allow a Telegram user to list recent native Claude Code history sessions on the same Windows machine, take over one session through TLive, continue it from Telegram, and later release it so desktop Claude Code can resume the same native session safely.

First version scope is Telegram only. It must be implemented in TLive source, not by patching `bridge/dist/main.mjs` or global `node_modules`.

## Current State

TLive already persists its own sessions under `~/.tlive/data/sessions`, channel bindings under `~/.tlive/data/bindings.json`, and stores Claude Code's native session id as `sdkSessionId`. The Claude provider already resumes native sessions by passing `resume: sessionId` to the Claude Agent SDK with the selected `cwd`.

The missing pieces are discovery of native Claude Code JSONL files, importing one of those sessions into TLive's session store, Telegram commands to select it, and a soft lease to prevent accidental concurrent phone use.

## History Semantics

After Telegram resumes a native Claude Code session, the Claude Agent SDK receives the native `sessionId`, so Claude Code should continue with the previous conversation context. The model can use the prior history just like desktop `claude --resume <session-id>` would.

Telegram will not automatically display or replay the full prior transcript in this first version. `/session` shows a short one-line preview for each candidate. After `/resume <n>` succeeds, TLive sends recent visible context from the selected native JSONL so the user can orient themselves before typing.

The recent-history display is only for the human in Telegram. It is not imported into TLive message history because Claude Code already resumes from the native session id.

## Architecture

Add three small modules and keep command handling thin:

1. `claude-native-scanner`
   - Scans `~/.claude/projects/**/*.jsonl`.
   - Uses an injectable base directory for tests; production defaults to `homedir()/.claude/projects`.
   - Does not specially follow symlinks.
   - Preselects the most recent 100 JSONL files by file `mtime`, then streams those files line by line.
   - Outputs metadata only; it never writes TLive state.

2. `claude-session-importer`
   - Converts one scanner result into a TLive session record.
   - Reuses an existing imported session when `source === "claude-native"` and `sdkSessionId` match.
   - Writes or refreshes `sdkSessionId`, `workingDirectory`, `source`, `sourcePath`, `nativePreview`, `importedAt`, and `lastNativeActivityAt`.
   - Rebinds the current Telegram chat to the imported TLive session id.

3. `native-session-lease`
   - Persists soft leases keyed by Claude native `sdkSessionId` through `BridgeStore` methods.
   - Enforces ownership among TLive/Telegram chats.
   - Refreshes activity and expires leases after idle TTL.
   - Cleans expired leases on startup or first use, and opportunistically on list/acquire/refresh.

`CommandRouter` adds Telegram-only commands:

- `/session` to list native Claude Code sessions
- `/session all` to show every scanned candidate instead of the default first five
- `/resume <n|current>` to take over a listed or current imported native session
- `/resume <n|current> cwd "<absolute-path>"` to override the working directory
- `/release`

For non-Telegram channels, these commands return a clear “currently Telegram only” message instead of passing through to Claude.

`SDKEngine` keeps the existing resume path. A new guard near the start of `SDKEngine.handleMessage` blocks ordinary messages to released or non-owned imported native sessions before saving messages or starting Claude. `CommandRouter` receives a small `isChatActive(channelType, chatId)` capability from `SDKEngine` so `/release`, `/new`, `/session`, and `/runtime` can refuse unsafe changes while work is running.

## Scanner Behavior

`/session` scans native Claude Code JSONL files, sorts by latest JSONL activity descending, and shows the first five sessions by default. `/session all` shows every scanned candidate. Final sort uses latest JSONL `timestamp`; file `mtime` is only a prefilter and fallback.

For each JSONL file:

- `sessionId`: first valid JSONL `sessionId`; fallback to filename UUID only if no JSONL session id exists. If filename and JSONL id mismatch, keep JSONL id and store mismatch as debug metadata.
- `cwd`: last valid non-empty JSONL `cwd`.
- `cwdSource`: `jsonl` if from a row, `project-dir` if derived, `unknown` otherwise.
- `cwd` fallback: derive from project directory names like `D--Desktop` to `D:\Desktop`.
- `cwdExists`: true only when `statSync(cwd).isDirectory()` succeeds.
- `lastActivityAt`: latest JSONL `timestamp`; fallback to file `mtime`.
- `preview`: latest non-empty visible user message, truncated for list display; fallback to first visible user message; fallback `(empty)`.
- `nativePreview`: same preview stored on imported TLive sessions so `/sessions` can identify imported native sessions without writing fake messages.
- `recentMessages`: latest visible user/assistant messages for the post-resume orientation display.
- `gitBranch`: latest JSONL `gitBranch`, if present. TLive does not run git to verify current branch.
- `version`: optional debug metadata only; not shown in user-facing lists.
- `isSidechain`: sessions where all or most main transcript rows have `isSidechain: true` are excluded from the default list. Mixed/uncertain sidechain sessions are also excluded in the first version to keep the list focused on main Claude Code conversations.
- Bad JSONL rows are skipped. A file with no useful metadata is skipped.

Sessions are deduplicated by native `sessionId`; keep the candidate with the newest `lastActivityAt`, and if tied prefer the one whose cwd is an existing directory.

Unknown or missing cwd sessions are listed but cannot be resumed without an explicit valid `cwd` override.

## Recent Context Display

After successful `/resume`, TLive re-reads the selected JSONL to produce the recent context. The list candidate cache is used only to bind the user-selected index to a stable session.

Default behavior:

- Show the latest 3 complete visible user/assistant messages.
- If those 3 messages total less than about 1500 characters, include up to 5 complete visible messages.
- Display messages from old to new.
- Do not merge consecutive user messages.
- Do not truncate selected message content.
- If selected content exceeds Telegram message limits, split it across multiple Telegram messages with page markers such as `(1/3)`.
- Send the takeover warning/status as its own message before recent context pages.
- Escape Telegram HTML (`<`, `>`, `&`) and keep each page’s HTML tags self-contained.
- Do not parse Markdown from history; render as escaped plain/preformatted text.

Filtering rules:

- Show visible user text and visible assistant text only.
- Skip system/meta/compact/hook/permission records.
- Skip tool-result payloads, tool call JSON, thinking blocks, binary attachments, and hidden rows.
- A pure attachment user message can appear as `U: [附件/图片消息，未在 Telegram 最近上下文中展开]`.
- Visible user text, including `/compact`-related user input, can be shown.
- Assistant messages over about 6000 characters are not selected by default. Instead, insert a short skip notice at that position and continue looking backward for enough complete displayable messages. The skip notice does not count toward the 3-message target.
- Very long user messages are still shown completely by splitting pages.

`/resume current` also shows recent context, but targets the latest 1-3 complete visible messages.

If the recent-context reread fails, TLive still allows resume when the cached selection is otherwise valid, but reports that recent context is unavailable. If reread succeeds but the JSONL `sessionId` differs from the cached selected `sessionId`, reject and ask the user to run `/session` again.

## Telegram User Experience

`/session` returns a Telegram-formatted list with stable indices cached for 5 minutes per Telegram chat:

```text
📋 Claude Code Sessions

1. tlive · May 06 12:34 · main
   D:\SirisLi\GitHub\tlive
   继续调查/实现 TLive...
2. Desktop · May 05 21:08 · locked by you
   D:\Desktop
   ok。我准备 compact...

Use /resume <n> within 5 minutes to take over
```

List display rules:

- Show up to 5 sessions by default; `/session all` shows every scanned candidate.
- Show basename first; include enough parent/full path context to disambiguate duplicate basenames. Full cwd may be truncated in this list.
- List preview may be truncated.
- Display latest `gitBranch` when available.
- Markers are ordered by importance: `locked by you` / `locked`, `path missing` / `cwd unknown`, then branch.
- If a session is both locked and path missing, `/resume` reports the lock first.
- Show active lease status in the list. Current chat owner appears as `locked by you`; other owners appear as `locked` with masked owner when needed.
- Footer says indices are valid for 5 minutes.
- No inline buttons in the first version.
- No search parameter in the first version.

`/resume <n>` uses the current chat’s cached `/session` result. If the cache is missing or expired, it tells the user to run `/session` again. It does not silently rescan and reinterpret the number. Successful resume clears the cache.

`/resume current` uses the current binding when it points to an imported native session. It does not require a candidate cache. If `sourcePath` is missing, TLive may scan the most recent 100 native JSONLs for a matching `sdkSessionId` and update `sourcePath`; it does not change cwd unless `cwd` is provided.

`cwd` behavior:

- Works for both numeric and `current` resume.
- Requires an absolute path. Relative paths are rejected.
- Supports quoted Windows paths with spaces, e.g. `cwd "D:\My Projects\foo"`.
- Unquoted paths containing spaces are rejected with usage guidance.
- Supports UNC absolute paths if Node treats them as absolute and they exist.
- Must point to an existing directory, not a file.
- Does not require basename or git repo matching.
- Overrides the imported session’s `workingDirectory` and reports old cwd → new cwd.
- Without an explicit `cwd`, a valid existing imported `workingDirectory` is reused first; otherwise a scanner cwd is used only if `cwdExists` is true.
- If cwd is unknown or the scanned path is missing, `/resume` rejects and tells the user to provide `cwd "absolute path"` instead of falling back to the bridge default workdir.

Successful takeover status includes:

- Native session short hash: last 8 characters of `sdkSessionId`.
- Full cwd.
- Latest JSONL branch, if known.
- Whether runtime was switched to Claude.
- Current settings scope. If `isolated`, warn that project `CLAUDE.md`, MCP, and skills will not load; suggest `/settings full` before sending work if desktop-like project context is desired.
- Current permission mode. If `/perm off`, warn that tool calls will be auto-allowed and suggest `/perm on` for phone approval.
- 30-minute idle TTL.
- `/release` reminder.
- Clear warning not to type into desktop Claude Code concurrently.

`/release`:

- Only the owner chat can release its lease.
- If the lease has already expired, report that it had auto-expired and still run local cleanup/close.
- If current work is running, refuse and ask the user to `/stop` or wait.
- Releases the lease, closes active TLive LiveSession, clears current chat candidate cache, and keeps the binding/imported session record.
- Replies with full cwd and `claude --resume <session-id>` guidance for returning to desktop. If cwd is unknown/missing, tell the user to run the command from the correct project directory.

After `/release`, ordinary messages to that imported native session are blocked until explicit `/resume current`. The prompt is:

```text
该 Claude session 当前已释放，未由 Telegram 接管。
发送 /resume current 重新接管，或 /new 开始新的 TLive 会话。
```

## Imported Session Shape

Imported records should extend the existing session data without breaking older records:

```json
{
  "id": "session-imported-<last8>-<timestamp>",
  "workingDirectory": "D:\\...",
  "createdAt": "...",
  "sdkSessionId": "<Claude native sessionId>",
  "source": "claude-native",
  "sourcePath": "C:\\Users\\...\\.claude\\projects\\...jsonl",
  "importedAt": "...",
  "lastNativeActivityAt": "...",
  "nativePreview": "..."
}
```

`SessionData` should formally include:

```ts
source?: 'claude-native';
sourcePath?: string;
importedAt?: string;
lastNativeActivityAt?: string;
nativePreview?: string;
```

Existing `ConversationEngine` and `SDKEngine` must preserve extra session fields when updating `sdkSessionId`; otherwise imported metadata would be lost after the next query result.

Existing non-Telegram `/sessions` behavior should continue sorting by existing `createdAt` semantics. Imported native sessions should appear there with a `[Claude native]` marker. Preview priority is: first TLive user message if present, otherwise `nativePreview`.

On Telegram, `/session <n>` is not a switch command; users must use `/resume <n>` to acquire a native lease. Existing non-Telegram session-switch behavior remains separate from the native Claude takeover flow.

## Soft Lease Design

Persist leases in `~/.tlive/data/native-session-leases.json` through `BridgeStore` methods, not by direct side-file access from callers:

```json
{
  "<sdkSessionId>": {
    "sdkSessionId": "...",
    "owner": "telegram:<chatId>",
    "ownerUserId": "<telegram user id>",
    "tliveSessionId": "session-imported-...",
    "lockedAt": "...",
    "lastActiveAt": "...",
    "ttlMinutes": 30
  }
}
```

Add store methods along these lines:

- `getNativeSessionLease(sdkSessionId)`
- `saveNativeSessionLease(lease)`
- `deleteNativeSessionLease(sdkSessionId)`
- `listNativeSessionLeases()`

Rules:

- Owner is `telegram:<chatId>`. Store `ownerUserId` only as auxiliary metadata.
- Mask owners in user-facing text as `telegram:*1234` using only the last four chat id characters.
- `/resume <n|current>` acquires a lease when none exists or when the existing lease has expired.
- Same owner chat may re-acquire and refresh its own lease.
- Another Telegram chat is rejected while a non-expired lease exists. No force takeover in the first version.
- Different Telegram chats may hold leases for different native `sdkSessionId`s.
- Same Telegram chat switching from native A to native B must first verify B is acquirable; only then release A and switch. If B is unavailable, keep A unchanged.
- Lease TTL is 30 idle minutes. A task running longer than 30 minutes does not expire mid-run; refresh when the user message is accepted and when the task completes.
- `/stop` keeps the lease and refreshes `lastActiveAt`, even if no active execution was found.
- Ordinary Telegram commands refresh the current native lease when owner matches, except `/release`.
- If a command sees an expired lease, clean it up but do not automatically reacquire; `/resume current` is required.
- `/new`, `/session`, and `/runtime codex` release the current native lease before changing session/runtime when no work is running; if work is running, they refuse and ask the user to `/stop` or wait.
- `/settings` and `/perm` do not affect the lease.
- `/release`, `/new`, `/session`, and `/runtime` clear the current chat’s candidate cache when they release or change the active session/runtime. `/stop` does not clear candidate cache.

This is a soft TLive-side lock. It does not prevent a desktop Claude Code process from writing to the same native session JSONL. The success message must warn the user not to type in desktop Claude Code concurrently. TLive does not try to detect whether desktop Claude Code is currently open on the same session.

## Runtime and Message Flow

`/resume` imports/binds/acquires lease/displays context only. It does not start Claude and does not send an empty prompt. The LiveSession starts only when the next ordinary user message is accepted.

`/resume` automatically switches the chat runtime to Claude if needed, because the command explicitly targets native Claude Code sessions. It does not automatically change `/settings` scope or `/perm` mode.

TLive must not inject “this came from Telegram” or similar text into the first resumed prompt. Telegram is the transport layer; the native Claude history should not be polluted.

The ordinary-message guard runs before saving the user message or creating a LiveSession:

- If current binding is not an imported native session, continue existing behavior.
- If binding is an imported native session and owner lease is valid, refresh lease and continue.
- If lease is missing, released, expired, or owned by another Telegram chat, do not save the message and do not call Claude. Send a clear prompt to `/resume current` or wait/release as appropriate.

If Claude Agent SDK resume fails later when the first real message starts Claude, report the failure and release the lease. Do not silently fall back to a new conversation.

## Candidate Cache

`/session` stores the ordered candidate list in memory by chat key for 5 minutes. It is not persisted. Bridge restart requires listing again.

Cache behavior:

- `/resume <n>` requires a valid cache.
- Cache expiry requires running `/session` again; do not show or reuse an expired list.
- `/resume current` does not need the cache.
- Runtime/settings/permission changes do not invalidate candidate cache.
- A new `/session` overwrites the cache.
- Successful numeric resume clears the cache.
- `/release` clears the cache, but `/resume current` remains available because it uses binding/imported session state.

## Logging

Log native session acquire/release and important failures with:

- native short hash
- masked owner
- cwd
- sourcePath for scanner/importer errors

Do not log message content or JSONL row contents.

## Error Handling

- Missing `~/.claude/projects` or no sessions: `/session` says no Claude Code history sessions were found and suggests using Claude Code on this machine first.
- Scanner skips malformed JSONL rows.
- Unreadable JSONL files are skipped.
- Obvious sidechain sessions are hidden from the default list.
- Invalid index: `/resume` asks the user to run `/session` again.
- Missing or expired candidate cache: ask the user to run `/session` again.
- `cwd unknown`: reject resume unless a valid existing imported cwd is available or explicit `cwd` is provided.
- `path missing`: reject resume unless a valid existing imported cwd is available or explicit `cwd` points to an existing directory.
- Locked by another chat: reject before cwd validation and show masked owner/remaining time.
- Runtime is not Claude: `/resume` switches the chat runtime to Claude and reports it.
- Live session creation or resume failure: release the lease and report failure. Do not delete the imported session record and do not fallback to a new session.
- JSONL reread failure for recent context: allow resume without context and report preview unavailable.
- JSONL reread session id mismatch: reject and ask the user to run `/session` again.

## Tests

Add Vitest coverage for:

Scanner:

- Parses `sessionId`, `cwd`, preview, timestamp, branch, and recent visible messages.
- Derives cwd from `D--Desktop` style project directory names.
- Requires cwd to be an existing directory, not just an existing path.
- Deduplicates by session id.
- Excludes sidechain sessions.
- Tolerates malformed JSONL rows.
- Uses injectable base directory and does not read real `~/.claude/projects` in tests.

Recent context renderer:

- Shows 3 complete visible messages by default.
- Expands to 5 when the first 3 total under about 1500 characters.
- Displays old to new.
- Does not truncate selected messages.
- Splits long user messages across Telegram-sized pages with page markers.
- Skips long assistant messages over about 6000 characters, inserts a skip notice, and continues filling displayable messages.
- Skips system/meta/tool/thinking/attachment-only rows as specified.
- Escapes Telegram HTML and keeps tags valid per page.

Store and lease:

- Saves, reads, lists, refreshes, expires, and releases native session leases.
- Persists leases across `JsonFileStore` instances.
- Uses fake timers for TTL tests.
- Masks owners correctly.

Command router / native Claude commands:

- `/session` formats Telegram list output with markers and 5-minute cache notice.
- Non-Telegram native commands return Telegram-only unsupported text.
- `/resume <n>` requires cached candidates.
- Numeric resume saves or reuses imported session, binding, and lease.
- Existing imported sessions are reused by `sdkSessionId`.
- Missing path rejects resume; valid absolute `cwd` override accepts and updates cwd.
- Quoted Windows paths with spaces parse correctly; relative paths and file paths reject.
- `/resume current` works from current binding without candidate cache and supports `cwd`.
- `/release` releases lease, closes LiveSession, clears candidate cache, keeps binding, and shows desktop resume guidance.
- `/release`, `/new`, `/session`, and `/runtime codex` reject while work is running.
- `/new`, `/session`, and `/runtime codex` auto-release native lease when safe.
- `/stop` refreshes but does not release native lease.

SDK/message guard:

- Ordinary messages to released/expired/non-owned imported native sessions are blocked before message save.
- Guarded messages are not written to TLive message history.
- Valid owner messages refresh lease and proceed.
- Task completion refreshes lease.
- Resume failure releases lease and does not fallback to a new session.

Regression:

- Existing `/sessions` and `/session <n>` continue to operate on TLive-managed sessions.
- `/sessions` displays imported native sessions with a marker and uses TLive first user message before `nativePreview`.
- Existing Claude resume through `sdkSessionId` remains unchanged.
- `ConversationEngine` and `SDKEngine` preserve extra session metadata when updating `sdkSessionId`.

Manual verification after implementation:

- Run Vitest.
- Run bridge build.
- Start real TLive bridge and verify in Telegram: `/session`, `/resume <n>`, recent context display, a resumed user message, `/release`, blocked ordinary message after release, `/resume current`.
- Do not automatically run desktop `claude --resume`; list it as a manual back-to-desktop check.

## Documentation and Build

Implementation should update Telegram help and the README/README_CN or command docs with a short command list:

- `/session` — list native Claude Code sessions
- `/resume <n|current>` — take over a native Claude Code session
- `/release` — release Telegram takeover

Do not write a long tutorial in the first implementation.

Run `npm test` and `npm run build` under `bridge`. Do not hand-edit `bridge/dist/main.mjs`. If build output is tracked by the repo, include it as generated output; otherwise do not add new dist files.

## Out of Scope

- Editing `bridge/dist/main.mjs` by hand.
- Patching global npm `node_modules`.
- `/menu` button integration.
- Inline selection buttons.
- Support for Discord or Feishu commands.
- Force takeover from another Telegram chat.
- Hard-locking or detecting desktop Claude Code.
- Scanning non-default Claude project paths or multiple Claude homes.
- WSL/Linux path auto-conversion.
- Codex native session support.
- Search parameters for `/session`.
- Config flags or env vars for this feature.
- Importing or replaying the full native Claude message history into TLive message history.
