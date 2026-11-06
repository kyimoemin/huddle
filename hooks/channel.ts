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
  transcriptFile,
  lastContextTokens,
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

/** What became of a post's mentions: one line for the poster (empty with none), and the names no message reached. */
export type Delivery = { text: string; undelivered: string[] }

/**
 * Sends each session a post @mentions a message saying so, and toasts what
 * did not reach anyone.
 */
export async function deliverMentions($: $, author: string, text: string, line: string, isPerson = false): Promise<Delivery> {
  const names = parseMentions(text)
  if (names.length === 0) return { text: '', undelivered: [] }
  let rows: SessionRow[]
  try {
    rows = await sessions($)
  } catch (error) {
    const problem = `huddle: mentions not delivered: ${errorText(error)}`
    $.ui.toast(problem)
    return { text: problem, undelivered: names }
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
  const undelivered = [...new Set([...unknown, ...sent.filter((s) => !s.ok).map((s) => s.name)])]
  return { text: parts.join('; '), undelivered }
}

/** The channel folder: `$HUDDLE_DIR` when set (for testing), else ~/.claude/huddle. */
export async function channelDir($: $): Promise<string> {
  const override = await $.env.get('HUDDLE_DIR')
  const home = await $.env.get('HOME')
  if (override) {
    // A relative one is taken from where the session was when first asked, and
    // kept, so the channel and the guard stay on one folder as the cwd moves.
    if (resolvedOverride?.raw !== override) {
      resolvedOverride = { raw: override, dir: absolute(override, await $.session.cwd(), home ?? '') }
    }
    return resolvedOverride.dir
  }
  if (!home) throw new Error('huddle: HOME is not set')
  return huddleDir(home)
}

let resolvedOverride: { raw: string; dir: string } | undefined

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

/** What a session with huddle loaded publishes about itself, in `<contextDir>/<sessionId>.json`. */
export type Status = {
  /** Context fill, a whole percentage. */
  percent?: number
  tokens?: number
  /** The context window, so other sessions on `model` can be measured against it. */
  window?: number
  model?: string
  /** Its last post through the post tool, and the names that post mentioned. */
  post?: { at: number; to: string[] }
  at: number
}

/** This session's status as last written; the id changes on /clear. */
let own: { id: string; status: Status } | undefined

/** Merges `patch` into this session's status file. */
export function publishStatus($: $, patch: Omit<Partial<Status>, 'at'>): Promise<void> {
  // One at a time: a turn's figure and a post can land together, and each
  // write must carry the other's fields and land in order.
  const run = writing.then(() => writeStatus($, patch))
  writing = run.catch(() => {})
  return run
}

let writing: Promise<void> = Promise.resolve()

async function writeStatus($: $, patch: Omit<Partial<Status>, 'at'>): Promise<void> {
  const id = await $.session.id()
  if (!isFileSafe(id)) return
  const file = `${await contextDir($)}/${id}.json`
  if (own?.id !== id) {
    // After a reload, keep what the file already says (the last post).
    let kept: Status = { at: 0 }
    try {
      const parsed = JSON.parse(String(await $.fs.read(file))) as unknown
      if (typeof parsed === 'object' && parsed !== null) kept = parsed as Status
    } catch {
      // No file yet.
    }
    own = { id, status: kept }
  }
  own.status = { ...own.status, ...patch, at: Date.now() }
  await $.fs.write(file, JSON.stringify(own.status))
}

/** Publishes this session's context fill, with its window and model. */
export async function publishContext($: $, context: { percent?: number; tokens?: number; window: number }): Promise<void> {
  if (context.percent === undefined) return
  let model: string | undefined
  try {
    model = await $.session.model()
  } catch {
    // The figure stands without it.
  }
  await publishStatus($, {
    percent: Math.round(context.percent),
    ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
    window: context.window,
    ...(model ? { model } : {}),
  })
}

/** Removes an ending session's status file. Best effort. */
export async function unpublishContext($: $, id: string): Promise<void> {
  if (!isFileSafe(id)) return
  if (own?.id === id) own = undefined
  await $.process.run(['/bin/rm', '-f', `${await contextDir($)}/${id}.json`], { timeoutMs: 2000 })
}

/** What the panel shows of a session beside its name. */
export type PeerStatus = {
  /** `estimated` when read off its transcript: it has no huddle loaded. No `percent` when its window is unknown. */
  context?: { percent?: number; tokens?: number; estimated?: true }
  post?: { at: number; to: string[] }
  /** The effort level it last ran at (`high`). */
  effort?: string
}

const statuses = new Map<string, { mtimeMs: number; status: Status }>()
const transcripts = new Map<string, { mtimeMs: number; readAt: number; tokens?: number; model?: string; effort?: string }>()
const TRANSCRIPT_REREAD_MS = 10_000
/** How often, and past what age, the files of sessions no longer running are removed. */
const SWEEP_MS = 60 * 60_000
const STALE_MS = 24 * 60 * 60_000
/** How much of a transcript's end is read for its last reply. */
const TRANSCRIPT_TAIL_BYTES = 262_144
let lastSweep = 0

const clampPercent = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : undefined

function parseStatus(text: string): Status | undefined {
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const status: Status = { at: typeof parsed.at === 'number' ? parsed.at : 0 }
  const percent = clampPercent(parsed.percent)
  if (percent !== undefined) status.percent = percent
  if (typeof parsed.tokens === 'number') status.tokens = parsed.tokens
  if (typeof parsed.window === 'number' && parsed.window > 0) status.window = parsed.window
  if (typeof parsed.model === 'string') status.model = parsed.model
  const post = parsed.post as { at?: unknown; to?: unknown } | undefined
  if (post && typeof post.at === 'number' && Array.isArray(post.to)) {
    status.post = { at: post.at, to: post.to.filter((name): name is string => typeof name === 'string') }
  }
  return status
}

/**
 * Each listed session's status, by session id. A session with huddle loaded
 * says it in its file (one listing per call; a file is read again only when
 * its mtime moved). One without huddle has its context read off its
 * transcript's last reply, as a percentage where a huddle session on the same
 * model gives the window, else as tokens.
 */
export async function peerStatuses($: $, rows: readonly SessionRow[]): Promise<Map<string, PeerStatus>> {
  const out = new Map<string, PeerStatus>()
  const dir = await contextDir($)
  let entries: { name: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    // No session has published yet: transcripts only.
  }
  const ids = rows.map((row) => row.sessionId)
  const mtimes = new Map(entries.map((entry) => [entry.name, entry.mtimeMs]))
  const listed = new Set(ids.map((id) => `${id}.json`))
  // Forget what is no longer listed, and once in a while remove the files of
  // sessions that ended without removing their own (a crash, a kill).
  for (const name of statuses.keys()) if (!listed.has(name)) statuses.delete(name)
  for (const id of transcripts.keys()) if (!ids.includes(id)) transcripts.delete(id)
  if (ids.length > 0 && !ids.some((id) => id.startsWith('ref:')) && Date.now() - lastSweep > SWEEP_MS) {
    lastSweep = Date.now()
    const stale = entries.filter(
      (entry) => entry.name.endsWith('.json') && !listed.has(entry.name) && Date.now() - entry.mtimeMs > STALE_MS,
    )
    if (stale.length > 0) {
      void $.process.run(['/bin/rm', '-f', ...stale.map((entry) => `${dir}/${entry.name}`)], { timeoutMs: 5000 }).catch(() => {})
    }
  }

  const published = new Map<string, Status>()
  for (const id of ids) {
    const name = `${id}.json`
    const mtimeMs = mtimes.get(name)
    if (mtimeMs === undefined) continue
    let known = statuses.get(name)
    if (known?.mtimeMs !== mtimeMs) {
      try {
        const status = parseStatus(String(await $.fs.read(`${dir}/${name}`)))
        // A failed read is tried again next time.
        if (status) statuses.set(name, (known = { mtimeMs, status }))
      } catch {
        // Half-written or not ours: no figure this time.
      }
    }
    // The last good read stands while a newer one fails.
    if (known) published.set(id, known.status)
  }

  const windows = new Map<string, number>()
  // One model id can run with different windows: the smallest known one never shows a session emptier than it is.
  for (const { model, window } of published.values()) {
    if (model && window) windows.set(modelFamily(model), Math.min(window, windows.get(modelFamily(model)) ?? Infinity))
  }

  const configDir = await transcriptsRoot($)
  await Promise.all(rows.map(async (row) => {
    const status = published.get(row.sessionId)
    const peer: PeerStatus = {}
    if (status?.post) peer.post = status.post
    // Every session's transcript says the effort of its last reply; one without huddle, its context too.
    const read =
      row.cwd && configDir && isFileSafe(row.sessionId)
        ? await transcriptTokens($, transcriptFile(configDir, row.cwd, row.sessionId), row.sessionId)
        : undefined
    if (read?.effort) peer.effort = read.effort
    if (status?.percent !== undefined) {
      peer.context = { percent: status.percent, ...(status.tokens !== undefined ? { tokens: status.tokens } : {}) }
    } else if (read) {
      if (read.tokens !== undefined) {
        const window = read.model ? windows.get(modelFamily(read.model)) : undefined
        const percent = window && read.tokens <= window ? clampPercent((read.tokens / window) * 100) : undefined
        peer.context = { ...(percent !== undefined ? { percent } : {}), tokens: read.tokens, estimated: true }
      }
    }
    if (peer.context || peer.post || peer.effort) out.set(row.sessionId, peer)
  }))
  return out
}

/**
 * A model as both spellings reduce to: `/model`'s (`Opus 5.5`,
 * `claude-opus-5-5[1m]`) and a transcript's API id (`claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`) both become `opus-5-5` / `haiku-4-5`.
 */
export function modelFamily(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-*(claude-)?|-*$/g, '')
    .replace(/-\d{8}$/, '')
}

/** Where transcripts live: `$CLAUDE_CONFIG_DIR`, else ~/.claude. */
async function transcriptsRoot($: $): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude` : undefined
}

/** A transcript's last reply, read again only when the file changed. */
async function transcriptTokens($: $, file: string, id: string): Promise<{ tokens?: number; model?: string; effort?: string } | undefined> {
  let mtimeMs: number
  try {
    mtimeMs = (await $.fs.stat(file)).mtimeMs
  } catch {
    return undefined
  }
  const known = transcripts.get(id)
  // A busy session's transcript moves every tick: read it at most every 10s.
  const now = await $.clock.now()
  if (known && (known.mtimeMs === mtimeMs || now - known.readAt < TRANSCRIPT_REREAD_MS)) return known
  try {
    const { exitCode, stdout } = await $.process.run(['/usr/bin/tail', '-c', String(TRANSCRIPT_TAIL_BYTES), file], { timeoutMs: 3000 })
    if (exitCode !== 0) return known
    const last = lastContextTokens(stdout)
    const read = { mtimeMs, readAt: now, ...(last ?? {}) }
    transcripts.set(id, read)
    return read
  } catch {
    return known
  }
}
