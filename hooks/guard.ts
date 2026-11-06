/**
 * Best-effort checks that keep the channel append-only at the tool layer.
 * The hard stop is the `uappnd` flag; this layer gives the model a clear
 * refusal before it tries, and stops the rewrites the flag cannot (a session
 * clearing the flag with `chflags nouappnd`).
 */

/** Collapses `.` and `..` and repeated slashes in an absolute path. */
export function collapse(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * A path as the shell or a tool would open it: `~`, `$HOME` and `${HOME}`
 * expanded, a relative path joined to `cwd`, then collapsed.
 */
export function absolute(path: string, cwd: string, home: string): string {
  const expanded = path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)
  return collapse(expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`)
}

/** Whether `path` is `dir` or anything beneath it. Both absolute and collapsed. */
export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

export type Where = {
  /** The channel folder, every spelling of it to match (lexical and real). */
  dirs: readonly string[]
  /** The directory the command runs in. */
  cwd: string
  home: string
}

const DELETES_OR_MOVES = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'truncate', 'mv', 'chflags', 'chmod', 'chown', 'xattr', 'setfacl',
])
const COPIES_ONTO_LAST = new Set(['cp', 'ln', 'rsync', 'install', 'ditto', 'scp'])
const IN_PLACE_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'xargs', 'nice'])

const unquote = (token: string) => token.replace(/["'`]/g, '')

/** Whether a shell word names a path in the channel. */
function namesChannel(word: string, where: Where): boolean {
  const token = unquote(word)
  if (token === '' || token.startsWith('-') || /^[A-Za-z_]\w*=/.test(token)) return false
  if (/\.claude\/huddle(\/|$)/.test(token)) return true
  if (!/^[~/.$\w*?[]/.test(token)) return false
  const path = absolute(token, where.cwd, where.home)
  return where.dirs.some((dir) => isInside(path, dir))
}

/** Single `>` (and `>|`, `&>`) redirect targets; `>>` appends and is left alone. */
function overwriteTargets(segment: string): string[] {
  const targets: string[] = []
  for (const match of segment.matchAll(/(?<![>])(?:\d|&)?>(?!>)(?!&)\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g)) {
    targets.push(match[1]!)
  }
  return targets
}

/**
 * Why a Bash command would rewrite, delete, move or unflag the channel, or
 * undefined when it only reads it, appends to it, or leaves it alone.
 */
export function bashRewriteReason(command: string, where: Where): string | undefined {
  // Quoted text is kept for paths but not split on: a `;` inside quotes still
  // splits here, which errs toward refusing.
  let cwd = where.cwd
  for (const segment of command.split(/\|\||&&|[;\n]|(?<!>)\||\$\(|`|\(|\)/)) {
    where = { ...where, cwd }
    const target = overwriteTargets(segment).find((word) => namesChannel(word, where))
    if (target !== undefined) return `overwrites ${unquote(target)} with >`

    const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    let start = 0
    while (start < words.length) {
      const word = unquote(words[start]!)
      if (PREFIXES.has(word) || /^[A-Za-z_]\w*=/.test(word) || (word.startsWith('-') && start > 0)) start++
      else break
    }
    const name = unquote(words[start] ?? '').split('/').at(-1) ?? ''
    const args = words.slice(start + 1)
    const touches = args.some((word) => namesChannel(word, where))

    // Follow `cd` so a later relative path is judged where it lands.
    if (name === 'cd') {
      const to = unquote(args.find((word) => !word.startsWith('-')) ?? '~')
      if (to !== '-' && !to.includes('$(')) cwd = absolute(to, cwd, where.home)
      continue
    }
    // Look inside `sh -c '<script>'` and `eval '<script>'`.
    const dashC = SHELLS.has(name) ? args.findIndex((word) => /^-[A-Za-z]*c$/.test(unquote(word))) : -1
    const script = dashC >= 0 ? args[dashC + 1] : name === 'eval' ? args.join(' ') : undefined
    if (script !== undefined) {
      const inner = bashRewriteReason(script.replace(/^(['"])([\s\S]*)\1$/, '$2'), where)
      if (inner !== undefined) return inner
    }

    if (DELETES_OR_MOVES.has(name) && touches) return `runs ${name} on it`
    if (COPIES_ONTO_LAST.has(name) && args.length > 0 && namesChannel(args.at(-1)!, where)) return `runs ${name} onto it`
    if (name === 'dd' && args.some((word) => unquote(word).startsWith('of=') && namesChannel(unquote(word).slice(3), where))) {
      return 'runs dd onto it'
    }
    if (IN_PLACE_EDITORS.has(name) && touches && args.some((word) => /^-[A-Za-z]*i/.test(unquote(word)) || unquote(word).startsWith('--in-place'))) {
      return `edits it in place with ${name} -i`
    }
    if (name === 'tee' && touches && !args.some((word) => /^-[A-Za-z]*a/.test(unquote(word)) || unquote(word) === '--append')) {
      return 'overwrites it with tee (use tee -a to append)'
    }
    if (name === 'find' && touches) {
      const plain = args.map(unquote)
      if (plain.includes('-delete')) return 'runs find -delete on it'
      const writer = plain.find((word, i) =>
        ['-exec', '-execdir', '-ok', '-okdir'].includes(plain[i - 1] ?? '') &&
        (DELETES_OR_MOVES.has(word) || COPIES_ONTO_LAST.has(word) || IN_PLACE_EDITORS.has(word) || word === 'tee'),
      )
      if (writer !== undefined) return `runs find -exec ${writer} on it`
    }
  }
  return undefined
}
