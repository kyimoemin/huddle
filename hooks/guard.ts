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
/** Words run before the real command, each with the options of its that take a value. */
const PREFIXES: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D']),
  xargs: new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(),
}
const WRITERS = new Set([...DELETES_OR_MOVES, ...COPIES_ONTO_LAST, ...IN_PLACE_EDITORS, 'tee', 'dd'])

const unquote = (token: string) => token.replace(/["'`]/g, '')

/**
 * The command's simple commands, split on `;`, `&`, `&&`, `||`, `|`, newlines,
 * `$(`, backticks and parentheses outside quotes. Each says whether a pipe
 * fed it, for `… | xargs rm`.
 */
export function splitCommand(command: string): { text: string; isPiped: boolean }[] {
  const out: { text: string; isPiped: boolean }[] = []
  let text = ''
  let quote: string | undefined
  let isPiped = false
  const cut = (piped: boolean) => {
    out.push({ text, isPiped })
    text = ''
    isPiped = piped
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = undefined
      text += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      text += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      text += c + command[++i]
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      cut(false)
      i++
    } else if (c === '|' && command[i - 1] !== '>') {
      cut(true)
    } else if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      cut(false)
    } else if (two === '$(') {
      cut(false)
      i++
    } else if (c === ';' || c === '\n' || c === '`' || c === '(' || c === ')') {
      cut(false)
    } else {
      text += c
    }
  }
  cut(false)
  return out.filter((segment) => segment.text.trim() !== '')
}

/** A path segment as a regular expression, its `*`, `?` and `[…]` as the shell reads them. */
function segmentPattern(segment: string): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (c === '[') {
      const close = segment.indexOf(']', i + 1)
      if (close > i) {
        source += `[${segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = close
      } else source += '\\['
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * Where a path, globs and all, stands to the channel folder: `inside` it (or
 * the folder itself), an `ancestor` of it, or unrelated (undefined).
 */
export function relation(path: string, dir: string): 'inside' | 'ancestor' | undefined {
  const parts = path.split('/').filter(Boolean)
  const dirParts = dir.split('/').filter(Boolean)
  const shared = Math.min(parts.length, dirParts.length)
  for (let i = 0; i < shared; i++) {
    if (!segmentPattern(parts[i]!).test(dirParts[i]!)) return undefined
  }
  return parts.length >= dirParts.length ? 'inside' : 'ancestor'
}

/** Where a shell word stands to the channel; options and assignments stand nowhere. */
function standing(word: string, where: Where): 'inside' | 'ancestor' | undefined {
  const token = unquote(word)
  if (token === '' || token.startsWith('-') || /^[A-Za-z_]\w*=/.test(token)) return undefined
  if (/\.claude\/huddle(\/|$)/.test(token)) return 'inside'
  if (!/^[~/.$\w*?[]/.test(token)) return undefined
  const path = absolute(token, where.cwd, where.home)
  let found: 'inside' | 'ancestor' | undefined
  for (const dir of where.dirs) {
    const r = relation(path, dir)
    if (r === 'inside') return r
    found ??= r
  }
  return found
}

const isInsideWord = (word: string, where: Where) => standing(word, where) === 'inside'
const touchesWord = (word: string, where: Where) => standing(word, where) !== undefined

/** Every redirect target: `>`, `>>`, `>|`, `&>`, `&>>`; not a `>&2` descriptor copy. */
function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  for (const match of segment.matchAll(/(?:\d|&)?>>?(?!&)\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g)) {
    targets.push(match[1]!)
  }
  return targets
}

/**
 * Why a Bash command would write, delete, move or unflag the channel, or
 * undefined when it only reads it or leaves it alone. Appends are refused
 * too: every post goes through the post tool or the panel, which sign it.
 */
export function bashRewriteReason(command: string, where: Where): string | undefined {
  let cwd = where.cwd
  let pipelineTouches = false
  for (const { text, isPiped } of splitCommand(command)) {
    where = { ...where, cwd }
    if (!isPiped) pipelineTouches = false

    const target = redirectTargets(text).find((word) => isInsideWord(word, where))
    if (target !== undefined) return `writes to ${unquote(target)} with a redirect`

    const words = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    let start = 0
    let viaXargs = false
    while (start < words.length) {
      const word = unquote(words[start]!)
      const takesValue = PREFIXES[word]
      if (takesValue) {
        if (word === 'xargs') viaXargs = true
        start++
        while (start < words.length && unquote(words[start]!).startsWith('-')) {
          start += takesValue.has(unquote(words[start]!)) ? 2 : 1
        }
      } else if (/^[A-Za-z_]\w*=/.test(word)) start++
      else break
    }
    const name = unquote(words[start] ?? '').split('/').at(-1) ?? ''
    const args = words.slice(start + 1)
    const inside = args.some((word) => isInsideWord(word, where))
    const touches = args.some((word) => touchesWord(word, where))

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

    // A writer fed paths by a pipe that named the channel: `find … | xargs rm`.
    if (viaXargs && isPiped && pipelineTouches && WRITERS.has(name)) return `runs xargs ${name} on it`
    pipelineTouches ||= touches || words.some((word) => touchesWord(word, where))

    // Deleting, moving or unflagging the folder or anything above it takes the channel too.
    if (DELETES_OR_MOVES.has(name) && touches) return `runs ${name} on it`
    if (COPIES_ONTO_LAST.has(name) && args.length > 0 && isInsideWord(args.at(-1)!, where)) return `runs ${name} onto it`
    if (name === 'rsync' && args.some((word) => unquote(word).startsWith('--delete')) && touchesWord(args.at(-1) ?? '', where)) {
      return 'runs rsync --delete over it'
    }
    if (name === 'dd' && args.some((word) => unquote(word).startsWith('of=') && isInsideWord(unquote(word).slice(3), where))) {
      return 'runs dd onto it'
    }
    if (IN_PLACE_EDITORS.has(name) && inside && args.some((word) => /^-[A-Za-z]*i/.test(unquote(word)) || unquote(word).startsWith('--in-place'))) {
      return `edits it in place with ${name} -i`
    }
    if (name === 'tee' && inside) return 'writes to it with tee'
    if (name === 'find' && touches) {
      const plain = args.map(unquote)
      if (plain.includes('-delete')) return 'runs find -delete on it'
      const writer = plain.find((word, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(plain[i - 1] ?? '') && WRITERS.has(word))
      if (writer !== undefined) return `runs find -exec ${writer} on it`
    }
  }
  return undefined
}
