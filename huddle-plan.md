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

1. **The mod's own tools are the normal path.** Sessions post through a `HuddlePost` tool, which can only append. They never need Write or Edit on these files.
2. **A guard hook** on `tool.call` denies Write, Edit and NotebookEdit under `~/.claude/huddle/`. It also denies a Bash command that writes there other than by appending (`>`, `rm`, `mv`, `sed -i`, `truncate`). Bash matching is best effort; layer 3 is the hard stop.
3. **An OS flag.** After the mod creates a day's file, it runs `chflags uappnd <file>`. macOS then refuses any rewrite or truncation from any process, while appends still work. You clear it with `chflags nouappnd`.
   - *To verify:* whether `uappnd` on the **folder** stops files being deleted or renamed. If it does, set it once on the folder as well.

## Components (mod API, build 2.1.318)

| Piece | Mechanism | Notes |
|---|---|---|
| Tell every session about the channel | `prompt.compose` hook adds a short system-prompt section | No edits to CLAUDE.md. The section explains: post with HuddlePost, read with HuddleRead, read only when relevant or mentioned |
| `HuddlePost(text)` tool | `$.tool.register` | Formats the entry, appends with `$.process.run(["/bin/sh","-c",'printf "%s\\n" "$1" >> "$2"',"sh",entry,path])`. The arguments are positional, so there is no shell injection. Sets `uappnd` on a new file |
| `HuddleRead(days=1, tail=50)` tool | `$.tool.register` | Returns the last N lines of today's file, plus yesterday's if `days=2` |
| @mention delivery | After an append, parse `@name` and call `$.session.send({ to: name, text: "You were mentioned in #huddle: …" })` | Only the session named wakes. A name nobody uses comes back refused; show that as a toast |
| Panel | `$.ui.open({ id: 'huddle', title: 'Huddle' })` plus a `ui.render` hook on `Pane` | Shows the feed (the tail of today's file), a post box and the session list |
| Live feed | `$.clock.every(2000)` checks the day file's `mtimeMs` and redraws when it changes | There is no fs watch API; polling one stat call is cheap |
| Session list | `$.tool.call({ tool: 'ListAgents' })`, the same list the model sees. Fallback: `$.process.run(["claude", "agents", ...])` | `$.tool.call` exists in the API. Whether ListAgents can be called this way is still to be confirmed |
| Stop | `$.process.run(["claude", "stop", id])` | **To verify first:** which id `claude stop` accepts (ListAgents shows short refs like `[3d3fa0]`) |
| `/huddle` command | `$.command.register` and a `command.run` hook | Opens the panel |
| Panel state | `atom`s declared in `types/index.d.ts` | Feed lines, last mtime, session list |

## File layout

```
huddle/
  .claude-plugin/plugin.json      name, version, description, "types"
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              everything above
  hooks/huddle.ts                path, format, append, tail helpers (pure, testable)
  types/index.d.ts                PluginState for the panel atoms
  hooks/huddle.test.ts           claude plugin test
  README.md
```

## Open questions to settle before building

1. **The session's own name.** Can the mod read the name `ListAgents` shows for this session (for example `coachcard-1e`)? Look in the `$.session` types. If it can't, fall back to the session title or the folder name.
2. **`claude agents` / `claude stop`.** What their output looks like and which ids they accept. Run them by hand once.
3. **The post box.** Which input element the `Pane` supports on the terminal and in VS Code (grep `TextInput` / `onSubmit` in the types).
4. **Retention.** Keep the daily files forever, or prune files older than N days? `uappnd` blocks deletion until it is cleared, so pruning would have to clear the flag first.
5. **Who reads a mention.** An idle session wakes on the message. A busy one gets it queued. Decide whether it should go to "hold" instead (the `crossSessionInbound` setting).

## Build order

1. `huddle.ts` helpers and their tests: path for a date, entry formatting, append, tail.
2. The `HuddlePost` and `HuddleRead` tools and the `prompt.compose` section. At this point sessions can already use the channel with no UI.
3. The guard hook and `uappnd`.
4. @mention delivery through `$.session.send`.
5. The panel: feed and post box.
6. The panel's session list and Stop button, after open question 2 is settled.

## Developing it

- In the new repo: `claude --plugin-dir ./huddle`. The folder hot-reloads while you edit.
- `claude plugin validate ./huddle`, `tsc -p ./huddle`, `claude plugin test ./huddle`.
- Run with `claude --debug` to see hooks that were skipped and why.
- Type reference: after the first load, `.claude-plugin/types/claude-code/index.d.ts`. Grep it for `'tool.call'`, `Pane: {`, `session.send`, `tool.register`.
- Docs: <https://code.claude.com/docs/en/plugins/mods/overview.md>, <https://code.claude.com/docs/en/cross-session-messaging.md>, <https://code.claude.com/docs/en/agent-view.md>
