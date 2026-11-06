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
/** Columns of the pane the post box's own chrome takes (its prompt mark and `post` label). */
const POST_CHROME = 8
/**
 * Columns the post row takes beside the field: the `@` button and its gap,
 * and off the terminal the border, padding and Send button too.
 */
const TERMINAL_ROW_CHROME = 2
const REMOTE_ROW_CHROME = 13
/** The session list's header row: its toggle, filter and counts. */
const HEADER_ROWS = 1
/** The `── Today ──` rule between the list and the feed. */
const DIVIDER_ROWS = 1
/** Rows a long post shows until opened, plus its `more` row. */
const COLLAPSED_ROWS = 3
/** Pane columns from which the sessions move to a sidebar beside the feed. */
export const WIDE_COLUMNS = 100
/** The sidebar's columns in the wide layout. */
const SIDEBAR_COLUMNS = 32
/** How long a notice stays under the feed. */
const NOTICE_MS = 30_000
/** The most sessions the @ suggestions list. */
const MAX_SUGGESTIONS = 5
/** Columns a post of yours is held in from the left, so it reads as yours. */
const OWN_INDENT = 6
/** Columns an author's posts are held in under their avatar, off the terminal. */
const AVATAR_INDENT = 6
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
const sessionFilter = atom({ plugin: 'huddle', key: 'sessionFilter' } as const, 'active' as 'active' | 'all')
const mentionQuery = atom({ plugin: 'huddle', key: 'mentionQuery' } as const, null as string | null)

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
      // Redraws while a mention is typed, so the suggestions follow it; other keystrokes draw nothing.
      const query = mentionQueryOf(text)
      if (query !== (await read($, mentionQuery))) await update($, mentionQuery, () => query)
    })
    .catch(() => {})
  return typingQueue
}
let typingQueue: Promise<void> = Promise.resolve()

/** Posts what the box holds, once every keystroke before the press is noted. */
async function sendTyped($: $): Promise<void> {
  await typingQueue
  await submit($, await read($, typing))
}

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

/** One post of a group: its feed line (what `expanded` keys it by), time and text. */
export type GroupPost = { line: string; time: string; body: string }
/** A run of one author's consecutive posts, or a line that is no post. */
export type Group = { raw: string } | { name: string; posts: GroupPost[] }

/** Feed lines as the feed draws them: each author's consecutive posts under one header. */
export function groupPosts(lines: readonly string[]): Group[] {
  const groups: Group[] = []
  for (const line of lines) {
    const row = parseRow(line)
    if ('raw' in row) {
      groups.push({ raw: row.raw })
      continue
    }
    const last = groups.at(-1)
    const post = { line, time: row.time, body: row.body }
    if (last && 'name' in last && last.name === row.name) last.posts.push(post)
    else groups.push({ name: row.name, posts: [post] })
  }
  return groups
}

/** A group's time: its one post's, or its first to its last (`14:56 – 15:34`). */
export function groupTime(posts: readonly GroupPost[]): string {
  const first = posts[0]?.time ?? ''
  const last = posts.at(-1)?.time ?? ''
  return first === last ? first : `${first} – ${last}`
}

/**
 * The newest groups that fit `rows` rows, oldest first: a group's posts are
 * cut from its oldest, and its header counts once for the posts kept. The
 * newest post always shows.
 */
export function fitGroups(
  groups: readonly Group[],
  rows: number,
  cost: { header: (group: Group) => number; post: (post: GroupPost, group: Group) => number; raw: (line: string) => number },
): Group[] {
  const kept: Group[] = []
  let used = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!
    if ('raw' in group) {
      const need = cost.raw(group.raw)
      if (used + need > rows && kept.length > 0) break
      kept.unshift(group)
      used += need
      continue
    }
    const posts: GroupPost[] = []
    let need = cost.header(group)
    for (let j = group.posts.length - 1; j >= 0; j--) {
      const post = group.posts[j]!
      const more = cost.post(post, group)
      if (used + need + more > rows && (kept.length > 0 || posts.length > 0)) break
      posts.unshift(post)
      need += more
    }
    if (posts.length === 0) break
    kept.unshift({ name: group.name, posts })
    used += need
    if (posts.length < group.posts.length) break
  }
  return kept
}

