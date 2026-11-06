import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ago, fitLines, parseRow, sortPeers } from './panel.tsx'

const WHOLE = { isStdoutTruncated: false, isStderrTruncated: false }
const START = { cwd: '/Users/me/Projects/huddle', surface: 'terminal', isInteractive: true } as const
const HUDDLE = {
  command: 'huddle',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'huddle',
    surface,
    component: 'Pane',
    requestId: 'huddle',
    props: {
      title: '#huddle',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

/**
 * The engine beneath the panel. Today's file holds `day.lines` with mtime
 * `day.mtimeMs` (0: no file). The pane is open once `ui.open` ran, until
 * `world.isOpen` is set false. Returns what the test reads and changes.
 */
function world(on: On) {
  const state = {
    lines: [] as string[],
    mtimeMs: 0,
    isOpen: false,
    stats: 0,
    appended: [] as string[],
    sent: [] as string[],
    toasts: [] as string[],
    stops: [] as string[],
    stopFails: false,
    peers: [
      { sessionId: 'sid', name: 'huddle-5a', kind: 'interactive', status: 'busy', startedAt: 1000 },
      { sessionId: 's1', name: 'coachcard-1e', kind: 'interactive', status: 'idle', startedAt: 2000 },
      { sessionId: 'bg-full', id: 'bg1', name: 'nightly-qa', kind: 'background', status: 'busy', startedAt: 500 },
    ] as Record<string, unknown>[],
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__huddle__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/Users/me/Projects/huddle' }))
  on('ui.open', () => {
    state.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: state.isOpen ? [{ id: 'huddle', title: '#huddle', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (!e.path.endsWith('.md')) return { deny: `ENOENT: ${e.path}` }
    state.stats++
    return state.mtimeMs === 0
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: 1, mtimeMs: state.mtimeMs, isLink: false } }
  })
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', ...WHOLE } })
    if (cmd === 'claude' && e.argv[1] === 'agents') return out(JSON.stringify(state.peers))
    if (cmd === 'claude' && e.argv[1] === 'stop') {
      state.stops.push(e.argv[2]!)
      if (state.stopFails) return { value: { exitCode: 1, stdout: '', stderr: `No job matching '${e.argv[2]}'.`, ...WHOLE } }
      state.peers = state.peers.filter((peer) => peer.id !== e.argv[2])
      return out(`stopped ${e.argv[2]}`)
    }
    if (cmd === '/usr/bin/tail') return state.mtimeMs === 0 ? out('', 1) : out(state.lines.map((l) => `${l}\n`).join(''))
    if (cmd === '/bin/sh') {
      const line = e.argv[4]!
      state.appended.push(line)
      state.lines.push(line)
      state.mtimeMs++
      return out('')
    }
    return out('', 1)
  })
  on('session.send', (_, e) => {
    state.sent.push(e.to)
    return { isDelivered: true }
  })
  return state
}

test('a feed line splits into time, name and text', () => {
  expect(parseRow('- 14:32 **coachcard-1e**: QA is **green**')).toEqual({
    time: '14:32',
    name: 'coachcard-1e',
    body: 'QA is **green**',
  })
  expect(parseRow('something else')).toEqual({ raw: 'something else' })
})

test('fitLines keeps the newest lines that fit, counting wrapped rows', () => {
  const lines = ['a'.repeat(25), 'b', 'c'.repeat(10)]
  expect(fitLines(lines, 2, 10)).toEqual(['b', 'c'.repeat(10)])
  expect(fitLines(lines, 5, 10)).toEqual(lines)
  // The newest line shows even when it alone is taller than the room.
  expect(fitLines(['x'.repeat(100)], 2, 10)).toEqual(['x'.repeat(100)])
  expect(fitLines([], 5, 10)).toEqual([])
})

test("/huddle opens the pane showing today's posts, on every surface", async ($, on) => {
  const day = world(on)
  day.lines = ['- 14:32 **coachcard-1e**: QA is green', '- 14:35 **you**: @coachcard-1e which tests?']
  day.mtimeMs = 1
  await $.session.start(START)

  const ran = await $.command.run(HUDDLE)
  expect(String(ran.text)).toContain('#huddle opened')
  expect(day.isOpen).toBe(true)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: /QA is green/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /which tests\?/ })).toBeDefined()
    expect((await ui.find({ key: 'post' }))?.type).toBe('Input')
    await ui.unmount()
  }
})

test('an empty day says so', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)

  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /No posts today/ }))?.text).toContain('@name mentions a session')
  await ui.unmount()
})

