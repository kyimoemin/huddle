import type { Peer } from '../types'
import { type $, errorText } from './channel'

/** One row of `ps -axo pid=,ppid=,tty=,comm=`. */
export type Proc = { pid: number; ppid: number; tty: string; command: string }

/** Parses `ps -axo pid=,ppid=,tty=,comm=`; a command may hold spaces. */
export function parsePs(stdout: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match) procs.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), tty: match[3]!, command: match[4]! })
  }
  return procs
}

/** Where a session's window is, as far as its processes tell. */
export type Host = {
  /** The app bundle the session runs under (`/Applications/Visual Studio Code.app`). */
  app?: string
  /** Its terminal device (`/dev/ttys003`); absent when it has none (an editor's chat, the desktop app). */
  tty?: string
}

/**
 * The app a process runs under: the bundle of its nearest ancestor that is an
 * app, cut at the first `.app` so a helper (`Code Helper (Plugin).app` inside
 * `Visual Studio Code.app`) names the app around it. Also its terminal.
 */
export function hostOf(procs: ReadonlyMap<number, Proc>, pid: number): Host {
  const own = procs.get(pid)
  const tty = own && own.tty !== '??' && own.tty !== '-' ? `/dev/${own.tty.replace(/^\/dev\//, '')}` : undefined
  const seen = new Set<number>()
  for (let proc = own; proc && !seen.has(proc.pid) && proc.pid > 1; proc = procs.get(proc.ppid)) {
    seen.add(proc.pid)
    const at = proc.command.indexOf('.app/')
    if (at >= 0) return { app: proc.command.slice(0, at + 4), ...(tty ? { tty } : {}) }
  }
  return tty ? { tty } : {}
}

/** The terminal apps whose tabs can be picked by their device. */
const TERMINALS: Record<string, string> = { 'Terminal.app': 'Terminal', 'iTerm.app': 'iTerm2' }

const appName = (app: string) => app.split('/').at(-1)!

/**
 * The AppleScript that brings forward the tab holding `tty` in a terminal app,
 * or undefined for an app that has no such tabs.
 */
export function tabScript(app: string, tty: string): string | undefined {
  const name = TERMINALS[appName(app)]
  if (!name) return undefined
  const device = JSON.stringify(tty)
  return name === 'Terminal'
    ? `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${device} then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell`
    : `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${device} then
          select w
          tell t to select
          tell s to select
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`
}

/**
 * How to bring a session's window forward: the command to run, or why there
 * is none. An editor (an app with a `code` command in its bundle, as VS Code
 * and its forks have) is asked to open the session's folder, which raises the
 * window that has it open; a terminal app has its tab picked; any other app
 * (the desktop app) is brought to the front.
 */
export function focusCommand(host: Host, cwd: string | undefined, isEditor: boolean): string[] | { reason: string } {
  if (!host.app) return { reason: 'its app could not be found' }
  const script = host.tty ? tabScript(host.app, host.tty) : undefined
  if (script) return ['/usr/bin/osascript', '-e', script]
  if (isEditor && cwd) return ['/usr/bin/open', '-a', host.app, cwd]
  return ['/usr/bin/open', '-a', host.app]
}

/** Brings the window a session runs in to the front; says why not otherwise. */
export async function focusPeer($: $, peer: Peer): Promise<string | undefined> {
  if (peer.kind === 'background') {
    return `${peer.name} runs in the background, with no window${peer.id ? `: claude attach ${peer.id} opens it` : ''}`
  }
  if (!peer.pid) return `${peer.name}'s window can't be found: the session list gave no process`
  try {
    const ps = await $.process.run(['/bin/ps', '-axo', 'pid=,ppid=,tty=,comm='], { timeoutMs: 5000 })
    if (ps.exitCode !== 0) return `${peer.name}'s window can't be found: ps failed`
    const host = hostOf(parsePs(ps.stdout), peer.pid)
    const isEditor = host.app ? await $.fs.stat(`${host.app}/Contents/Resources/app/bin/code`).then(() => true, () => false) : false
    const command = focusCommand(host, peer.cwd, isEditor)
    if (!Array.isArray(command)) return `${peer.name}'s window can't be found: ${command.reason}`
    const ran = await $.process.run(command, { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) return `Could not bring ${peer.name} forward: ${(ran.stderr || ran.stdout).trim()}`
    if (command[0] === '/usr/bin/osascript' && ran.stdout.trim() !== 'ok') return `${peer.name}'s terminal tab was not found`
    return undefined
  } catch (error) {
    return `Could not bring ${peer.name} forward: ${errorText(error)}`
  }
}
