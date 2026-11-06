import { atom, read, update } from 'claude-code'
import type { On, Timer } from 'claude-code'
import type { Feed, Peer } from '../types'
import { dayFile, localDay, tailFile } from './huddle'
import { type $, channelDir, contextFills, deliverMentions, errorText, forgetSessions, post, runClaude, runner, sessions } from './channel'

export const PANE = 'huddle'
const TITLE = '#huddle'
const POLL_MS = 2000
const FEED_LINES = 200
/** Rows the pane keeps below the feed: the notice and the post box. */
const BELOW_FEED = 3
/** The session list's header row. */
const HEADER_ROWS = 1

// Change the tag when Feed's fields change: a value an earlier version stored
// outlives a reload, and the tag makes this code read it as the initial value.
const feed = atom({ plugin: 'huddle', key: 'feed' } as const, { day: '', lines: [], mtimeMs: -1 } as Feed, {
  shape: 'feed-1',
})
const draft = atom({ plugin: 'huddle', key: 'draft' } as const, '')
const notice = atom({ plugin: 'huddle', key: 'notice' } as const, '')
const peers = atom({ plugin: 'huddle', key: 'peers' } as const, [] as Peer[], { shape: 'peers-2' })
const showPeers = atom({ plugin: 'huddle', key: 'showPeers' } as const, false)

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

/**
 * Re-reads the session list (cached 10s) and each session's context fill,
 * writing them only when a row changed.
 */
export async function refreshPeers($: $): Promise<void> {
  let rows: Peer[]
  try {
    const listed = await sessions($)
    // The list stands without the figures.
    const context = await contextFills($, listed.map((row) => row.sessionId)).catch(() => new Map<string, number>())
    rows = sortPeers(
      listed.map(({ sessionId, name, kind, status, id, startedAt }) => ({
        sessionId,
        name,
        kind,
        status,
        id,
        startedAt,
        context: context.get(sessionId),
      })),
    )
  } catch {
    return
  }
  const current = await read($, peers)
  if (JSON.stringify(current) !== JSON.stringify(rows)) await update($, peers, () => rows)
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
    await update($, notice, () => `Could not stop ${peer.name}: ${(stderr || stdout).trim()}`)
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
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
  ensurePolling($)
  return isPlaced
}

/** Posts what the person typed, signed `you`, and delivers its mentions. */
export async function submit($: $, text: string): Promise<void> {
  if (text.trim() === '') return
  await update($, draft, () => '')
  try {
    const line = await post($, 'you', text)
    const mentions = await deliverMentions($, 'you', text, line, true)
    const problems = mentions.split('; ').filter((part) => part !== '' && !part.startsWith('notified '))
    await update($, notice, () => problems.join('; '))
  } catch (error) {
    await update($, draft, () => text)
    await update($, notice, () => `Not posted: ${errorText(error)}`)
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
export function fitLines(lines: readonly string[], rows: number, columns: number): string[] {
  const width = Math.max(1, columns)
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const cost = Math.max(1, Math.ceil([...line].length / width))
    if (used + cost > rows && kept.length > 0) break
    kept.unshift(line)
    used += cost
  }
  return kept
}

/** The panel's part of `session.start`: the /huddle command, and polling again after a reload. */
export async function startPanel($: $): Promise<void> {
  await $.command.register({ name: 'huddle', description: 'Open #huddle: the channel every local session shares' })
  // A reload keeps the pane up but drops timers: start polling again.
  if ((await $.ui.panes()).some((pane) => pane.id === PANE)) {
    await refresh($, true)
    await refreshPeers($)
    ensurePolling($)
  }
}

export function registerPanel(on: On): void {
  on('command.run', { command: 'huddle' }, async ($) => {
    const isPlaced = await openPane($)
    return { text: isPlaced ? '#huddle opened.' : '#huddle opens when the window is wide enough.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const { lines } = await read($, feed)
    const typed = await read($, draft)
    const problem = await read($, notice)
    const everyone = await read($, peers)
    const isListOpen = await read($, showPeers)
    const selfId = await $.session.id()
    const now = Date.now()

    const bodyRows = e.props.scroll.bodyRows
    // The list takes at most half the pane; the rest is the feed's.
    const listRoom = Math.max(1, Math.floor(bodyRows / 2) - HEADER_ROWS)
    const listed = isListOpen ? everyone.slice(0, everyone.length > listRoom ? listRoom - 1 : listRoom) : []
    const hidden = isListOpen ? everyone.length - listed.length : 0
    const listRows = HEADER_ROWS + listed.length + (hidden > 0 ? 1 : 0)
    const shown = fitLines(lines, Math.max(1, bodyRows - BELOW_FEED - listRows), e.props.bodyColumns)
    const busy = everyone.filter((peer) => peer.status === 'busy').length

    return (
      <Box flexDirection="column">
        <Button
          key="peers"
          plain
          label={`${isListOpen ? '▾' : '▸'} Sessions: ${everyone.length}${busy > 0 ? `, ${busy} busy` : ''}`}
          onPress={() => void update($, showPeers, (open) => !open)}
        />
        {listed.map((peer) => (
          <Box flexDirection="row" gap={1}>
            <Text bold={peer.sessionId === selfId}>{peer.name}</Text>
            <Text dimColor>
              {peer.sessionId === selfId ? 'this session' : peer.kind ?? 'session'} · {peer.status ?? '?'}
              {peer.startedAt ? ` · ${ago(now - peer.startedAt)}` : ''}
            </Text>
            {peer.context !== undefined && (
              <Text dimColor={peer.context < CONTEXT_WARN} color={peer.context >= CONTEXT_WARN ? 'warning' : undefined}>
                {peer.context}% context
              </Text>
            )}
            {peer.kind === 'background' && peer.id && peer.sessionId !== selfId && (
              <Button key={`stop-${peer.id}`} label="stop" onPress={() => void stopPeer($, peer)} />
            )}
          </Box>
        ))}
        {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
        <Box flexDirection="column" flexGrow={1}>
          {shown.length === 0 && <Text dimColor>No posts today. Write one below; @name mentions a session.</Text>}
          {shown.map((line) => {
            const row = parseRow(line)
            return 'raw' in row ? (
              <Text wrap="wrap">{row.raw}</Text>
            ) : (
              <Text wrap="wrap">
                <Text dimColor>{row.time}</Text> <Text bold>{row.name}</Text> {row.body}
              </Text>
            )
          })}
        </Box>
        {problem !== '' && <Text dimColor>{problem}</Text>}
        <Input
          key="post"
          placeholder="Post to #huddle; @name mentions a session"
          value={typed}
          submitLabel="post"
          onInput={(value) => void update($, draft, () => value)}
          onSubmit={(value) => void submit($, value)}
        />
      </Box>
    )
  })
}