test('the post box posts as you, delivers mentions, clears and shows the new line', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    await ui.input({ key: 'post', text: `@coachcard-1e ping from ${surface}`, kind: 'change' })
    await ui.input({ key: 'post', text: `@coachcard-1e ping from ${surface}` })

    expect(day.appended.at(-1)).toMatch(new RegExp(`^- \\d\\d:\\d\\d \\*\\*you\\*\\*: @coachcard-1e ping from ${surface}$`))
    expect(await ui.find({ type: 'Text', text: new RegExp(`ping from ${surface}`) })).toBeDefined()
    expect((await ui.find({ key: 'post' }))?.props.value).toBe('')
    await ui.unmount()
  }
  expect(day.sent.length).toBe(2)
})

test('an unknown mention shows under the feed; an empty post does nothing', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

  await ui.input({ key: 'post', text: '   ' })
  expect(day.appended).toEqual([])

  await ui.input({ key: 'post', text: '@ghost hello' })
  expect(day.appended.length).toBe(1)
  expect((await ui.find({ type: 'Text', text: /@ghost: no running session/ }))).toBeDefined()
  await ui.unmount()
})

test('the feed follows the file every 2 s while the pane is open, then stops', async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

  // Another session posts.
  day.lines.push('- 15:00 **coachcard-1e**: new from elsewhere')
  day.mtimeMs = 5
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /new from elsewhere/ })).toBeDefined()

  // Unchanged mtime: one stat, no re-read.
  const tailsBefore = day.stats
  await clock.advance(2000)
  expect(day.stats).toBe(tailsBefore + 1)

  // The person closes the pane: the next tick stops polling.
  day.isOpen = false
  await clock.advance(2000)
  const statsAfterClose = day.stats
  await clock.advance(10_000)
  expect(day.stats).toBe(statsAfterClose)
  await ui.unmount()
})

test('background sessions sort first, then newest; ago picks the largest unit', () => {
  const sorted = sortPeers([
    { sessionId: 'a', name: 'old', kind: 'interactive', startedAt: 1 },
    { sessionId: 'b', name: 'bg', kind: 'background', startedAt: 0 },
    { sessionId: 'c', name: 'new', kind: 'interactive', startedAt: 9 },
  ])
  expect(sorted.map((peer) => peer.name)).toEqual(['bg', 'new', 'old'])
  expect([ago(45_000), ago(12 * 60_000), ago(3 * 3_600_000), ago(7 * 86_400_000), ago(-5)]).toEqual([
    '45s', '12m', '3h', '7d', '0s',
  ])
})

test('the session list opens from its header and offers Stop on background sessions only', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(PANE(surface))
    const header = await ui.find({ key: 'peers' })
    expect(header?.props.label).toBe('▸ Sessions: 3, 2 busy')
    expect(await ui.find({ type: 'Text', text: /nightly-qa/ })).toBeUndefined()

    await ui.press({ key: 'peers' })
    expect((await ui.find({ key: 'peers' }))?.props.label).toBe('▾ Sessions: 3, 2 busy')
    expect(await ui.find({ type: 'Text', text: /nightly-qa/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()
    expect(await ui.find({ key: 'stop-bg1' })).toBeDefined()
    // No Stop for interactive sessions, this one included.
    for (const id of ['sid', 's1', 'undefined']) expect(await ui.find({ key: `stop-${id}` })).toBeUndefined()

    await ui.press({ key: 'peers' })
    await ui.unmount()
  }
  expect(day.stops).toEqual([])
})

test('Stop runs claude stop with the short id, toasts, and drops the row', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'peers' })

  await ui.press({ key: 'stop-bg1' })

  expect(day.stops).toEqual(['bg1'])
  expect(day.toasts.at(-1)).toBe('Stopped nightly-qa. Resume it with: claude attach bg1')
  expect(await ui.find({ key: 'stop-bg1' })).toBeUndefined()
  expect((await ui.find({ key: 'peers' }))?.props.label).toBe('▾ Sessions: 2, 1 busy')
  await ui.unmount()
})

test('a Stop that fails says why under the feed and keeps the row', async ($, on) => {
  const day = world(on)
  day.stopFails = true
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'peers' })

  await ui.press({ key: 'stop-bg1' })

  expect((await ui.find({ type: 'Text', text: /Could not stop nightly-qa/ }))?.text).toContain("No job matching 'bg1'")
  expect(await ui.find({ key: 'stop-bg1' })).toBeDefined()
  await ui.unmount()
})

test('a long session list takes at most half the pane and counts the rest', async ($, on) => {
  const day = world(on)
  day.peers = Array.from({ length: 30 }, (_, i) => ({ sessionId: `s${i}`, name: `peer-${i}`, kind: 'interactive', status: 'idle' }))
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'peers' })

  // bodyRows 20: half is 10, less the header is 9 rows: 8 sessions and "+22 more".
  expect(await ui.find({ type: 'Text', text: /^peer-7$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^peer-8$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /more$/ }))?.text).toBe('+22 more')
  await ui.unmount()
})
