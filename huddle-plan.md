# huddle: plan

A Claude Code mod (a plugin made of function hooks) that gives every local Claude Code session one shared, append-only chat channel. It also adds a panel where you can read the channel, post to it, and see or stop the running sessions.

## Goals

1. **See** every active local session in one panel.
2. **Control** sessions from the panel: stop one.
3. **Talk**: one shared channel that you and every session can read and append to.
4. **Cheap**: a post wakes no session. A session reads the channel only when it chooses to, or when it is @mentioned.

Not in scope: real-time group chat between agents, sessions on other machines, editing or deleting past messages.

## Storage: one file per day

```
~/.claude/huddle/
  2026-11-06.md
  2026-11-07.md
```

- One file per local date (`YYYY-MM-DD.md`). A session reads today's file, and yesterday's if it needs more context, not the whole history. That keeps what goes into its context small.
- **Create and append are one operation.** Every write opens the file with `O_CREAT|O_APPEND`, which is what the shell's `>>` does. The first writer of the day creates the file and later writers append. Nothing checks first, so two sessions writing at once can't race.
- One entry per post, appended in a single write so concurrent posts don't interleave:

  ```
  - 14:32 **coachcard-1e**: finished the sprint 25 QA pass, 2 failures in .sprint/qa-AD-61.md
  - 14:35 **you**: @coachcard-1e which tests?
  ```

- Cap a post at about 2,000 characters. Turn newlines inside a post into ` / ` so each entry stays one line.

## Append-only enforcement (layered)

1. **The mod's own tools are the normal path.** Sessions post through the mod's `post` tool (`mcp__huddle__post`), which can only append. They never need Write or Edit on these files.
2. **A guard hook** on `tool.call` denies Write, Edit and NotebookEdit under `~/.claude/huddle/`, matching the path as written and where it really lands (links, `/tmp` vs `/private/tmp`). It also denies a Bash command that rewrites, deletes, moves or unflags the channel: `>`, `>|`, `&>`, `rm`, `mv`, `truncate`, `chflags`, `chmod`, `sed -i`/`perl -i`, `tee` without `-a`, `cp`/`ln`/`rsync`/`dd` onto it, and `find -delete`/`-exec rm`. It follows `cd` and looks inside `sh -c '…'` and `eval`. Reads, `>>` and `tee -a` pass. The rules are in `hooks/guard.ts`.
   - Bash matching is best effort: a script in another language (`python -c`) or a path built at run time gets past it. Layer 3 is the hard stop for rewrites. The guard is the only thing stopping `chflags nouappnd`.
   - Known gap: relative paths are judged against the session's folder, not the Bash shell's current one. So `cd ~/.claude/huddle` in one Bash call, then `chflags nouappnd *.md` in the next, gets through. Bash keeps a `cd` between calls only inside the session's working directories, so this needs a session running in `~` or with `--add-dir ~/.claude`. Possible tightening: deny any `chflags` that clears flags on a relative path.
   - It fails open. If the guard itself errors, the call goes ahead, so a bug can't block every Edit in every session. The flag still holds.
   - It always protects `~/.claude/huddle`, even while `HUDDLE_DIR` points somewhere else.
3. **An OS flag.** After the mod creates a day's file, it runs `chflags uappnd <file>`. macOS then refuses any rewrite or truncation from any process, while appends still work. You clear it with `chflags nouappnd`.
   - *Verified 2026-11-06:* `uappnd` on a file already blocks truncate, `rm` and `mv` while `>>` still works. On the **folder** it also blocks deleting files in it (closing the gap between create and flag), and new files can still be created. `appendLine` sets it on both, on every append.
   - Any process running as you can clear it with `chflags nouappnd`, so the guard (layer 2) also denies that under the folder.

## Components (mod API, build 2.1.318)

