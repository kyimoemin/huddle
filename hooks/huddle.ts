/** Longest post kept, in characters; longer text is cut and ends with "…". */
export const MAX_POST = 2000

/** The channel's folder under a home directory. */
export function huddleDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/huddle`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A date's local day as `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** A date's local time as `HH:MM`. */
export function localTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** The day file for a date in a channel folder: `<dir>/YYYY-MM-DD.md`. */
export function dayFile(dir: string, at: Date): string {
  return `${dir.replace(/\/+$/, '')}/${localDay(at)}.md`
}

/** The day file for the day before `at`. */
export function previousDayFile(dir: string, at: Date): string {
  const before = new Date(at)
  before.setDate(before.getDate() - 1)
  return dayFile(dir, before)
}

/**
 * Makes post text fit one entry line: line breaks become ` / `, the ends are
 * trimmed, and text over MAX_POST characters is cut and ends with "…".
 */
export function cleanText(text: string): string {
  const oneLine = text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' / ')
  const chars = [...oneLine]
  return chars.length <= MAX_POST ? oneLine : `${chars.slice(0, MAX_POST - 1).join('')}…`
}

/** Makes an author name safe inside `**…**`: one line, no asterisks. */
export function cleanName(name: string): string {
  const cleaned = name.replace(/[\r\n*]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned === '' ? 'unknown' : cleaned
}

export type Entry = { at: Date; name: string; text: string }

/** One channel line: `- 14:32 **name**: text`, with no trailing newline. */
export function formatEntry({ at, name, text }: Entry): string {
  return `- ${localTime(at)} **${cleanName(name)}**: ${cleanText(text)}`
}

/**
 * The names a post @mentions, each once (case aside), in order. A mention starts the text
 * or follows a space or an opening bracket, so an email address is not one.
 * Trailing dots, dashes and underscores are left off (`@coachcard-1e.`).
 */
export function parseMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|[\s([{])@([A-Za-z0-9][\w.-]*)/g)) {
    const name = match[1]!.replace(/[._-]+$/, '')
    if (name !== '' && !found.some((seen) => seen.toLowerCase() === name.toLowerCase())) found.push(name)
  }
  return found
}

/** The last `n` non-empty lines of a file's text. */
export function lastLines(text: string, n: number): string[] {
  if (n <= 0) return []
  return text.split('\n').filter((line) => line !== '').slice(-n)
}

/**
 * Runs a command by argv and resolves its exit code and output. The hooks
 * module passes `(argv) => $.process.run(argv)`; tests pass a fake.
 */
export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * Appends one line to a day file and keeps it append-only.
 *
 * One `sh` call: create the folder, append with `>>` (O_CREAT|O_APPEND, so the
 * first writer of the day creates the file and nobody checks first), then set
 * `uappnd` on the file and the folder where `chflags` exists (macOS, BSD).
 * The flag is set on every append rather
 * than only on a new file, so there is no check-then-act. The line and paths
 * are positional arguments, never part of the script, so nothing is injected.
 */
export async function appendLine(run: Run, file: string, line: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf('/'))
  // chflags is macOS/BSD only: elsewhere the append stands without the OS flag.
  const script = 'mkdir -p "$3" && printf "%s\\n" "$1" >> "$2" && { chflags uappnd "$2" "$3" 2>/dev/null || true; }'
  const { exitCode, stderr } = await run(['/bin/sh', '-c', script, 'sh', line, file, dir])
  if (exitCode !== 0) throw new Error(`huddle: append to ${file} failed: ${stderr.trim()}`)
}

/** The last `n` lines of a day file; none when the file does not exist yet. */
export async function tailFile(run: Run, file: string, n: number): Promise<string[]> {
  if (n <= 0) return []
  const { exitCode, stdout } = await run(['/usr/bin/tail', '-n', String(n), file])
  return exitCode === 0 ? lastLines(stdout, n) : []
}

/** One row of `claude agents --json`, the fields huddle reads. */
export type SessionRow = {
  sessionId: string
  name: string
  /** `interactive` or `background`. */
  kind?: string
  /** `idle` or `busy`. */
  status?: string
  /** The short id `claude stop` takes; background sessions only, and only from the CLI. */
  id?: string
  startedAt?: number
  /** Its working directory; from the CLI only. */
  cwd?: string
  /**
   * How `$.session.send` addresses it when `sessionId` is not a real one: the
   * `name [ref]` spelling ListAgents shows, for rows read from that tool.
   */
  address?: string
}

/** Names that mention no session: `@you` is the person. */
const NOT_SESSIONS = new Set(['you'])

export type Mentions = {
  /** Every session a mention reaches; a name several sessions share reaches each. */
  targets: { name: string; sessionId: string; address?: string; isSelf?: true }[]
  /** Mentioned names no running session carries. */
  unknown: string[]
}

/**
 * Resolves mentioned names to running sessions, case-insensitively. `@you`
 * is left out, neither reached nor unknown. This session (`selfId`) is left
 * out too, unless `includeSelf` (the person posting from this session's
 * panel), when it is a target marked `isSelf`.
 */
