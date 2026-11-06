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
 * The names a post @mentions, each once, in order. A mention starts the text
 * or follows a space or an opening bracket, so an email address is not one.
 * Trailing dots, dashes and underscores are left off (`@coachcard-1e.`).
 */
export function parseMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|[\s([{])@([A-Za-z0-9][\w.-]*)/g)) {
    const name = match[1]!.replace(/[._-]+$/, '')
    if (name !== '' && !found.includes(name)) found.push(name)
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
  /** The short id `claude stop` takes; background sessions only. */
  id?: string
  startedAt?: number
}

/** Names that mention no session: `@you` is the person. */
const NOT_SESSIONS = new Set(['you'])

export type Mentions = {
  /** Every session a mention reaches; a name several sessions share reaches each. */
  targets: { name: string; sessionId: string }[]
  /** Mentioned names no running session carries. */
  unknown: string[]
}

/**
 * Resolves mentioned names to running sessions, case-insensitively. This
 * session (`selfId`) and `@you` are left out, neither reached nor unknown.
 */
export function resolveMentions(names: readonly string[], rows: readonly SessionRow[], selfId: string): Mentions {
  const targets: Mentions['targets'] = []
  const unknown: string[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    if (NOT_SESSIONS.has(lower)) continue
    const matches = rows.filter((row) => row.name.toLowerCase() === lower)
    if (matches.length === 0) unknown.push(name)
    for (const row of matches) if (row.sessionId !== selfId) targets.push({ name: row.name, sessionId: row.sessionId })
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