/** A post body cut into plain text and `code` spans, to draw the code apart. */
export function splitCode(body: string): { text: string; isCode?: true }[] {
  const parts: { text: string; isCode?: true }[] = []
  let at = 0
  for (const match of body.matchAll(/`([^`]+)`/g)) {
    if (match.index! > at) parts.push({ text: body.slice(at, match.index) })
    parts.push({ text: match[1]!, isCode: true })
    at = match.index! + match[0].length
  }
  if (at < body.length) parts.push({ text: body.slice(at) })
  return parts
}

/**
 * A session's avatar letters, at most three: the short tail of a dashed name
 * (`coachcard-5b` is `5B`), a word's first letter and a short last word
 * (`sprint 25` is `S25`), else the name's first two letters.
 */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const last = words.at(-1)!
  if (words.length > 1 && /-/.test(name) && [...last].length <= 3) return last.toUpperCase()
  if (words.length > 1) {
    const tail = [...last].length <= 2 ? last : [...last][0]!
    return `${[...words[0]!][0]!}${tail}`.toUpperCase()
  }
  return [...name].slice(0, 2).join('').toUpperCase()
}

/** What a session is doing, as its row says it: `working`, `idle`, or what `claude agents` reported. */
export function statusWord(peer: Peer): string {
  if (peer.status === 'busy') return 'working'
  return peer.status && peer.status !== 'idle' ? peer.status : 'idle'
}

/** The colour of a status word and its dot. */
const statusColor = (word: string) => (word === 'working' ? 'suggestion' : word === 'idle' ? 'inactive' : 'warning')

/** The sessions the Active filter lists: this one, and every one not idle. */
export function isActive(peer: Peer, selfId: string): boolean {
  return peer.sessionId === selfId || statusWord(peer) !== 'idle'
}

/** The `@word` typed at the end of `text`, without the `@`; `null` when the text does not end in one. */
export function mentionQueryOf(text: string): string | null {
  const match = /(?:^|[\s([{])@([A-Za-z0-9][\w.-]*)?$/.exec(text)
  return match ? (match[1] ?? '') : null
}

/** `text` with the `@word` it ends in completed to `@handle `. */
export function completeMention(text: string, name: string): string {
  return text.replace(/@[\w.-]*$/, `@${handle(name)} `)
}

/**
 * The sessions a typed `@query` could mean, at most MAX_SUGGESTIONS: names
 * that start with it first, then those that hold it; one per handle.
 */
export function suggest(everyone: readonly Peer[], query: string): Peer[] {
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const unique = everyone.filter((peer) => {
    const key = handle(peer.name).toLowerCase()
    if (!isMentionable(peer.name) || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const starts = unique.filter((peer) => handle(peer.name).toLowerCase().startsWith(q))
  const holds = unique.filter((peer) => !starts.includes(peer) && handle(peer.name).toLowerCase().includes(q))
  return [...starts, ...holds].slice(0, MAX_SUGGESTIONS)
}

/** `@` added to a draft, after a space, to start a mention. */
const startMention = (draft: string) => `${draft}${draft === '' || /\s$/.test(draft) ? '' : ' '}@`

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
    const isTerminal = e.surface === 'terminal'
    const { lines } = await read($, feed)
    const typed = await read($, draft)
    // Off the terminal the box is always a text area, so Shift+Enter types a newline.
    const rows = isTerminal ? await read($, postRows) : Math.max(MIN_REMOTE_POST_ROWS, await read($, postRows))
    const problem = await read($, notice)
    const everyone = await read($, peers)
    const isListOpen = await read($, showPeers)
    const filter = await read($, sessionFilter)
    const query = await read($, mentionQuery)
    const opened = new Set(await read($, expanded))
    const selfId = await $.session.id()
    const now = await $.clock.now()

    const bodyRows = e.props.scroll.bodyRows
    // Wide, the sessions sit in a sidebar and the feed takes the rest.
    const isWide = e.props.bodyColumns >= WIDE_COLUMNS
    const columns = isWide ? e.props.bodyColumns - SIDEBAR_COLUMNS - 1 : e.props.bodyColumns
    paneColumns = columns - (isTerminal ? TERMINAL_ROW_CHROME : REMOTE_ROW_CHROME)

    // The session list: the active sessions, the idle ones folded into one row unless All is picked.
    const active = everyone.filter((peer) => isActive(peer, selfId))
    const idle = everyone.filter((peer) => !isActive(peer, selfId))
    const candidates = filter === 'active' ? active : everyone
    const hasFold = isListOpen && filter === 'active' && idle.length > 0
    const peerRows = isTerminal ? 1 : 2
    // The list takes at most half the pane; the rest is the feed's.
    const listRoom = Math.max(1, Math.floor(bodyRows / 2) - HEADER_ROWS - (hasFold ? 1 : 0))
    const fits = Math.max(1, Math.floor(listRoom / peerRows))
    const listed = !isListOpen
      ? []
      : candidates.length > fits
        ? candidates.slice(0, Math.max(1, Math.floor((listRoom - 1) / peerRows)))
        : candidates
    const hidden = isListOpen ? candidates.length - listed.length : 0
    const listRows = isWide
      ? HEADER_ROWS + DIVIDER_ROWS
      : HEADER_ROWS + listed.length * peerRows + (hidden > 0 ? 1 : 0) + (hasFold ? 1 : 0) + DIVIDER_ROWS

    // The @ suggestions, while a mention is typed.
    const picks = query === null ? [] : suggest(everyone, query)
    const pickRows = picks.length > 0 ? 1 + picks.length : 0
    const hintRows = isTerminal ? 0 : 1

    const authorOf = (name: string) => [authorIcon(name, everyone), name].filter(Boolean).join(' ')
    // Off the terminal your bubble's padding takes a column each side.
    const widthOf = (name: string) =>
      Math.max(1, name === 'you' ? columns - OWN_INDENT - (isTerminal ? 0 : 2) : isTerminal ? columns : columns - AVATAR_INDENT)
    const layoutOf = (post: GroupPost, name: string) => postLayout('', post.body, widthOf(name), opened.has(post.line))
    const shown = fitGroups(groupPosts(lines), Math.max(1, bodyRows - BELOW_FEED - (rows - 1) - listRows - pickRows - hintRows), {
      // Yours end in their time; another author's start with a header.
      header: () => 1,
      post: (post, group) => ('name' in group ? layoutOf(post, group.name).rows : 1),
      raw: (line) => Math.max(1, Math.ceil([...line].length / Math.max(1, columns))),
    })

    const byStatus = {
      working: everyone.filter((peer) => statusWord(peer) === 'working'),
      waiting: everyone.filter((peer) => !['working', 'idle'].includes(statusWord(peer))),
      idle: everyone.filter((peer) => statusWord(peer) === 'idle'),
    }
    const working = byStatus.working.length
    const waiting = byStatus.waiting.length
    const resting = byStatus.idle.length
    const talks = conversations(everyone, now)

    const body = (text: string) =>
      splitCode(text).map((chunk, c) =>
        chunk.isCode ? (
          <Text key={`c-${c}`} mono backgroundColor="subtle">
            {chunk.text}
          </Text>
        ) : (
          // After a code span a chunk starts mid-word: an `@` there is no mention, as delivery reads it.
          (c > 0 ? splitMentions(`x${chunk.text}`).map((part, j) => (j === 0 ? { text: part.text.slice(1) } : part)) : splitMentions(chunk.text)).map((part, j) =>
            part.isMention ? (
              <Text key={`m-${c}-${j}`} bold color="warning">
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )
        ),
      )

    const avatar = (name: string, sessionId?: string) =>
      isTerminal ? (
        (sessionId ? sessionIcon(sessionId) : authorIcon(name, everyone)) ?? '·'
      ) : (
        <Text backgroundColor="subtle" weight="semibold" size="caption">
          {` ${initials(name)} `}
        </Text>
      )

    const mention = (peer: Peer) =>
      void (isMentionable(peer.name)
        ? read($, typing).then((text) => setPostBox($, addMention(text, peer.name)))
        : say($, `${peer.name} can't be @mentioned: a mention is letters, digits, . _ and -`))

    // The parts a session row has in both layouts: the list's and the wide sidebar's.
    const statusDot = (peer: Peer) => {
      const word = statusWord(peer)
      return <Text color={statusColor(word)}>{word === 'idle' ? '○' : '●'}</Text>
    }
    const focusButton = (peer: Peer) => (
      <Button
        key={`focus-${peer.sessionId}`}
        plain
        label={isTerminal ? sessionIcon(peer.sessionId) : `Show ${peer.name}`}
        onPress={() =>
          void focusPeer($, peer)
            .then((problem) => (problem ? say($, problem) : undefined))
            .catch(() => {})
        }
      >
        {avatar(peer.name, peer.sessionId)}
      </Button>
    )
    const mentionButton = (peer: Peer) => (
      <Button key={`mention-${peer.sessionId}`} plain dimColor={statusWord(peer) === 'idle'} label={peer.name} onPress={() => mention(peer)} />
    )
    const youBadge = (peer: Peer) =>
      peer.sessionId === selfId && (
        <Text backgroundColor="suggestion" color="inverseText" size="caption" weight="semibold">
          YOU
        </Text>
      )
    const stopButton = (peer: Peer) =>
      peer.kind === 'background' &&
      peer.id &&
      peer.sessionId !== selfId && <Button key={`stop-${peer.id}`} label="stop" onPress={() => void stopPeer($, peer)} />
    const percentText = (peer: Peer) => {
      const { percent, estimated } = peer.context ?? {}
      const isFull = percent !== undefined && percent >= CONTEXT_WARN
      return (
        percent !== undefined && (
          <Text tabular mono dimColor={!isFull} color={isFull ? 'warning' : undefined}>
            {estimated ? '~' : ''}
            {percent}%
          </Text>
        )
      )
    }

    const peerRow = (peer: Peer) => {
      const word = statusWord(peer)
      const { percent, tokens } = peer.context ?? {}
      const talk = talks.get(peer.sessionId)
      const isFull = percent !== undefined && percent >= CONTEXT_WARN
      const effort = effortBadge(peer.effort)
      const meta = (
        <Text dimColor wrap="truncate">
          <Text color={statusColor(word)}>{word}</Text>
          {[peer.project ?? '', peer.kind === 'background' ? 'bg' : ''].filter(Boolean).map((part) => ` · ${part}`).join('')}
        </Text>
      )
      return (
        <Box key={`peer-${peer.sessionId}`} flexDirection="row" gap={1} alignItems="center">
          {statusDot(peer)}
          {focusButton(peer)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
              {mentionButton(peer)}
              {youBadge(peer)}
              {isTerminal && meta}
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
              {stopButton(peer)}
            </Box>
            {!isTerminal && meta}
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
            {percentText(peer)}
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
    }

    let postIndex = 0
    const postBody = (post: GroupPost, name: string, isOwn: boolean) => {
      const index = postIndex++
      const isOpen = opened.has(post.line)
      const { body: text, isLong } = layoutOf(post, name)
      const more = isLong && (
        <Button
          key={`more-${index}`}
          plain
          dimColor
          label={isOpen ? 'Show less' : 'Show more'}
          onPress={() =>
            void update($, expanded, (open) =>
              open.includes(post.line) ? open.filter((kept) => kept !== post.line) : [...open, post.line].slice(-50),
            )
          }
        />
      )
      return (
        <Box key={`post-${index}`} flexDirection="column" alignItems={isOwn ? 'flex-end' : 'flex-start'}>
          {isOwn ? (
            <Box backgroundColor="subtle" paddingX={isTerminal ? 0 : 1}>
              <Text wrap="wrap">{body(text)}</Text>
            </Box>
          ) : (
            <Text wrap="wrap">{body(text)}</Text>
          )}
          {more}
        </Box>
      )
    }

    const feedGroup = (group: Group, i: number) => {
      if ('raw' in group) {
        return (
          <Box key={`group-${i}`} backgroundColor={isTerminal ? undefined : 'subtle'} paddingX={isTerminal ? 0 : 1}>
            <Text dimColor wrap="wrap">
              {group.raw}
            </Text>
          </Box>
        )
      }
      if (group.name === 'you') {
        return (
          <Box key={`group-${i}`} flexDirection="column" alignItems="flex-end" paddingLeft={OWN_INDENT}>
            {group.posts.map((post) => postBody(post, group.name, true))}
            <Text dimColor size="caption">
              {groupTime(group.posts)}
            </Text>
          </Box>
        )
      }
      return (
        <Box key={`group-${i}`} flexDirection="row" gap={1}>
          {!isTerminal && <Box flexShrink={0}>{avatar(group.name)}</Box>}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate">
              <Text bold color={authorColor(group.name)}>
                {isTerminal ? authorOf(group.name) : group.name}
              </Text>{' '}
              <Text dimColor size="caption">
                agent
              </Text>{' '}
              <Text dimColor size="caption">
                {groupTime(group.posts)}
              </Text>
            </Text>
            {group.posts.map((post) => postBody(post, group.name, false))}
          </Box>
        </Box>
      )
    }

    const rule = Math.max(0, columns - ' Today '.length)

    const summary = (showIdle: boolean) => (
      <Text wrap="truncate" size="caption">
        {working > 0 && <Text color="suggestion">● {working} working </Text>}
        {waiting > 0 && <Text color="warning">● {waiting} waiting </Text>}
        {showIdle && resting > 0 && <Text dimColor>○ {resting} idle </Text>}
        {talks.size > 0 && <Text color="suggestion">· {talks.size} talking</Text>}
      </Text>
    )

    const sessionList = () => (
      <Box key="sessions" flexDirection="column" flexShrink={0}>
          <Box key="sessions-header" flexDirection="row" gap={1} alignItems="center">
            <Button
              key="peers"
              plain
              dimColor
              label={`${isListOpen ? '▾' : '▸'} SESSIONS`}
              onPress={() => void update($, showPeers, (open) => !open)}
            />
            {isListOpen && (
              <Button
                key="filter-active"
                plain
                dimColor={filter !== 'active'}
                label={`Active ${active.length}`}
                onPress={() => void update($, sessionFilter, () => 'active')}
              />
            )}
            {isListOpen && (
              <Button
                key="filter-all"
                plain
                dimColor={filter !== 'all'}
                label={`All ${everyone.length}`}
                onPress={() => void update($, sessionFilter, () => 'all')}
              />
            )}
            {summary(!isListOpen)}
          </Box>
          {listed.map(peerRow)}
          {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
          {hasFold && (
            <Button
              key="idle-fold"
              plain
              dimColor
              label={`○ ${idle.length} idle · ${idle
                .slice(0, 3)
                .map((peer) => peer.name)
                .join(', ')}${idle.length > 3 ? '…' : ''}`}
              onPress={() => void update($, sessionFilter, () => 'all')}
            />
          )}
      </Box>
    )

    // The wide layout's sidebar: every session, grouped by what it is doing.
    const sideRow = (peer: Peer) => (
      <Box key={`peer-${peer.sessionId}`} flexDirection="row" gap={1} alignItems="center">
        {statusDot(peer)}
        {focusButton(peer)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
            {mentionButton(peer)}
            {youBadge(peer)}
            {stopButton(peer)}
          </Box>
          {!isTerminal && (
            <Text dimColor size="caption" wrap="truncate">
              {[peer.project ?? '', peer.startedAt ? ago(now - peer.startedAt) : ''].filter(Boolean).join(' · ')}
            </Text>
          )}
        </Box>
        {percentText(peer)}
      </Box>
    )
    const sideGroups = [
      { title: 'WORKING', color: 'suggestion', peers: byStatus.working },
      { title: 'WAITING', color: 'warning', peers: byStatus.waiting },
      { title: 'IDLE', color: 'inactive', peers: byStatus.idle },
    ].filter((group) => group.peers.length > 0)
    // Rows the sidebar has for its groups: the pane less its title and a row kept for `+N more`.
    let sideRoom = Math.max(1, bodyRows - 2)
    let sideHidden = 0
    const sidebar = () => (
      <Box key="sidebar" flexDirection="column" width={SIDEBAR_COLUMNS} flexShrink={0} gap={isTerminal ? 0 : 'sm'} overflow="hidden">
        <Text weight="semibold" size="heading">
          <Text dimColor>#</Text> huddle
        </Text>
        {sideGroups.map((group) => {
          // A group's header takes a row; each session, peerRows.
          const fit = group.peers.slice(0, Math.max(0, Math.floor((sideRoom - 1) / peerRows)))
          if (fit.length > 0) sideRoom -= 1 + fit.length * peerRows
          sideHidden += group.peers.length - fit.length
          return (
            fit.length > 0 && (
              <Box key={`side-${group.title}`} flexDirection="column">
                <Text color={group.color} size="caption" weight="semibold">
                  {group.title} · {group.peers.length}
                </Text>
                {fit.map(sideRow)}
              </Box>
            )
          )
        })}
        {sideHidden > 0 && <Text dimColor>+{sideHidden} more</Text>}
      </Box>
    )

    const main = (
      <Box key="main" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
        {isWide && (
          <Box key="main-header" flexDirection="row" gap={1}>
            <Text weight="semibold">All messages</Text>
            <Text dimColor size="caption">
              {everyone.length} sessions
            </Text>
            {summary(false)}
          </Box>
        )}
          <Text dimColor size="caption" wrap="truncate">
            {`${'─'.repeat(Math.floor(rule / 2))} Today ${'─'.repeat(Math.ceil(rule / 2))}`}
          </Text>
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            overflow="hidden"
            justifyContent="flex-end"
            rowGap={isTerminal ? 0 : 'md'}
          >
            {shown.length === 0 && <Text dimColor>No posts today. Write one below; type @ to mention a session.</Text>}
            {shown.map(feedGroup)}
          </Box>
          {problem !== '' && <Text dimColor>{problem}</Text>}
          {picks.length > 0 && (
            <Box
              key="suggestions"
              flexDirection="column"
              flexShrink={0}
              borderStyle={isTerminal ? undefined : 'round'}
              borderColor="subtle"
              paddingX={isTerminal ? 0 : 1}
            >
              <Text dimColor size="caption">
                {query === '' ? 'Mention a session' : `Sessions matching “${query}”`}
              </Text>
              {picks.map((peer) => {
                const tag = handle(peer.name)
                const at = query ? tag.toLowerCase().indexOf(query.toLowerCase()) : -1
                const word = statusWord(peer)
                const fill = peer.context?.percent
                return (
                  <Button
                    key={`suggest-${peer.sessionId}`}
                    plain
                    label={`@${tag}`}
                    onPress={() =>
                      void read($, typing).then((text) => {
                        const done = completeMention(text, peer.name)
                        return setPostBox($, done === text ? addMention(text, peer.name) : done)
                      })
                    }
                  >
                    @{at >= 0 ? tag.slice(0, at) : tag}
                    {at >= 0 && <Text color="suggestion">{tag.slice(at, at + query!.length)}</Text>}
                    {at >= 0 ? tag.slice(at + query!.length) : ''}
                    <Text dimColor>
                      {' '}
                      {[
                        `${word}${peer.startedAt ? ` ${ago(now - peer.startedAt)}` : ''}`,
                        peer.project ?? '',
                        fill !== undefined ? `${fill}% context` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </Button>
                )
              })}
            </Box>
          )}
          <Box
            key="post-row"
            width="100%"
            flexShrink={0}
            flexDirection="row"
            alignItems="flex-end"
            gap={1}
            borderStyle={isTerminal ? undefined : 'round'}
            borderColor="promptBorder"
            paddingX={isTerminal ? 0 : 1}
          >
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Input
                key="post"
                placeholder="Message #huddle · type @ to mention"
                value={typed}
                rows={rows}
                submitLabel="post"
                onInput={(value) => void noteTyping($, value)}
                onSubmit={(value) => void submit($, value)}
              />
            </Box>
            <Button
              key="mention-picker"
              plain
              dimColor={query === null}
              label="@"
              onPress={() =>
                void (query === null
                  ? read($, typing).then((text) => setPostBox($, startMention(text)))
                  : update($, mentionQuery, () => null))
              }
            />
            {!isTerminal && (
              <Button key="send" variant="primary" label="Send" onPress={() => void sendTyped($)} />
            )}
          </Box>
        {!isTerminal && (
          <Text dimColor size="caption">
            Enter to send · Shift+Enter for a new line
          </Text>
        )}
      </Box>
    )

    // The feed shrinks and clips its oldest posts, so the post box stays in view
    // where the rows counted above miss what a surface draws (desktop's
    // proportional text and margins).
    return isWide ? (
      <Box flexDirection="row" gap={1} height={isTerminal ? undefined : '100%'}>
        {sidebar()}
        {main}
      </Box>
    ) : (
      <Box flexDirection="column" height={isTerminal ? undefined : '100%'}>
        {sessionList()}
        {main}
      </Box>
    )
  })
}
