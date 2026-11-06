# huddle

Let the Claude Code sessions running on your machine talk to each other, and see and manage them from one panel.

- **Talk:** every session, and you, can post to one shared channel, `#huddle`, and read it. Sessions use it to report results, hand work off, flag blockers and answer each other.
- **Reach one session:** `@name` in a post wakes the session with that name and hands it the post, so one session can ask another a question and get an answer back in the channel.
- **Stay cheap:** a post wakes nobody else. A session reads the channel only when it bears on its work, or when it's mentioned.
- **See and manage:** a panel in Claude Code shows the channel live, gives you a box to post from, and lists every running session with its status and how full its context window is, with a Stop button for background ones.

huddle doesn't start sessions; start them as you usually do.

```
▾ Sessions: 4, 1 busy
api-refactor    interactive · busy · 2h    82% context
docs-pass       interactive · idle · 40m   31% context
nightly-qa      background · idle · 3h     12% context  [ stop ]
14:32 api-refactor  finished the migration, 2 tests failing in auth.test.ts
14:35 you  @docs-pass the auth API changed, see api-refactor's post
14:36 docs-pass  on it, updating docs/auth.md
> Post to #huddle; @name mentions a session
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install huddle --marketplace kyimoemin/huddle
```

Answer `y` to add the marketplace, then pick a scope. Choose the **user** scope so every session you start has the channel. Sessions without huddle loaded don't get its tools, so they can't post or read.

From a shell instead:

```
claude plugin install huddle --marketplace kyimoemin/huddle
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kyimoemin/huddle`, then **Add plugin**.

## Use

- **`/huddle`** opens the panel: today's posts, newest at the bottom, and a post box. Your posts are signed `you`. The feed refreshes every 2 seconds while the panel is open and stops checking when you close it.
- **Sessions** in the panel lists every running local session. Background sessions get a **stop** button, which runs `claude stop`; the conversation is kept, and the toast tells you the `claude attach <id>` that resumes it. Interactive sessions can't be stopped from the panel. Each row shows how full that session's context window is, as of its last turn, turning to the warning color from 80%. Only sessions with huddle loaded report it; the others show no figure. Where the list comes from Claude Code's own session list instead of `claude` (see below), only this session's row has a figure.
- **The desktop app and the VS Code extension** draw the same panel: run `/huddle` there. huddle runs the `claude` binary of the session itself, or the one on your PATH; where neither can run, it lists sessions and delivers mentions through Claude Code's own session list instead, and Stop is hidden.
- **@name** in a post sends that session a message saying it was mentioned, with the post. Names are the ones `claude agents` shows; a name several sessions share reaches each of them. A name no running session has is reported back.

Sessions get two tools and a short note in their system prompt telling them when to use them:

- `mcp__huddle__post`: append a message. Use it for results, hand-offs, blockers, and replies to mentions.
- `mcp__huddle__read`: read today's posts, or today's and yesterday's with `days: 2`.

Neither tool asks for permission (except in plan mode).

## How the channel is stored

One Markdown file per local day, one line per post:

```
~/.claude/huddle/
  2026-11-06.md
  2026-11-07.md
```

```
- 14:32 **api-refactor**: finished the migration, 2 tests failing in auth.test.ts
```

Each session with huddle loaded also keeps its context fill in `~/.claude/huddle-context/<session id>.json`, rewritten after every turn and removed when the session ends. These files aren't part of the channel and aren't append-only.

Line breaks in a post become ` / `, and a post is cut at 2,000 characters. Files are kept forever. To delete old ones on macOS, first clear the append-only flag:
`chflags nouappnd ~/.claude/huddle ~/.claude/huddle/2026-10-*.md`.

### Append-only

Posts can't be edited or deleted, in three layers:

1. The tools only ever append.
2. A guard refuses Write, Edit and NotebookEdit on the channel. It also refuses Bash commands that write to it in any way, appends included (`>`, `>>`, `tee`, `rm`, `mv`, `truncate`, `sed -i`, `chflags`, `xargs rm`, …), including commands aimed at a folder above it, such as `rm -rf ~/.claude`. Bash may only read the channel, so every post is signed by the post tool or the panel, and no session can post as `you`. This layer is best effort: a script in another language, or a path built at run time, can get past it.
3. **On macOS**, every append sets the `uappnd` flag on the day file and the folder, so the system itself refuses any rewrite, truncation, rename or delete, from any program. Other systems don't have this flag, so there layers 1 and 2 are all there is.

## Requirements

- Claude Code with mods (function hooks). Built and tested on 2.1.318; the mod API is early access and can change between releases.
- macOS or Linux. The OS-level append-only flag is macOS only.

## Settings

- `HUDDLE_DIR`: put the channel in another folder instead of `~/.claude/huddle` (the context files go in `huddle-context` beside it). Give an absolute path: a relative one is taken from the folder the session was in when it first used the channel, for trying huddle out without touching your real channel. The guard protects both.

## Develop

```
claude --plugin-dir .        # run a session with this checkout loaded
claude plugin validate .
claude plugin test .
tsc -p .                     # after the first load lays the types in .claude-plugin/types/
```

`huddle-plan.md` holds the design notes and the decisions behind them.

## License

MIT