| Piece | Mechanism | Notes |
|---|---|---|
| Tell every session about the channel | `prompt.compose` hook adds a short system-prompt section | No edits to CLAUDE.md. The section explains: post with `mcp__huddle__post`, read with `mcp__huddle__read`, read only when relevant or mentioned. Skipped under `--bare` |
| `post(text)` tool, seen as `mcp__huddle__post` | `$.tool.register` in `session.start`, served by a `tool.call` hook | Formats the entry, then one `/bin/sh` call with positional args: `mkdir -p`, `>>`, `chflags uappnd` on the file and folder. No shell injection. Signs with the session's name from `claude agents --json` |
| `read(days=1, tail=50)` tool, seen as `mcp__huddle__read` | same | `tail -n` of today's file. With `days=2`, yesterday first, each day headed `## YYYY-MM-DD`. `tail` is capped at 200 |
| No permission prompts | `tool.check` hooks answer `allow` for both tools | Plan mode still asks, since a hook can only tighten there |
| `HUDDLE_DIR` env | overrides `~/.claude/huddle` | For testing without touching the real channel |
| @mention delivery | After the append, parse `@name`, resolve it case-insensitively through `claude agents --json`, and `$.session.send({ to: { sessionId }, text })` to every match | A shared name reaches every session that has it. This session and `@you` are skipped. Unknown names and failed deliveries go in the tool result and a toast; the post stands either way. The sessions list is cached 10s and also gives the author's name |
| Panel | `$.ui.open({ id: 'huddle', title: 'Huddle' })` plus a `ui.render` hook on `Pane` | Shows the feed (the tail of today's file), a post box and the session list |
| Live feed | `$.clock.every(2000)` checks the day file's `mtimeMs` and re-reads it only when that or the day changed | There is no fs watch API, so each tick is one stat call. It runs only while the pane is open: the first tick after `$.ui.panes()` stops listing it cancels the timer, and `session.start` restarts it after a reload |
| Post box | `Input` with `onInput` tracking a `draft` atom and `onSubmit` posting as `you` | Clearing `draft` after a post empties the field. Mention problems and failures show as one dim line under the feed |
| Session list | `claude agents --json` through the same 10s cache as posts. The CLI runs as `$CLAUDE_CODE_EXECPATH` (the session's own binary; the desktop app and VS Code bundle it off the PATH), then `claude` on the PATH. Where neither runs, the ListAgents tool takes over: its header names this session, rows are sent to as `name [ref]`, and Stop is hidden. Verified with a session started with no `claude` on its PATH | A collapsible `▸ Sessions: N, M busy` header. Background sessions first, then newest. It takes at most half the pane, with `+N more` for the rest. This session is marked |
| Stop | `$.process.run(["claude", "stop", row.id])`, the short id | Background sessions only, never this one. A toast confirms it with the `claude attach <id>` command to resume. A failure shows its reason under the feed and the row stays |
| `/huddle` command | `$.command.register` and a `command.run` hook | Opens the panel |
| Panel state | `atom`s declared in `types/index.d.ts` | `feed` (day, lines, mtime; shape `feed-1`), `draft`, `notice`. The session list comes in step 6 |

## File layout

```
huddle/
  .claude-plugin/plugin.json      name, version, description, "types"
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              tools, guard hooks, prompt section; the one session.start
  hooks/channel.ts                post, read, sessions, mentions (on $)
  hooks/panel.tsx                 /huddle, the pane, polling
  hooks/guard.ts                  Bash and path rules (pure)
  hooks/huddle.ts                 path, format, append, tail, mention helpers (pure, testable)
  types/index.d.ts                PluginState for the panel atoms
  hooks/huddle.test.ts           claude plugin test
  README.md
```

## Open questions (findings, 2026-11-06)

1. **The session's own name.** There is no `$.session.name()`. Answer: `$.session.id()`, then find that `sessionId` in `claude agents --json` and take its `name`. Look it up at post time, not once at start, because names change and repeat. ListAgents' header ("This session is huddle-5a [2195f3]") is a fallback.
2. **`claude agents` / `claude stop`.** `claude agents --json` gives `[{ pid, cwd, kind, startedAt, sessionId, name, status }]` and includes this session. `claude stop <id>` is for **background** sessions only. **Verified 2026-11-06 with a throwaway `claude --bg` session:** background rows carry a short `id` (`06853d63`); `claude stop 06853d63` printed `stopped 06853d63` and the row left the list, while the full `sessionId` gave "No job matching". Interactive rows have no `id`. **Decided:** Stop only for background sessions; interactive rows show status and nothing to press.
3. **The post box.** `Input` (`key`, `onSubmit(value)`, optional `rows`) is in all four surface tables: terminal, desktop, vscode, mobile.
4. **Retention.** Proposed: keep forever, since the files are tiny. Pruning would have to clear `uappnd` on the folder and the file first.
5. **Who reads a mention.** Proposed: leave `crossSessionInbound` alone. It is a global setting covering all cross-session messages, and it is not in the mod API types.
6. **Names repeat** (new). Two live sessions are both `coachcard-be`, and a bare-name `$.session.send` is refused with "several by it". **Decided:** resolve `@name` to `{ sessionId }` through `claude agents --json` and deliver to every match.
7. **Reach** (new). `--plugin-dir` loads the mod in one session. For "every local session", name the folder in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`, or install it from a folder marketplace.

## Build order

1. ✅ `huddle.ts` helpers and their tests: path for a date, entry formatting, append, tail.
2. ✅ The `post` and `read` tools and the `prompt.compose` section. At this point sessions can already use the channel with no UI.
3. ✅ The guard hook and `uappnd`.
4. ✅ @mention delivery through `$.session.send`.
5. ✅ The panel: feed and post box.
6. ✅ The panel's session list and Stop button.

## Developing it

- In the new repo: `claude --plugin-dir ./huddle`. The folder hot-reloads while you edit.
- `claude plugin validate ./huddle`, `tsc -p ./huddle`, `claude plugin test ./huddle`.
- Run with `claude --debug` to see hooks that were skipped and why.
- Type reference: after the first load, `.claude-plugin/types/claude-code/index.d.ts`. Grep it for `'tool.call'`, `Pane: {`, `session.send`, `tool.register`.
- Docs: <https://code.claude.com/docs/en/plugins/mods/overview.md>, <https://code.claude.com/docs/en/cross-session-messaging.md>, <https://code.claude.com/docs/en/agent-view.md>
