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
  /**
   * Every other directory the command may be in by now: each `cd` adds one
   * and none is dropped, since `popd`, `cd -` and a `( … )` subshell can go back.
   */
  also?: readonly string[]
}

/** How deep `sh -c`, `eval` and `env -S` may nest before the command is refused unchecked. */
const MAX_NESTING = 8
/** The most directories a command's `cd`s are followed into. */
const MAX_CWDS = 16

const DELETES_OR_MOVES = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'truncate', 'mv', 'chflags', 'chmod', 'chown', 'xattr', 'setfacl',
])
const COPIES_ONTO_LAST = new Set(['cp', 'ln', 'rsync', 'install', 'ditto', 'scp'])
const IN_PLACE_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/**
 * Words run before the real command: each with its options that take a
 * value, and how many plain words it takes before the command
 * (`timeout 5 rm …`). Shell keywords that can lead a command are here too.
 */
const PREFIXES: Record<string, { takesValue: ReadonlySet<string>; positionals?: number }> = {
  sudo: { takesValue: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D']) },
  doas: { takesValue: new Set(['-u', '-C']) },
  xargs: { takesValue: new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a']) },
  env: { takesValue: new Set(['-u', '-C', '-S']) },
  nice: { takesValue: new Set(['-n']) },
  ionice: { takesValue: new Set(['-c', '-n', '-p']) },
  timeout: { takesValue: new Set(['-s', '-k']), positionals: 1 },
  gtimeout: { takesValue: new Set(['-s', '-k']), positionals: 1 },
  chrt: { takesValue: new Set(), positionals: 1 },
  taskset: { takesValue: new Set(), positionals: 1 },
  stdbuf: { takesValue: new Set(['-i', '-o', '-e']) },
  caffeinate: { takesValue: new Set(['-t', '-w']) },
  exec: { takesValue: new Set(['-a']) },
  ...Object.fromEntries(
    ['command', 'builtin', 'nohup', 'time', 'unbuffer', 'noglob', 'nocorrect', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']
      .map((word) => [word, { takesValue: new Set<string>() }]),
  ),
}
const WRITERS = new Set([...DELETES_OR_MOVES, ...COPIES_ONTO_LAST, ...IN_PLACE_EDITORS, 'tee', 'dd'])

/** A word as the shell passes it on: quotes dropped, `\\x` read as `x`. */
const unquote = (token: string) => token.replace(/\\(.)/g, '$1').replace(/["'`]/g, '')

/** The index just past the `)` that closes the `$(` opening at `open`. */
function closeOfSubstitution(command: string, open: number): number {
  let depth = 0
  for (let i = open; i < command.length; i++) {
    if (command[i] === '\\') i++
    else if (command[i] === '(') depth++
    else if (command[i] === ')' && --depth === 0) return i + 1
  }
  return command.length
}

/**
 * The command's simple commands, split on `;`, `&`, `&&`, `||`, `|`, newlines,
 * `$(`, backticks and parentheses outside quotes. A `$(…)` or backtick
 * substitution inside double quotes runs too, so its commands are listed as
 * well. Each says whether a pipe fed it, for `… | xargs rm`.
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
      else if (quote === '"' && c === '\\') {
        text += c + (command[++i] ?? '')
        continue
      } else if (quote === '"' && (command.startsWith('$(', i) || c === '`')) {
        const end = c === '`' ? command.indexOf('`', i + 1) + 1 || command.length : closeOfSubstitution(command, i + 1)
        const inner = command.slice(c === '`' ? i + 1 : i + 2, c === '`' ? end - 1 : end - 1)
        out.push(...splitCommand(inner))
        text += command.slice(i, end)
        i = end - 1
        continue
      }
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
    } else if (two === '|&') {
      cut(true)
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

const patterns = new Map<string, RegExp>()

/** A path segment as a regular expression, its `*`, `?` and `[…]` as the shell reads them. */
function segmentPattern(segment: string): RegExp {
  let pattern = patterns.get(segment)
  if (!pattern) {
    if (patterns.size > 1000) patterns.clear()
    pattern = compileSegment(segment)
    patterns.set(segment, pattern)
  }
  return pattern
}

function compileSegment(segment: string): RegExp {
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
  try {
    return new RegExp(`^${source}$`)
  } catch {
    // A class the shell reads some other way (`[z-a]`): assume it can match.
    return /^.*$/
  }
}

/** A `{1..5}` or `{a..e}` body as its words; null when it is no sequence, 'many' over `limit`. */
function braceSequence(body: string, limit: number): string[] | null | 'many' {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/.exec(body)
  if (!match) return null
  const [from, to] = [match[1]!, match[2]!]
  const isNumber = /\d/.test(from)
  if (isNumber !== /\d/.test(to)) return null
  const [a, b] = isNumber ? [Number(from), Number(to)] : [from.charCodeAt(0), to.charCodeAt(0)]
  if (Math.abs(b - a) + 1 > limit) return 'many'
  const out: string[] = []
  // Every step between, whatever the increment: a superset of what the shell makes.
  for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(isNumber ? String(n) : String.fromCharCode(n))
  return out
}

/**
 * The words a brace expansion (`{a,b}`, `{1..3}`) makes of `word`, as the
 * shell would; `${…}` is left alone. Undefined past `limit` words.
 */
export function expandBraces(word: string, limit = 64): string[] | undefined {
  for (let open = word.indexOf('{'); open >= 0; open = word.indexOf('{', open + 1)) {
    if (word[open - 1] === '$') continue
    let depth = 0
    const commas: number[] = []
    let close = -1
    for (let i = open; i < word.length && close < 0; i++) {
      if (word[i] === '{') depth++
      else if (word[i] === '}' && --depth === 0) close = i
      else if (word[i] === ',' && depth === 1) commas.push(i)
    }
    if (close < 0) continue
    let choices: string[]
    if (commas.length > 0) {
      const cuts = [open, ...commas, close]
      choices = cuts.slice(0, -1).map((cut, k) => word.slice(cut + 1, cuts[k + 1]))
    } else {
      const sequence = braceSequence(word.slice(open + 1, close), limit)
      if (sequence === 'many') return undefined
      if (sequence === null) continue
      choices = sequence
    }
    const out: string[] = []
    for (const choice of choices) {
      const more = expandBraces(`${word.slice(0, open)}${choice}${word.slice(close + 1)}`, limit - out.length)
      if (more === undefined) return undefined
      out.push(...more)
      if (out.length > limit) return undefined
    }
    return out
  }
  return [word]
}

/** `word` with each brace group read as `*`: what it can match, when it expands to too many words. */
function bracesAsGlob(word: string): string {
  let out = word
  for (let last = ''; last !== out; ) {
    last = out
    out = out.replace(/(^|[^$])\{[^{}]*\}/g, '$1*')
  }
  return out
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
  const whole = unquote(word)
  if (whole === '' || whole.startsWith('-') || /^[A-Za-z_]\w*=/.test(whole)) return undefined
  let found: 'inside' | 'ancestor' | undefined
  const cwds = [where.cwd, ...(where.also ?? [])]
  for (const token of expandBraces(whole) ?? [bracesAsGlob(whole)]) {
    if (/\.claude\/huddle(\/|$)/.test(token)) return 'inside'
    if (!/^[~/.$\w*?[{]/.test(token)) continue
    for (const cwd of token.startsWith('/') || token.startsWith('~') || token.startsWith('$') ? [where.cwd] : cwds) {
      const path = absolute(token, cwd, where.home)
      for (const dir of where.dirs) {
        const r = relation(path, dir)
        if (r === 'inside') return r
        found ??= r
      }
    }
  }
  return found
}

/** Every redirect target: `>`, `>>`, `>|`, `&>`, `&>>`, `>&file`; not a `>&2` descriptor copy. */
function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  for (const match of segment.matchAll(/(?:\d|&)?>>?(&)?\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g)) {
    if (match[1] && /^(\d+|-)$/.test(match[2]!)) continue
    targets.push(match[2]!)
  }
  return targets
}

/** The folder a cp/ln/install/rsync copies into: its `-t` value, else its last word. */
function copyTarget(args: readonly string[]): { target: string | undefined; sources: string[] } {
  const plain = args.map(unquote)
  let target: string | undefined
  const sources: string[] = []
  for (let i = 0; i < plain.length; i++) {
    const word = plain[i]!
    if (word === '-t' || word === '--target-directory') target = plain[++i]
    else if (word.startsWith('--target-directory=')) target = word.slice('--target-directory='.length)
    else if (!word.startsWith('-')) sources.push(word)
  }
  if (target === undefined) target = sources.pop()
  return { target, sources }
}

/**
 * Why a Bash command would write, delete, move or unflag the channel, or
 * undefined when it only reads it or leaves it alone. Appends are refused
 * too: every post goes through the post tool or the panel, which sign it.
 */
export function bashRewriteReason(command: string, where: Where, depth = 0): string | undefined {
  if (depth > MAX_NESTING) return 'nests sh -c, eval or env -S too deeply to check'
  let cwds = [...new Set([where.cwd, ...(where.also ?? [])])]
  let pipelineTouches = false
  for (const { text, isPiped } of splitCommand(command)) {
    where = { ...where, cwd: cwds.at(-1)!, also: cwds }
    if (!isPiped) pipelineTouches = false
    // Each word's standing once per segment: several rules ask about the same word.
    const known = new Map<string, 'inside' | 'ancestor' | undefined>()
    const standOf = (word: string) => {
      if (!known.has(word)) known.set(word, standing(word, where))
      return known.get(word)
    }
    const isInsideWord = (word: string) => standOf(word) === 'inside'
    const touchesWord = (word: string) => standOf(word) !== undefined

    const target = redirectTargets(text).find((word) => isInsideWord(word))
    if (target !== undefined) return `writes to ${unquote(target)} with a redirect`

    // Shell words: a quoted part can sit anywhere in one (`--opt='a b'`).
    const words = text.match(/(?:"[^"]*"|'[^']*'|\\.|[^\s"'\\])+/g) ?? []
    let start = 0
    let viaXargs = false
    const scripts: string[] = []
    while (start < words.length) {
      const word = unquote(words[start]!)
      const prefix = PREFIXES[word]
      if (prefix) {
        if (word === 'xargs') viaXargs = true
        start++
        while (start < words.length && unquote(words[start]!).startsWith('-')) {
          const option = unquote(words[start]!)
          // `env -S '<command line>'` runs that line: check it like `sh -c`.
          if (word === 'env' && (option === '-S' || option === '--split-string')) scripts.push(words[start + 1] ?? '')
          else if (word === 'env' && /^(-S|--split-string=)./.test(option)) scripts.push(option.replace(/^(-S|--split-string=)/, ''))
          start += prefix.takesValue.has(option) ? 2 : 1
        }
        start += prefix.positionals ?? 0
      } else if (/^[A-Za-z_]\w*=/.test(word)) start++
      else break
    }
    const name = unquote(words[start] ?? '').split('/').at(-1) ?? ''
    const args = words.slice(start + 1)
    const inside = args.some((word) => isInsideWord(word))
    const touches = args.some((word) => touchesWord(word))

    // Follow `cd` and `pushd` so a later relative path is judged where it may
    // land: from every directory the command may be in, keeping the old ones
    // (`popd`, `cd -` and a subshell's `cd` can all go back).
    if (name === 'cd' || name === 'pushd') {
      const to = unquote(args.find((word) => !word.startsWith('-') && !/^[+-]\d+$/.test(word)) ?? '~')
      if (to !== '-' && !to.includes('$(')) {
        cwds = [...new Set([...cwds, ...cwds.map((cwd) => absolute(to, cwd, where.home))])].slice(-MAX_CWDS)
      }
      continue
    }
    // Look inside `sh -c '<script>'`, `eval '<script>'` and `env -S '<script>'`.
    const dashC = SHELLS.has(name) ? args.findIndex((word) => /^-[A-Za-z]*c$/.test(unquote(word))) : -1
    if (dashC >= 0) scripts.push(args[dashC + 1] ?? '')
    if (name === 'eval') scripts.push(args.join(' '))
    for (const script of scripts) {
      const inner = bashRewriteReason(script.replace(/^(['"])([\s\S]*)\1$/, '$2'), where, depth + 1)
      if (inner !== undefined) return inner
    }

    // A writer fed paths by a pipe that named the channel: `find … | xargs rm`.
    if (viaXargs && isPiped && pipelineTouches && WRITERS.has(name)) return `runs xargs ${name} on it`
    pipelineTouches ||= touches || words.some((word) => touchesWord(word))

    // Deleting, moving or unflagging the folder or anything above it takes the channel too.
    if (DELETES_OR_MOVES.has(name) && touches) return `runs ${name} on it`
    if (COPIES_ONTO_LAST.has(name)) {
      // Onto the channel, or into a folder above it under the channel's own name.
      const { target, sources } = copyTarget(args)
      const onto = target === undefined ? undefined : standOf(target)
      const lands = (source: string) => touchesWord(`${target}/${source.split('/').filter(Boolean).at(-1) ?? ''}`)
      // `ditto`, `cp -T`, and a source ending in `/` copy the folder's contents,
      // whose names can't be seen here: into a folder above the channel, refused.
      const plain = args.map(unquote)
      const copiesContents = (source: string) =>
        name === 'ditto' || /\/\.?$/.test(source) || plain.includes('--no-target-directory') || plain.some((word) => /^-[A-Za-z]*T/.test(word))
      if (onto === 'inside' || (onto === 'ancestor' && sources.some((source) => lands(source) || copiesContents(source)))) {
        return `runs ${name} onto it`
      }
    }
    if (name === 'rsync' && args.some((word) => unquote(word).startsWith('--delete')) && touchesWord(args.at(-1) ?? '')) {
      return 'runs rsync --delete over it'
    }
    if (name === 'dd' && args.some((word) => unquote(word).startsWith('of=') && isInsideWord(unquote(word).slice(3)))) {
      return 'runs dd onto it'
    }
    if (IN_PLACE_EDITORS.has(name) && inside && args.some((word) => /^-[A-Za-z]*i/.test(unquote(word)) || unquote(word).startsWith('--in-place'))) {
      return `edits it in place with ${name} -i`
    }
    if (name === 'tee' && inside) return 'writes to it with tee'
    if (name === 'find' && touches) {
      const plain = args.map(unquote)
      if (plain.includes('-delete')) return 'runs find -delete on it'
      const writer = plain
        .map((word, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(plain[i - 1] ?? '') ? word.split('/').at(-1)! : '')
        .find((word) => WRITERS.has(word))
      if (writer !== undefined) return `runs find -exec ${writer} on it`
    }
  }
  return undefined
}
