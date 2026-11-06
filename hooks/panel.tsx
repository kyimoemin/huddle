import { atom, read, update } from 'claude-code'
import type { On, Timer } from 'claude-code'
import type { Feed, Peer } from '../types'
import { PERSON_ICON, addMention, effortBadge, isMentionable, compactTokens, dayFile, handle, localDay, sessionIcon, tailFile } from './huddle'
import { focusPeer } from './focus'
import { type $, channelDir, deliverMentions, errorText, forgetSessions, peerStatuses, post, runClaude, runner, sessions } from './channel'

export const PANE = 'huddle'
/**
 * The commands that open the pane. `/huddle` is also the name of huddle's MCP
 * server, which the VS Code extension's `/` menu lists as a row of its own, so
 * Enter there can open the server's settings instead: `/huddle-panel` names
 * only the pane.
 */
export const OPEN_COMMANDS = ['huddle', 'huddle-panel'] as const
const TITLE = '#huddle'
const POLL_MS = 2000
const FEED_LINES = 200
/** Rows the pane keeps below the feed: the notice and a one-line post box. */
const BELOW_FEED = 3
/** The most lines the post box grows to before its text scrolls within. */
const MAX_POST_ROWS = 3
/**
 * The fewest lines the post box takes off the terminal: a one-row `Input` is a
 * single-line field there, which submits on Shift+Enter and never wraps.
 */
const MIN_REMOTE_POST_ROWS = 2
/**
 * The post box's width off the terminal, in cells of the surface's code font:
 * about 300 px. A percentage width does not hold there.
 */
export const REMOTE_POST_COLUMNS = 40
/** Columns of the pane the post box's own chrome takes (its prompt mark and `post` label). */
const POST_CHROME = 8
/** The session list's header row. */
const HEADER_ROWS = 1
/** The divider and day header between the list and the feed. */
const DIVIDER_ROWS = 2
/** Rows a long post shows until opened, plus its `more` row. */
const COLLAPSED_ROWS = 3
/** How long a notice stays under the feed. */
const NOTICE_MS = 30_000
/** Author colours: one per name, the same in every panel. */
const AUTHOR_COLORS = ['#e07a5f', '#81b29a', '#e9c46a', '#7aa2f7', '#bb9af7', '#7dcfff', '#ff9e64', '#9ece6a']

// Change the tag when Feed's fields change: a value an earlier version stored
// outlives a reload, and the tag makes this code read it as the initial value.
const feed = atom({ plugin: 'huddle', key: 'feed' } as const, { day: '', lines: [], mtimeMs: -1 } as Feed, {
  shape: 'feed-1',
})
const draft = atom({ plugin: 'huddle', key: 'draft' } as const, '')
const typing = atom({ plugin: 'huddle', key: 'typing' } as const, '')
const postRows = atom({ plugin: 'huddle', key: 'postRows' } as const, 1)
const notice = atom({ plugin: 'huddle', key: 'notice' } as const, '')
const peers = atom({ plugin: 'huddle', key: 'peers' } as const, [] as Peer[], { shape: 'peers-5' })
const expanded = atom({ plugin: 'huddle', key: 'expanded' } as const, [] as string[])
const showPeers = atom({ plugin: 'huddle', key: 'showPeers' } as const, true)

