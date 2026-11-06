import type { EngineInterface, ProcessRunResult } from 'claude-code'
import {
  appendLine,
  dayFile,
  formatEntry,
  huddleDir,
  localDay,
  mentionMessage,
  parseMentions,
  type ListAgentsResult,
  parseListAgents,
  parseSessions,
  previousDayFile,
  resolveMentions,
  type SessionRow,
  tailFile,
  type Run,
} from './huddle'
import { absolute } from './guard'

/** The channel's operations on the engine, shared by the tools and the panel. */

const SESSIONS_TTL_MS = 10_000

export type $ = EngineInterface

/** A Run that goes through `$.process.run`. */
export function runner($: $): Run {
  return (argv) => $.process.run(argv)
}

/**
 * Runs the `claude` CLI. First the binary running this session
 * (`$CLAUDE_CODE_EXECPATH`), which the desktop app and the VS Code extension
 * bundle off the PATH; then `claude` on the PATH, where that is unset,
 * does not start, or fails. Rejects only when neither starts.
 */
export async function runClaude($: $, args: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  const own = await $.env.get('CLAUDE_CODE_EXECPATH')
  let ownResult: ProcessRunResult | undefined
  if (own) {
    try {
      ownResult = await $.process.run([own, ...args], { timeoutMs })
      if (ownResult.exitCode === 0) return ownResult
    } catch {
      // Fall back to the PATH.
    }
  }
  try {
    const onPath = await $.process.run(['claude', ...args], { timeoutMs })
    // Where both ran and failed, the session's own binary says why.
    return onPath.exitCode !== 0 && ownResult ? ownResult : onPath
  } catch (error) {
    if (ownResult) return ownResult
    throw new Error(`the claude command could not be run (${errorText(error)})`)
  }
}

let cachedSessions: { rows: SessionRow[]; at: number } | undefined
let pendingSessions: Promise<SessionRow[]> | undefined

/**
 * The running local sessions: `claude agents --json`, or where that cannot
 * run, the ListAgents tool (no Stop ids then). Cached briefly so a post costs
 * at most one lookup; names change and repeat, so not for long.
 */
export async function sessions($: $): Promise<SessionRow[]> {
  if (cachedSessions && Date.now() - cachedSessions.at < SESSIONS_TTL_MS) return cachedSessions.rows
  // Callers that overlap (a poll tick, a post) share one lookup.
  pendingSessions ??= lookUpSessions($).finally(() => {
    pendingSessions = undefined
  })
  return pendingSessions
}

async function lookUpSessions($: $): Promise<SessionRow[]> {
  const now = Date.now()
  let rows: SessionRow[]
  try {
    const { exitCode, stdout, stderr } = await runClaude($, ['agents', '--json'], 10_000)
    if (exitCode !== 0) throw new Error(`claude agents failed: ${stderr.trim()}`)
    rows = parseSessions(stdout)
  } catch (cliError) {
    try {
      rows = await listAgents($)
    } catch (toolError) {
      throw new Error(`${errorText(cliError)}; ListAgents: ${errorText(toolError)}`)
    }
  }
  cachedSessions = { rows, at: now }
  return rows
}

/** The session list through the ListAgents tool, which needs no CLI. */
async function listAgents($: $): Promise<SessionRow[]> {
  const called = await $.tool.call({ tool: 'ListAgents' })
  if (called.deny !== undefined) throw new Error(called.deny)
  if (called.isError) throw new Error(called.text ?? 'ListAgents failed')
  return parseListAgents(called.result as ListAgentsResult, await $.session.id())
}

/** Drops the cached session list, so the next read runs `claude agents` again. */
export function forgetSessions(): void {
  cachedSessions = undefined
  pendingSessions = undefined
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
export async function deliverMentions($: $, author: string, text: string, line: string, isPerson = false): Promise<string> {
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
  // The person posting from this session's panel can mention this session too.
  const { targets, unknown } = resolveMentions(names, rows, await $.session.id(), isPerson)
  const message = mentionMessage(author, line)
  const sent = await Promise.all(
    targets.map(async (target) => {
      try {
        if (target.isSelf) {
          // This session's own turn, once it is idle, as a typed prompt would be.
          void $.prompt.submit({ text: message })
          return { ...target, ok: true as const }
        }
        const to = target.address ?? { sessionId: target.sessionId }
        const { isDelivered, reason } = await $.session.send({ to, text: message })
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
  const home = await $.env.get('HOME')
  // Absolute, so sessions started in different folders share one channel.
  if (override) return absolute(override, await $.session.cwd(), home ?? '')
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


/**
 * Where each session with huddle loaded keeps its context fill, one
 * `<sessionId>.json` per session: beside the channel folder, not in it, so
 * the append-only rule does not cover it.
 */
export async function contextDir($: $): Promise<string> {
  const channel = (await channelDir($)).replace(/\/+$/, '')
  return `${channel.slice(0, channel.lastIndexOf('/'))}/huddle-context`
}

const isFileSafe = (id: string) => /^[\w-]+$/.test(id)

/** Writes this session's context fill, a whole percentage, for every panel to read. */
export async function publishContext($: $, percent: number): Promise<void> {
  const id = await $.session.id()
  if (!isFileSafe(id)) return
  await $.fs.write(`${await contextDir($)}/${id}.json`, JSON.stringify({ percent: Math.round(percent), at: Date.now() }))
}

/** Removes an ending session's context file. Best effort. */
export async function unpublishContext($: $, id: string): Promise<void> {
  if (!isFileSafe(id)) return
  await $.process.run(['/bin/rm', '-f', `${await contextDir($)}/${id}.json`], { timeoutMs: 2000 })
}

const fills = new Map<string, { mtimeMs: number; percent: number | undefined }>()

/**
 * Each listed session's context fill, by session id, from the files the
 * sessions write. One listing per call; a file is read again only when its
 * mtime moved. A session without huddle loaded has no file, so no figure.
 */
export async function contextFills($: $, sessionIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const dir = await contextDir($)
  let entries: { name: string; mtimeMs: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return out
  }
  const mtimes = new Map(entries.map((entry) => [entry.name, entry.mtimeMs]))
  for (const id of sessionIds) {
    const name = `${id}.json`
    const mtimeMs = mtimes.get(name)
    if (mtimeMs === undefined) continue
    let known = fills.get(name)
    if (known?.mtimeMs !== mtimeMs) {
      let percent: number | undefined
      try {
        const value = (JSON.parse(String(await $.fs.read(`${dir}/${name}`))) as { percent?: unknown }).percent
        if (typeof value === 'number' && Number.isFinite(value)) percent = Math.min(100, Math.max(0, Math.round(value)))
      } catch {
        // Half-written or not ours: no figure this time.
      }
      known = { mtimeMs, percent }
      // A failed read is tried again next time.
      if (percent !== undefined) fills.set(name, known)
    }
    if (known.percent !== undefined) out.set(id, known.percent)
  }
  return out
}
