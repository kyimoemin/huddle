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
 * `uappnd` on the file and the folder. The flag is set on every append rather
 * than only on a new file, so there is no check-then-act. The line and paths
 * are positional arguments, never part of the script, so nothing is injected.
 */
export async function appendLine(run: Run, file: string, line: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf('/'))
  const script = 'mkdir -p "$3" && printf "%s\\n" "$1" >> "$2" && chflags uappnd "$2" "$3"'
  const { exitCode, stderr } = await run(['/bin/sh', '-c', script, 'sh', line, file, dir])
  if (exitCode !== 0) throw new Error(`huddle: append to ${file} failed: ${stderr.trim()}`)
}

/** The last `n` lines of a day file; none when the file does not exist yet. */
export async function tailFile(run: Run, file: string, n: number): Promise<string[]> {
  if (n <= 0) return []
  const { exitCode, stdout } = await run(['/usr/bin/tail', '-n', String(n), file])
  return exitCode === 0 ? lastLines(stdout, n) : []
}