/** Background sessions first (the ones Stop applies to), then newest first. */
export function sortPeers(rows: readonly Peer[]): Peer[] {
  const isBg = (row: Peer) => (row.kind === 'background' ? 0 : 1)
  return [...rows].sort((a, b) => isBg(a) - isBg(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/** How long ago, in the largest whole unit: `45s`, `12m`, `3h`, `7d`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** Context fill at which a row's figure turns to the warning color. */
const CONTEXT_WARN = 80
/** How long after a post its session shows as talking. */
export const TALK_MS = 10 * 60_000

/**
 * Re-reads the session list (cached 10s) and each session's status (context
 * fill, last post), writing them only when a row changed.
 */
export async function refreshPeers($: $): Promise<void> {
  let rows: Peer[]
  const now = await $.clock.now()
  try {
    const listed = await sessions($)
    // The list stands without the figures.
    const status = await peerStatuses($, listed).catch(() => new Map<string, never>())
    rows = sortPeers(
      listed.map(({ sessionId, name, kind, status: state, id, startedAt, cwd, pid }) => {
        const { context, post: last, effort } = status.get(sessionId) ?? {}
        // Dropped once old, so the row's arrow goes with the next poll.
        const post = last && now - last.at < TALK_MS ? last : undefined
        const project = cwd?.split('/').filter(Boolean).at(-1)
        return {
          sessionId,
          name,
          kind,
          status: state,
          id,
          startedAt,
          ...(project ? { project } : {}),
          ...(cwd ? { cwd } : {}),
          ...(typeof pid === 'number' ? { pid } : {}),
          ...(context ? { context } : {}),
          ...(effort ? { effort } : {}),
          ...(post ? { post } : {}),
        }
      }),
    )
  } catch {
    return
  }
  const current = await read($, peers)
  // Rewritten when a row changed, and every half minute so the ages move.
  if (JSON.stringify(current) !== JSON.stringify(rows) || now - lastPeersWrite >= AGES_MS) {
    lastPeersWrite = now
    await update($, peers, () => rows)
  }
}

const AGES_MS = 30_000
let lastPeersWrite = 0

/** Columns of a session row's right side, so every row's bar, figure and age line up. */
const EFFORT_COLUMNS = 3
const BAR_COLUMNS = 10
const PERCENT_COLUMNS = 5
const AGE_COLUMNS = 3

/** How much of the bar is filled: `percent` held to 0 to 100. */
export function barFill(percent: number): string {
  return `${Math.min(100, Math.max(0, percent))}%`
}

/** Whether `name` is one of the names a post mentioned. */
const mentions = (to: readonly string[], name: string) =>
  to.some((tag) => tag.toLowerCase() === name.toLowerCase() || tag.toLowerCase() === handle(name).toLowerCase())

/**
 * Who each session is talking with: the sessions (and `you`) its last post
 * (within TALK_MS) mentioned, and the sessions whose last post mentioned it.
 * A name no other listed session has reached nobody, so it is left out.
 */
export function conversations(everyone: readonly Peer[], now: number): Map<string, { to: string[]; from: string[] }> {
  const recent = everyone.filter((peer) => peer.post && now - peer.post.at < TALK_MS)
  const out = new Map<string, { to: string[]; from: string[] }>()
  for (const peer of everyone) {
    const others = everyone.filter((other) => other.sessionId !== peer.sessionId)
    const to = recent.includes(peer)
      ? peer.post!.to.filter((tag) => tag.toLowerCase() === 'you' || others.some((other) => mentions([tag], other.name)))
      : []
    const from = [
      ...new Set(recent.filter((other) => other !== peer && mentions(other.post!.to, peer.name)).map((other) => other.name)),
    ]
    if (to.length > 0 || from.length > 0) out.set(peer.sessionId, { to, from })
  }
  return out
}

/** A post body cut into plain text and @mentions, to draw the mentions apart. */
export function splitMentions(body: string): { text: string; isMention?: true }[] {
  const parts: { text: string; isMention?: true }[] = []
  let at = 0
  for (const match of body.matchAll(/(^|[\s([{])(@[A-Za-z0-9][\w.-]*[A-Za-z0-9]|@[A-Za-z0-9])/g)) {
    const start = match.index! + match[1]!.length
    if (start > at) parts.push({ text: body.slice(at, start) })
    parts.push({ text: match[2]!, isMention: true })
    at = start + match[2]!.length
  }
  if (at < body.length) parts.push({ text: body.slice(at) })
  return parts
}

/** The icon beside an author in the feed: the person's, or the one session of that name's. */
export function authorIcon(name: string, everyone: readonly Peer[]): string | undefined {
  if (name === 'you') return PERSON_ICON
  const named = everyone.filter((peer) => peer.name === name)
  return named.length === 1 ? sessionIcon(named[0]!.sessionId) : undefined
}

/**
 * Stops a background session with `claude stop <id>`; its conversation is
 * kept (`claude attach <id>` resumes it). Interactive sessions have no id
 * and are never stopped from here.
 */
export async function stopPeer($: $, peer: Peer): Promise<void> {
  if (peer.kind !== 'background' || !peer.id) return
  let ran: { exitCode: number; stdout: string; stderr: string }
  try {
    ran = await runClaude($, ['stop', peer.id], 15_000)
  } catch (error) {
    ran = { exitCode: -1, stdout: '', stderr: errorText(error) }
  }
  const { exitCode, stdout, stderr } = ran
  if (exitCode === 0) {
    await update($, notice, () => '')
    $.ui.toast(`Stopped ${peer.name}. Resume it with: claude attach ${peer.id}`)
  } else {
    await say($, `Could not stop ${peer.name}: ${(stderr || stdout).trim()}`)
  }
  forgetSessions()
  await refreshPeers($)
}

/**
 * Re-reads today's file when its mtime or the day changed since the feed was
 * read; `force` re-reads anyway. One stat call when nothing changed.
 */
export async function refresh($: $, force = false): Promise<void> {
  const at = new Date()
  const day = localDay(at)
  const file = dayFile(await channelDir($), at)
  let mtimeMs = 0
  try {
    mtimeMs = (await $.fs.stat(file)).mtimeMs
  } catch {
    // No post today yet.
  }
  const current = await read($, feed)
  if (!force && current.day === day && current.mtimeMs === mtimeMs) return
  const lines = mtimeMs === 0 ? [] : await tailFile(runner($), file, FEED_LINES)
  await update($, feed, () => ({ day, lines, mtimeMs }))
}

let poll: Timer | undefined

/** Polls the day file while the pane is open; the first tick after it closes stops. */
function ensurePolling($: $): void {
  if (poll) return
  poll = $.clock.every(POLL_MS, () => {
    void (async () => {
      const isOpen = (await $.ui.panes()).some((pane) => pane.id === PANE)
      if (!isOpen) {
        poll?.cancel()
        poll = undefined
        return
      }
      await refresh($)
      await refreshPeers($)
    })().catch(() => {})
  })
}

async function openPane($: $): Promise<boolean> {
  await refresh($, true)
  await refreshPeers($)
  // The box draws `draft`; bring back what was typed before the pane closed.
  const typed = await read($, typing)
  await update($, draft, () => typed)
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
  ensurePolling($)
  return isPlaced
}

/** The pane's width at its last draw, which sizes the post box. */
let paneColumns = 80

/** How many lines `text` takes in a post box `columns` wide: 1 to MAX_POST_ROWS. */
export function postRowsFor(text: string, columns: number): number {
  const width = Math.max(1, columns - POST_CHROME)
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / width)), 0)
  return Math.min(MAX_POST_ROWS, lines)
}

/**
 * Notes what the person typed. Nothing drawn reads it, so a keystroke redraws
 * nothing: drawing each one back as `value` resets the field to a text one
 * keystroke late, which drops the newest character and moves the cursor.
 * Only a change in the box's height redraws.
 */
function noteTyping($: $, text: string): Promise<void> {
  // One at a time, so a slow earlier keystroke can't land after a later one.
  typingQueue = typingQueue
    .then(async () => {
      await update($, typing, () => text)
      const rows = postRowsFor(text, paneColumns)
      if (rows !== (await read($, postRows))) await update($, postRows, () => rows)
    })
    .catch(() => {})
  return typingQueue
}
let typingQueue: Promise<void> = Promise.resolve()

/** Puts `text` in the post box, replacing what the person typed. */
async function setPostBox($: $, text: string): Promise<void> {
  // The field takes a value only when it differs from the last one drawn: when
  // the person edited away from that text, draw what they have first.
  const typed = await read($, typing)
  if (text === (await read($, draft)) && typed !== text) await update($, draft, () => typed)
  await update($, draft, () => text)
  await noteTyping($, text)
}

/**
 * Shows one line under the feed until another replaces it; with `fades`, it
 * also clears itself after NOTICE_MS (a newer notice, even the same words, is
 * left alone).
 */
async function say($: $, text: string, fades = false): Promise<void> {
  const shown = ++notices
  await update($, notice, () => text)
  if (!fades || text === '') return
  $.clock.after(NOTICE_MS, () => {
    if (notices === shown) void update($, notice, () => '').catch(() => {})
  })
}
let notices = 0

/**
 * The notice for a post's undelivered mentions: one short line naming them
 * (`⚠ @a, @b not notified`); the full reasons went to a toast.
 */
export function mentionNotice(undelivered: readonly string[]): string {
  return undelivered.length > 0 ? `⚠ ${undelivered.map((name) => `@${name}`).join(', ')} not notified` : ''
}

/**
 * How a post draws in the feed `columns` wide: cut to about COLLAPSED_ROWS
 * rows unless opened (`isLong`, with an ellipsis), and the rows it takes,
 * its `more` row included. The cut leaves slack for word wrap and wide icons.
 */
export function postLayout(prefix: string, body: string, columns: number, isOpen: boolean): { body: string; isLong: boolean; rows: number } {
  const width = Math.max(1, columns)
  const length = [...prefix].length + [...body].length
  const wraps = Math.max(1, Math.ceil(length / width))
  if (wraps <= COLLAPSED_ROWS) return { body, isLong: false, rows: wraps }
  if (isOpen) return { body, isLong: true, rows: wraps + 1 }
  const slack = Math.ceil(width / 5)
  const room = Math.max(0, COLLAPSED_ROWS * (width - slack) - [...prefix].length - 1)
  return { body: `${[...body].slice(0, room).join('')}…`, isLong: true, rows: COLLAPSED_ROWS + 1 }
}

/** What a post's time and author take before its body. */
const postPrefix = (time: string, author: string) => `${time} ${author} `

/** An author's colour, fixed by name. */
export function authorColor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!
}

/** Posts what the person typed, signed `you`, and delivers its mentions. */
export async function submit($: $, text: string): Promise<void> {
  if (text.trim() === '') return
  await setPostBox($, '')
  try {
    const line = await post($, 'you', text)
    const { undelivered } = await deliverMentions($, 'you', text, line, true)
    await say($, mentionNotice(undelivered), true)
  } catch (error) {
    await setPostBox($, text)
    await say($, `Not posted: ${errorText(error)}`)
  }
  await refresh($, true)
}

type Row = { time: string; name: string; body: string } | { raw: string }

/** Splits `- 14:32 **name**: text` into its parts; anything else is drawn as is. */
export function parseRow(line: string): Row {
  const match = /^- (\d\d:\d\d) \*\*(.+?)\*\*: (.*)$/.exec(line)
  return match ? { time: match[1]!, name: match[2]!, body: match[3]! } : { raw: line }
}

/**
 * The newest lines that fit `rows` rows `columns` wide, oldest first; each
 * line counts the rows it wraps to.
 */
export function fitLines(
  lines: readonly string[],
  rows: number,
  columns: number,
  rowsOf: (line: string) => number = (line) => Math.max(1, Math.ceil([...line].length / Math.max(1, columns))),
): string[] {
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const cost = rowsOf(line)
    if (used + cost > rows && kept.length > 0) break
    kept.unshift(line)
    used += cost
  }
  return kept
}

/** The panel's part of `session.start`: the commands that open it, and polling again after a reload. */
export async function startPanel($: $): Promise<void> {
  for (const name of OPEN_COMMANDS) {
    await $.command.register({ name, description: 'Open #huddle: the channel every local session shares' })
  }
  // A reload keeps the pane up but drops timers: start polling again.
  if ((await $.ui.panes()).some((pane) => pane.id === PANE)) {
    await refresh($, true)
    await refreshPeers($)
    ensurePolling($)
  }
}

export function registerPanel(on: On): void {
  for (const command of OPEN_COMMANDS) {
    on('command.run', { command }, async ($) => {
      const isPlaced = await openPane($)
      return { text: isPlaced ? '#huddle opened.' : '#huddle opens when the window is wide enough.' }
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const { lines } = await read($, feed)
    const typed = await read($, draft)
    // Off the terminal the box is always a text area, so Shift+Enter types a newline.
    const rows = e.surface === 'terminal' ? await read($, postRows) : Math.max(MIN_REMOTE_POST_ROWS, await read($, postRows))
    const problem = await read($, notice)
    const everyone = await read($, peers)
    const isListOpen = await read($, showPeers)
    const opened = new Set(await read($, expanded))
    const selfId = await $.session.id()
    const now = await $.clock.now()

    const bodyRows = e.props.scroll.bodyRows
    // Off the terminal the box is a fixed width, at most the pane's; its rows are counted at that width.
    const postColumns = e.surface === 'terminal' ? e.props.bodyColumns : Math.min(REMOTE_POST_COLUMNS, e.props.bodyColumns)
    paneColumns = postColumns
    // The list takes at most half the pane; the rest is the feed's.
    const listRoom = Math.max(1, Math.floor(bodyRows / 2) - HEADER_ROWS)
    const listed = isListOpen ? everyone.slice(0, everyone.length > listRoom ? listRoom - 1 : listRoom) : []
    const hidden = isListOpen ? everyone.length - listed.length : 0
    const listRows = HEADER_ROWS + listed.length + (hidden > 0 ? 1 : 0) + DIVIDER_ROWS
    const columns = e.props.bodyColumns
    const authorOf = (name: string) => [authorIcon(name, everyone), name].filter(Boolean).join(' ')
    // One layout per line, so the room counted is the room drawn; a line that is no post is drawn whole.
    const layoutOf = (line: string) => {
      const row = parseRow(line)
      if ('raw' in row) return { rows: Math.max(1, Math.ceil([...row.raw].length / Math.max(1, columns))) }
      return postLayout(postPrefix(row.time, authorOf(row.name)), row.body, columns, opened.has(line))
    }
    const shown = fitLines(lines, Math.max(1, bodyRows - BELOW_FEED - (rows - 1) - listRows), columns, (line) => layoutOf(line).rows)
    const busy = everyone.filter((peer) => peer.status === 'busy').length
    const talks = conversations(everyone, now)
    const header = [`Sessions ${everyone.length}`, busy > 0 ? `${busy} busy` : '', talks.size > 0 ? `${talks.size} talking` : '']
      .filter(Boolean)
      .join(' · ')

    return (
      // The feed shrinks and clips its oldest posts, so the post box stays in view
      // where the rows counted above miss what a surface draws (desktop's
      // proportional text and margins).
      <Box flexDirection="column" height={e.surface === 'terminal' ? undefined : '100%'}>
        <Button
          key="peers"
          plain
          label={`${isListOpen ? '▾' : '▸'} ${header}`}
          onPress={() => void update($, showPeers, (open) => !open)}
        />
        {listed.map((peer) => {
          const isSelf = peer.sessionId === selfId
          const isBusy = peer.status === 'busy'
          const { percent, tokens, estimated } = peer.context ?? {}
          const talk = talks.get(peer.sessionId)
          const isFull = percent !== undefined && percent >= CONTEXT_WARN
          const effort = effortBadge(peer.effort)
          return (
            <Box key={`peer-${peer.sessionId}`} flexDirection="row" gap={1}>
              <Text color={isBusy ? 'warning' : undefined} dimColor={!isBusy}>
                {isBusy ? '●' : '○'}
              </Text>
              <Button
                key={`focus-${peer.sessionId}`}
                plain
                label={sessionIcon(peer.sessionId)}
                onPress={() =>
                  void focusPeer($, peer)
                    .then((problem) => (problem ? say($, problem) : undefined))
                    .catch(() => {})
                }
              />
              <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button
                key={`mention-${peer.sessionId}`}
                plain
                dimColor={!isBusy}
                label={peer.name}
                onPress={() =>
                  void (isMentionable(peer.name)
                    ? read($, typing).then((typed) => setPostBox($, addMention(typed, peer.name)))
                    : say($, `${peer.name} can't be @mentioned: a mention is letters, digits, . _ and -`))
                }
              />
              {isSelf && (
                <Text backgroundColor="suggestion" color="inverseText" size="caption">
                  you
                </Text>
              )}
              <Text dimColor wrap="truncate">
                {[peer.project ?? '', peer.kind === 'background' ? 'bg' : '']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {talk && (
                <Text color="suggestion">
                  {[
                    talk.to.length > 0 ? `→ ${talk.to.map((name) => `@${name}`).join(' ')}` : '',
                    talk.from.length > 0 ? `← ${talk.from.join(', ')}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </Text>
              )}
              {peer.kind === 'background' && peer.id && !isSelf && (
                <Button key={`stop-${peer.id}`} label="stop" onPress={() => void stopPeer($, peer)} />
              )}
              </Box>
              <Box width={EFFORT_COLUMNS} flexShrink={0} justifyContent="flex-end">
                {effort && <Text dimColor>{effort}</Text>}
              </Box>
              <Box width={BAR_COLUMNS} flexShrink={0}>
                {percent !== undefined ? (
                  <Box key={`bar-${peer.sessionId}`} width={BAR_COLUMNS} height={1} backgroundColor="subtle" overflow="hidden">
                    <Box width={barFill(percent)} height="100%" backgroundColor={isFull ? 'warning' : 'suggestion'} />
                  </Box>
                ) : (
                  <Text dimColor wrap="truncate">
                    {tokens !== undefined ? `~${compactTokens(tokens)} tok` : 'no data'}
                  </Text>
                )}
              </Box>
              <Box width={PERCENT_COLUMNS} flexShrink={0} justifyContent="flex-end">
                {percent !== undefined && (
                  <Text tabular dimColor={!isFull} color={isFull ? 'warning' : undefined}>
                    {estimated ? '~' : ''}
                    {percent}%
                  </Text>
                )}
              </Box>
              <Box width={AGE_COLUMNS} flexShrink={0} justifyContent="flex-end">
                {peer.startedAt ? (
                  <Text tabular dimColor>
                    {ago(now - peer.startedAt)}
                  </Text>
                ) : null}
              </Box>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
        <Text dimColor wrap="truncate">
          {'─'.repeat(Math.max(1, columns))}
        </Text>
        <Text dimColor size="caption">
          Today
        </Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" justifyContent="flex-end">
          {shown.length === 0 && <Text dimColor>No posts today. Write one below; click a name to mention it.</Text>}
          {shown.map((line, i) => {
            const row = parseRow(line)
            if ('raw' in row) {
              return (
                <Text key={`line-${i}`} wrap="wrap">
                  {row.raw}
                </Text>
              )
            }
            const author = authorOf(row.name)
            const isOpen = opened.has(line)
            const { body, isLong } = postLayout(postPrefix(row.time, author), row.body, columns, isOpen)
            return (
              <Box key={`line-${i}`} flexDirection="column" marginBottom="sm">
                <Text wrap="wrap">
                  <Text dimColor size="caption">
                    {row.time}
                  </Text>{' '}
                  <Text bold color={authorColor(row.name)}>
                    {author}
                  </Text>{' '}
                  {splitMentions(body).map((part, j) =>
                    part.isMention ? (
                      <Text key={`m-${j}`} bold color="suggestion">
                        {part.text}
                      </Text>
                    ) : (
                      part.text
                    ),
                  )}
                </Text>
                {isLong && (
                  <Button
                    key={`more-${i}`}
                    plain
                    dimColor
                    label={isOpen ? 'less' : 'more'}
                    onPress={() =>
                      void update($, expanded, (open) =>
                        open.includes(line) ? open.filter((kept) => kept !== line) : [...open, line].slice(-50),
                      )
                    }
                  />
                )}
              </Box>
            )
          })}
        </Box>
        {problem !== '' && <Text dimColor>{problem}</Text>}
        <Box key="post-row" width={e.surface === 'terminal' ? '100%' : postColumns} flexShrink={0}>
        <Input
          key="post"
          placeholder="Message #huddle · @name to mention"
          value={typed}
          rows={rows}
          submitLabel="post"
          onInput={(value) => void noteTyping($, value)}
          onSubmit={(value) => void submit($, value)}
        />
        </Box>
      </Box>
    )
  })
}