export function resolveMentions(
  names: readonly string[],
  rows: readonly SessionRow[],
  selfId: string,
  includeSelf = false,
): Mentions {
  const targets: Mentions['targets'] = []
  const unknown: string[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    if (NOT_SESSIONS.has(lower)) continue
    const matches = rows.filter((row) => row.name.toLowerCase() === lower || handle(row.name).toLowerCase() === lower)
    if (matches.length === 0) unknown.push(name)
    for (const row of matches) {
      if (row.sessionId === selfId) {
        if (includeSelf) targets.push({ name: row.name, sessionId: row.sessionId, isSelf: true })
        continue
      }
      targets.push(row.address ? { name: row.name, sessionId: row.sessionId, address: row.address } : { name: row.name, sessionId: row.sessionId })
    }
  }
  return { targets, unknown }
}

/** What a mentioned session receives. */
export function mentionMessage(author: string, line: string): string {
  return `You were mentioned in #huddle by ${cleanName(author)}:\n${line}\nRead the channel with mcp__huddle__read and reply with mcp__huddle__post if a reply is useful.`
}

/** Parses `claude agents --json` output into rows; malformed rows are dropped. */
export function parseSessions(stdout: string): SessionRow[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (row): row is SessionRow =>
      typeof row === 'object' && row !== null && typeof row.sessionId === 'string' && typeof row.name === 'string',
  )
}

const LOCAL_KINDS = new Set(['interactive', 'background'])

/** What the ListAgents tool answers, the parts huddle reads. */
export type ListAgentsResult = {
  listing?: string
  sections?: { kind?: string; rows?: { name?: string; ref?: string; id?: string; type?: string; status?: string }[] }[]
}

/**
 * Session rows from the ListAgents tool, for when the `claude` CLI cannot run.
 * Its header names this session ("This session is huddle-5a [2195f3]"); its
 * rows are the peers. Peers get a stand-in `sessionId` and are sent to by
 * their `name [ref]` address. No row gets the short id Stop needs.
 */
export function parseListAgents(result: ListAgentsResult, selfId: string): SessionRow[] {
  const rows: SessionRow[] = []
  const self = /This session is (.+?)(?: \[([0-9a-f]+)\])?(?: [—-]|\s*\(|$)/m.exec(result.listing ?? '')
  if (self?.[1]) rows.push({ sessionId: selfId, name: self[1].trim() })
  for (const section of result.sections ?? []) {
    // Local sessions only: not subagents, teammates, or sessions elsewhere.
    if (section.kind !== 'sessions') continue
    for (const row of section.rows ?? []) {
      if (!row.name || (row.type !== undefined && !LOCAL_KINDS.has(row.type))) continue
      const ref = row.ref?.replace(/^\[|\]$/g, '')
      rows.push({
        sessionId: `ref:${ref ?? row.id ?? row.name}`,
        name: row.name,
        ...(row.type ? { kind: row.type } : {}),
        ...(row.status ? { status: row.status } : {}),
        address: ref ? `${row.name} [${ref}]` : row.name,
      })
    }
  }
  return rows
}

/**
 * How a post @mentions a session: its name with each run of spaces a dash
 * (`sprint 25` is `@sprint-25`), since a mention ends at a space.
 */
export function handle(name: string): string {
  return name.trim().replace(/\s+/g, '-')
}

/** `@handle ` added to a draft: after a space, and not again when the draft has it. */
export function addMention(draft: string, name: string): string {
  const tag = `@${handle(name)}`
  if (parseMentions(draft).some((seen) => seen.toLowerCase() === tag.slice(1).toLowerCase())) return draft
  return `${draft}${draft === '' || /\s$/.test(draft) ? '' : ' '}${tag} `
}

const ICONS = [
  '🦊', '🐙', '🦉', '🐢', '🦄', '🐝', '🦋', '🐬', '🦁', '🐼', '🐧', '🦜',
  '🐳', '🦔', '🐸', '🦩', '🐨', '🦦', '🐯', '🦀', '🐞', '🦭', '🐺', '🦥',
] as const

/** A session's icon: one emoji picked by its id, the same on every panel and after a restart. */
export function sessionIcon(sessionId: string): string {
  let hash = 0
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return ICONS[Math.abs(hash) % ICONS.length]!
}

/** The person's icon in the feed. */
export const PERSON_ICON = '👤'

/** Where Claude Code keeps a session's transcripts: the cwd with every other character a dash. */
export function transcriptFile(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir.replace(/\/+$/, '')}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

/**
 * The input tokens of a transcript's last main-thread reply (uncached,
 * cache-written and cache-read together, as the status line counts them), and
 * its model. Reads from the end; subagent lines are skipped.
 */
export function lastContextTokens(text: string): { tokens: number; model?: string } | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    let entry: { type?: unknown; isSidechain?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue // The cut first line of a tail, or one being written.
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue
    const usage = entry.message?.usage
    if (!usage) continue
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
    const tokens = count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens')
    if (tokens === 0) continue
    const model = entry.message?.model
    return typeof model === 'string' ? { tokens, model } : { tokens }
  }
  return undefined
}

/** A token count in a few characters: `950`, `114k`, `1.2M`. */
export function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
