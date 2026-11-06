import { expect, test } from 'claude-code/testing'
import { focusCommand, hostOf, parsePs, tabScript } from './focus'

const PS = `    1     0 ??       /sbin/launchd
  500     1 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  510   500 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  520   510 ??       /Users/me/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude
  600     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  610   600 ttys003  login
  620   610 ttys003  -zsh
  630   620 ttys003  claude
  700   620 ttys003  claude
  800     1 ??       /usr/sbin/cron
  810   800 ??       claude
`

test('a session runs under the app around its nearest app ancestor, helpers included', () => {
  const procs = parsePs(PS)
  expect(procs.get(510)?.command).toContain('Code Helper (Plugin)')
  expect(hostOf(procs, 520)).toEqual({ app: '/Applications/Visual Studio Code.app' })
  expect(hostOf(procs, 630)).toEqual({ app: '/System/Applications/Utilities/Terminal.app', tty: '/dev/ttys003' })
  expect(hostOf(procs, 810)).toEqual({})
  // Its own binary in a bundle, run from Terminal: Terminal is the host.
  const bundled = parsePs(`${PS}  900   620 ttys003  /Applications/Claude.app/Contents/Resources/claude\n`)
  expect(hostOf(bundled, 900)).toEqual({ app: '/System/Applications/Utilities/Terminal.app', tty: '/dev/ttys003' })
  expect(hostOf(procs, 999)).toEqual({})
})

test('an editor opens the folder, a terminal picks the tab, any other app comes to the front', () => {
  const vscode = { app: '/Applications/Visual Studio Code.app' }
  expect(focusCommand(vscode, '/p/huddle', true)).toEqual(['/usr/bin/open', '-a', vscode.app, '/p/huddle'])
  expect(focusCommand({ app: '/Applications/Claude.app' }, '/p/huddle', false)).toEqual(['/usr/bin/open', '-a', '/Applications/Claude.app'])
  const terminal = focusCommand({ app: '/System/Applications/Utilities/Terminal.app', tty: '/dev/ttys003' }, '/p', false)
  expect(Array.isArray(terminal) && terminal[0]).toBe('/usr/bin/osascript')
  expect(Array.isArray(terminal) && terminal[2]).toContain('if tty of t is "/dev/ttys003"')
  // VS Code's own terminal has a tty but no tabs to pick: its window is raised by folder.
  expect(focusCommand({ ...vscode, tty: '/dev/ttys009' }, '/p/huddle', true)).toEqual(['/usr/bin/open', '-a', vscode.app, '/p/huddle'])
  expect(focusCommand({}, '/p', false)).toEqual({ reason: 'its app could not be found' })
  expect(tabScript('/Applications/iTerm.app', '/dev/ttys001')).toContain('tell application "iTerm2"')
})
