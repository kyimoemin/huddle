import type { EngineInterface } from 'claude-code'
import {
  appendLine,
  dayFile,
  formatEntry,
  huddleDir,
  localDay,
  mentionMessage,
  parseMentions,
  parseSessions,
  previousDayFile,
  resolveMentions,
  type SessionRow,
  tailFile,
  type Run,
} from './huddle.ts'

/** The channel's operations on the engine, shared by the tools and the panel. */

const SESSIONS_TTL_MS = 10_000

export type $ = EngineInterface

/** A Run that goes through `$.process.run`. */
export function runner($: $): Run {
  return (argv) => $.process.run(argv)
}

let cachedSessions: { rows: SessionRow[]; at: number } | undefined

/**
 * The running local sessions, from `claude agents --json`. Cached briefly so
 * a post costs at most one process; names change and repeat, so not for long.
 */
export async function sessions($: $): Promise<SessionRow[]> {
  const now = Date.now()
  if (cachedSessions && now - cachedSessions.at < SESSIONS_TTL_MS) return cachedSessions.rows
  const { exitCode, stdout, stderr } = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 10_000 })
  if (exitCode !== 0) throw new Error(`claude agents failed: ${stderr.trim()}`)
  const rows = parseSessions(stdout)
  cachedSessions = { rows, at: now }
  return rows
}

/** Drops the cached session list, so the next read runs `claude agents` again. */
export function forgetSessions(): void {
  cachedSessions = undefined
}

/** This session's name as ListAgents shows it; the folder name when that fails. */
export async function ownName($: $): Promise<string> {
  try {
    const id = await $.session.id()
    const name = (await sessions($)).find((row) => row.sessionId === id)?.name
    if (name) return name
  } catch {
    // Fall through to the folder name.
  }
  return (await $.session.cwd()).split('/').filter(Boolean).at(-1) ?? 'session'
}

/**
 * Sends each session a post @mentions a message saying so, and toasts what
 * did not reach anyone. Returns one line for the poster; empty with no mentions.
 */
export async function deliverMentions($: $, author: string, text: string, line: string): Promise<string> {
  const names = parseMentions(text)
  if (names.length === 0) return ''
  let rows: SessionRow[]
  try {
    rows = await sessions($)
  } catch (error) {
    const problem = `huddle: mentions not delivered: ${errorText(error)}`
    $.ui.toast(problem)
    return problem
  }
  const { targets, unknown } = resolveMentions(names, rows, await $.session.id())
  const message = mentionMessage(author, line)
  const sent = await Promise.all(
    targets.map(async (target) => {
      try {
        const { isDelivered, reason } = await $.session.send({ to: { sessionId: target.sessionId }, text: message })
        return isDelivered ? { ...target, ok: true as const } : { ...target, ok: false as const, reason }
      } catch (error) {
        return { ...target, ok: false as const, reason: errorText(error) }
      }
    }),
  )
  const reached = sent.filter((s) => s.ok).map((s) => `@${s.name}`)
  const failed = sent.filter((s) => !s.ok).map((s) => `@${s.name} (${s.reason})`)
  const problems = [
    ...unknown.map((name) => `@${name}: no running session has that name`),
    ...failed.map((f) => `${f}: not delivered`),
  ]
  if (problems.length > 0) $.ui.toast(`huddle: ${problems.join('; ')}`)
  const parts = [reached.length > 0 ? `notified ${[...new Set(reached)].join(', ')}` : '', ...problems].filter(Boolean)
  return parts.join('; ')
}

/** The channel folder: `$HUDDLE_DIR` when set (for testing), else ~/.claude/huddle. */
export async function channelDir($: $): Promise<string> {
  const override = await $.env.get('HUDDLE_DIR')
  if (override) return override
  const home = await $.env.get('HOME')
  if (!home) throw new Error('huddle: HOME is not set')
  return huddleDir(home)
}

/** Posts one entry to today's file; returns the line written. */
export async function post($: $, name: string, text: string, at = new Date()): Promise<string> {
  const line = formatEntry({ at, name, text })
  await appendLine(runner($), dayFile(await channelDir($), at), line)
  return line
}

/**
 * The tail of today's file. With `days` 2, yesterday's comes first and each
 * day is always headed `## YYYY-MM-DD`, with `(no posts)` under an empty one.
 */
export async function read($: $, days: number, tail: number, at = new Date()): Promise<string> {
  const base = await channelDir($)
  const run = runner($)
  const today = await tailFile(run, dayFile(base, at), tail)
  if (days < 2) return today.length > 0 ? today.join('\n') : 'No posts today.'

  const before = new Date(at)
  before.setDate(before.getDate() - 1)
  const yesterday = await tailFile(run, previousDayFile(base, at), tail)
  if (today.length === 0 && yesterday.length === 0) return 'No posts today or yesterday.'
  const day = (date: Date, lines: string[]) => [`## ${localDay(date)}`, ...(lines.length > 0 ? lines : ['(no posts)'])]
  return [...day(before, yesterday), ...day(at, today)].join('\n')
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

