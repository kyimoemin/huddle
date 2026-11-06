import { atom, read, update } from 'claude-code'
import type { On, Timer } from 'claude-code'
import type { Feed } from '../types'
import { dayFile, localDay, tailFile } from './huddle.ts'
import { type $, channelDir, deliverMentions, errorText, post, runner } from './channel.ts'

export const PANE = 'huddle'
const TITLE = '#huddle'
const POLL_MS = 2000
const FEED_LINES = 200
/** Rows the pane keeps below the feed: the notice and the post box. */
const BELOW_FEED = 3

// Change the tag when Feed's fields change: a value an earlier version stored
// outlives a reload, and the tag makes this code read it as the initial value.
const feed = atom({ plugin: 'huddle', key: 'feed' } as const, { day: '', lines: [], mtimeMs: -1 } as Feed, {
  shape: 'feed-1',
})
const draft = atom({ plugin: 'huddle', key: 'draft' } as const, '')
const notice = atom({ plugin: 'huddle', key: 'notice' } as const, '')

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
    })().catch(() => {})
  })
}

async function openPane($: $): Promise<boolean> {
  await refresh($, true)
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
    const mentions = await deliverMentions($, 'you', text, line)
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
    ensurePolling($)
  }
}

export function registerPanel(on: On): void {
  on('command.run', { command: 'huddle' }, async ($) => {
    const isPlaced = await openPane($)
    return { text: isPlaced ? '#huddle opened.' : '#huddle opens when the window is wide enough.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const { lines } = await read($, feed)
    const typed = await read($, draft)
    const problem = await read($, notice)
    const shown = fitLines(lines, Math.max(1, e.props.scroll.bodyRows - BELOW_FEED), e.props.bodyColumns)

    return (
      <Box flexDirection="column">
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
