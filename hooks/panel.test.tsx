import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  ago,
  authorColor,
  barFill,
  completeMention,
  conversations,
  fitGroups,
  groupPosts,
  groupTime,
  initials,
  mentionNotice,
  mentionQueryOf,
  parseRow,
  postLayout,
  postRowsFor,
  sortPeers,
  splitCode,
  splitMentions,
  statusWord,
  suggest,
} from './panel'

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
function world(on: On, hasMockClock = false) {
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
    /** What `ps` prints, and the app bundles that are editors (have a `code` command). */
    ps: '',
    editors: [] as string[],
    /** Each `open` the plugin ran. */
    opened: [] as string[][],
    /** The commands the plugin registered, in order. */
    commands: [] as string[],
    context: {} as Record<string, { mtimeMs: number; text: string }>,
    lists: 0,
    removed: [] as string[],
    listFails: false,
    reads: [] as string[],
    /** Transcripts by path: what sessions without huddle have written. */
    transcripts: {} as Record<string, { mtimeMs: number; text: string }>,
    tails: 0,
    peers: [
      { sessionId: 'sid', name: 'huddle-5a', kind: 'interactive', status: 'busy', startedAt: 1000 },
      { sessionId: 's1', name: 'coachcard-1e', kind: 'interactive', status: 'idle', startedAt: 2000 },
      { sessionId: 'bg-full', id: 'bg1', name: 'nightly-qa', kind: 'background', status: 'busy', startedAt: 500 },
    ] as Record<string, unknown>[],
  }
  // Tests that move time install mock.clock first; the rest read the wall clock.
  if (!hasMockClock) on('clock.now', () => ({ value: Date.now() }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__huddle__${e.name}` } }))
  on('command.register', (_, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
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
    if (state.editors.some((app) => e.path === `${app}/Contents/Resources/app/bin`)) {
      return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
    }
    const transcript = state.transcripts[e.path]
    if (transcript) return { value: { kind: 'file', size: 1, mtimeMs: transcript.mtimeMs, isLink: false } }
    if (!e.path.endsWith('.md')) return { deny: `ENOENT: ${e.path}` }
    state.stats++
    return state.mtimeMs === 0
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: 1, mtimeMs: state.mtimeMs, isLink: false } }
  })
  // Context files, by session id: what each session with huddle wrote.
  on('fs.list', (_, e) => {
    if (e.path !== '/h/.claude/huddle-context' || state.listFails) return { deny: `ENOENT: ${e.path}` }
    state.lists++
    return {
      value: Object.entries(state.context).map(([id, f]) => ({ name: `${id}.json`, kind: 'file', size: 1, mtimeMs: f.mtimeMs, isLink: false })),
    }
  })
  on('fs.read', (_, e) => {
    state.reads.push(e.path)
    const id = e.path.split('/').at(-1)!.replace(/\.json$/, '')
    const f = state.context[id]
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
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
    if (cmd === '/bin/ps') return out(state.ps)
    if (cmd === '/usr/bin/open') {
      state.opened.push([...e.argv])
      return out('')
    }
    if (cmd === '/bin/rm') {
      state.removed.push(...e.argv.slice(2))
      return out('')
    }
    if (cmd === '/usr/bin/tail' && e.argv[1] === '-c') {
      state.tails++
      const transcript = state.transcripts[e.argv[3]!]
      return transcript ? out(transcript.text) : out('', 1)
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

test('/huddle-panel opens the pane too, and both commands are registered', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  expect(day.commands).toEqual(['huddle', 'huddle-panel'])

  const ran = await $.command.run({ ...HUDDLE, command: 'huddle-panel' })
  expect(String(ran.text)).toContain('#huddle opened')
  expect(day.isOpen).toBe(true)
})

test("a session's icon brings its window forward; a background one says it has none", async ($, on) => {
  const day = world(on)
  day.peers[1] = { ...day.peers[1]!, pid: 520, cwd: '/p/coachcard' } as (typeof day.peers)[number]
  day.ps = [
    '  510   500 ??  /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    '  520   510 ??  /Users/me/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude',
  ].join('\n')
  day.editors = ['/Applications/Visual Studio Code.app']
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

  await ui.press({ key: 'filter-all' })
  await ui.press({ key: 'focus-s1' })
  expect(day.opened).toEqual([['/usr/bin/open', '-a', '/Applications/Visual Studio Code.app', '/p/coachcard']])
  await ui.press({ key: 'focus-bg-full' })
  expect(await ui.find({ type: 'Text', text: /nightly-qa runs in the background, with no window: claude attach bg1 opens it/ })).toBeDefined()
  await ui.unmount()
})

test('an empty day says so', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)

  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /No posts today/ }))?.text).toContain('type @ to mention a session')
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
  // One short line names it; the reason went to a toast.
  expect(await ui.find({ type: 'Text', text: '⚠ @ghost not notified' })).toBeDefined()
  expect(day.toasts.some((toast) => toast.includes('@ghost: no running session'))).toBe(true)
  await ui.unmount()
})

test('the feed follows the file every 2 s while the pane is open, then stops', async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on, true)
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
    // Open by default.
    expect((await ui.find({ key: 'peers' }))?.props.label).toBe('▾ SESSIONS')
    expect(await ui.find({ type: 'Text', text: /● 2 working/ })).toBeDefined()
    expect((await ui.find({ key: 'mention-bg-full' }))?.props.label).toBe('nightly-qa')
    expect(await ui.find({ type: 'Text', text: 'YOU' })).toBeDefined()
    expect(await ui.find({ key: 'stop-bg1' })).toBeDefined()
    // No Stop for interactive sessions, this one included.
    for (const id of ['sid', 's1', 'undefined']) expect(await ui.find({ key: `stop-${id}` })).toBeUndefined()

    await ui.press({ key: 'peers' })
    expect((await ui.find({ key: 'peers' }))?.props.label).toBe('▸ SESSIONS')
    expect(await ui.find({ type: 'Text', text: /○ 1 idle/ })).toBeDefined()
    expect(await ui.find({ key: 'mention-bg-full' })).toBeUndefined()
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

  await ui.press({ key: 'stop-bg1' })

  expect(day.stops).toEqual(['bg1'])
  expect(day.toasts.at(-1)).toBe('Stopped nightly-qa. Resume it with: claude attach bg1')
  expect(await ui.find({ key: 'stop-bg1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /● 1 working/ })).toBeDefined()
  await ui.unmount()
})

test('a Stop that fails says why under the feed and keeps the row', async ($, on) => {
  const day = world(on)
  day.stopFails = true
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

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
  // Active folds them all into one row; All lists them.
  expect((await ui.find({ key: 'idle-fold' }))?.props.label).toBe('○ 30 idle · peer-0, peer-1, peer-2…')
  expect(await ui.find({ key: 'mention-s0' })).toBeUndefined()
  await ui.press({ key: 'idle-fold' })

  // bodyRows 20: half is 10, less the header is 9 rows: 8 sessions and "+22 more".
  expect(await ui.find({ key: 'mention-s7' })).toBeDefined()
  expect(await ui.find({ key: 'mention-s8' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /more$/ }))?.text).toBe('+22 more')
  await ui.unmount()
})

test("mentioning this session from its own panel prompts it instead of dropping the mention", async ($, on) => {
  const day = world(on)
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

  await ui.input({ key: 'post', text: '@huddle-5a please rebase' })

  expect(day.sent).toEqual([])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('You were mentioned in #huddle by you:')
  expect(prompts[0]).toContain('**you**: @huddle-5a please rebase')
  expect(await ui.find({ type: 'Text', text: /no running session/ })).toBeUndefined()
  await ui.unmount()
})

test("each session's row shows its context fill; a session without huddle shows none", async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on, true)
  day.context = {
    sid: { mtimeMs: 1, text: JSON.stringify({ percent: 42, at: 1 }) },
    'bg-full': { mtimeMs: 1, text: JSON.stringify({ percent: 91, at: 1 }) },
    gone: { mtimeMs: 1, text: JSON.stringify({ percent: 5, at: 1 }) },
  }
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'filter-all' })

  expect((await ui.find({ type: 'Text', text: '42%' }))?.props.color).toBeUndefined()
  // Nearly full is drawn in the warning color.
  expect((await ui.find({ type: 'Text', text: '91%' }))?.props.color).toBe('warning')
  expect(await ui.findAll({ type: 'Text', text: /%$/ })).toHaveLength(2)
  // A session with neither huddle nor a transcript says so.
  expect(await ui.find({ type: 'Text', text: 'no data' })).toBeDefined()
  // A file whose session is not running is not read.
  expect(day.reads.some((path) => path.includes('gone'))).toBe(false)

  // The poll lists the folder each tick but reads a file again only once it changed.
  const reads = day.reads.length
  await clock.advance(2000)
  expect(day.reads.length).toBe(reads)
  day.context.sid = { mtimeMs: 2, text: JSON.stringify({ percent: 55, at: 2 }) }
  await clock.advance(2000)
  expect(day.reads.length).toBe(reads + 1)
  expect(await ui.find({ type: 'Text', text: '55%' })).toBeDefined()
  await ui.unmount()
})

test('files of sessions no longer running are swept once they are a day old', async ($, on) => {
  const day = world(on)
  const now = Date.now()
  day.context = {
    sid: { mtimeMs: now - 3 * 86_400_000, text: JSON.stringify({ percent: 10 }) },
    ended: { mtimeMs: now - 2 * 86_400_000, text: JSON.stringify({ percent: 50 }) },
    recent: { mtimeMs: now - 60_000, text: JSON.stringify({ percent: 50 }) },
  }
  await $.session.start(START)
  await $.command.run(HUDDLE)
  // Listed sessions keep theirs however old; a recent one may belong to a session just starting.
  expect(day.removed).toEqual(['/h/.claude/huddle-context/ended.json'])
})

test('the session list still shows when the context files cannot be read', async ($, on) => {
  const day = world(on)
  day.listFails = true
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ key: 'mention-sid' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● 2 working/ })).toBeDefined()
  await ui.unmount()
})

const reply = (tokens: number, model = 'claude-opus-5-5', effort?: string) =>
  JSON.stringify({
    type: 'assistant',
    ...(effort ? { effort } : {}),
    message: { model, usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })

test("a session without huddle has its context read off its transcript, as a % where a huddle session on its model gives the window", async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on, true)
  day.peers = [
    { sessionId: 'sid', name: 'huddle-5a', kind: 'interactive', status: 'busy', startedAt: 1000, cwd: '/Users/me/Projects/huddle' },
    { sessionId: 's1', name: 'coachcard-1e', kind: 'interactive', status: 'idle', startedAt: 2000, cwd: '/Users/me/coach.card' },
    { sessionId: 's2', name: 'other', kind: 'interactive', status: 'idle', startedAt: 3000, cwd: '/Users/me/other' },
  ]
  day.peers.push({ sessionId: 's3', name: 'small', kind: 'interactive', status: 'idle', startedAt: 4000 })
  day.context = {
    // `/model`'s spelling; the transcripts carry the API id.
    sid: { mtimeMs: 1, text: JSON.stringify({ percent: 11, window: 1_000_000, model: 'Opus 5.5', at: 1 }) },
    // The same model at a smaller window: estimates use it, and a transcript past it shows tokens.
    s3: { mtimeMs: 1, text: JSON.stringify({ percent: 50, window: 500_000, model: 'claude-opus-5-5[1m]', at: 1 }) },
  }
  day.transcripts = {
    '/h/.claude/projects/-Users-me-coach-card/s1.jsonl': { mtimeMs: 1, text: `{"cut\n${reply(250_000)}\n` },
    '/h/.claude/projects/-Users-me-other/s2.jsonl': { mtimeMs: 1, text: `${reply(114_247, 'sonnet')}\n` },
    // A session with huddle has its effort read off its transcript too.
    '/h/.claude/projects/-Users-me-Projects-huddle/sid.jsonl': { mtimeMs: 1, text: `${reply(1000, 'claude-opus-5-5', 'max')}\n` },
  }
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('desktop'))
  await ui.press({ key: 'filter-all' })

  expect(await ui.find({ type: 'Text', text: '~50%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'MAX' })).toBeDefined()
  // Its context still comes from its own file, not the transcript.
  expect(await ui.find({ type: 'Text', text: '11%' })).toBeDefined()
  // A reply with no effort leaves the column blank.
  expect(await ui.findAll({ type: 'Text', text: /^(L|M|H|X|MAX)$/ })).toHaveLength(1)
  // No huddle session on its model: tokens, not a guessed %.
  expect(await ui.find({ type: 'Text', text: '~114k tok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /coach\.card/ })).toBeDefined()

  // A transcript is tailed again only once it changed, and at most every 10 s.
  const tails = day.tails
  await clock.advance(2000)
  expect(day.tails).toBe(tails)
  day.transcripts['/h/.claude/projects/-Users-me-coach-card/s1.jsonl'] = { mtimeMs: 2, text: `${reply(600_000)}\n` }
  await clock.advance(2000)
  expect(day.tails).toBe(tails)
  await clock.advance(8000)
  expect(day.tails).toBe(tails + 1)
  expect(await ui.find({ type: 'Text', text: '~600k tok' })).toBeDefined()
  await ui.unmount()
})

test('a session that posted shows whom it is talking to, and they show who talks to them', async ($, on) => {
  const day = world(on)
  day.context = { sid: { mtimeMs: 1, text: JSON.stringify({ percent: 5, post: { at: Date.now() - 60_000, to: ['coachcard-1e'] }, at: 1 }) } }
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))

  expect(await ui.find({ type: 'Text', text: /· 2 talking/ })).toBeDefined()
  await ui.press({ key: 'filter-all' })
  expect((await ui.find({ type: 'Text', text: '→ @coachcard-1e' }))?.props.color).toBe('suggestion')
  expect(await ui.find({ type: 'Text', text: '← huddle-5a' })).toBeDefined()
  await ui.unmount()
})

test('a post older than ten minutes is no longer talking', () => {
  const now = 1_000_000_000
  const peers = [
    { sessionId: 'a', name: 'sprint 25', post: { at: now - 11 * 60_000, to: ['b'] } },
    { sessionId: 'b', name: 'b', post: { at: now - 1000, to: ['Sprint-25'] } },
  ]
  expect([...conversations(peers, now)]).toEqual([
    ['a', { to: [], from: ['b'] }],
    ['b', { to: ['Sprint-25'], from: [] }],
  ])
  // Unknown names and itself reached nobody; `you` is the person; two posters of one name show once.
  const more = [
    { sessionId: 'w1', name: 'worker', post: { at: now, to: ['ghost', 'worker', 'you', 'lead'] } },
    { sessionId: 'w2', name: 'worker', post: { at: now, to: ['lead'] } },
    { sessionId: 'l', name: 'lead' },
  ]
  const talks = conversations(more, now)
  expect(talks.get('w1')?.to).toEqual(['worker', 'you', 'lead'])
  expect(talks.get('l')?.from).toEqual(['worker'])
})

test('clicking a session puts its @handle in the post box, once', async ($, on) => {
  const day = world(on)
  day.peers.push({ sessionId: 's9', name: 'sprint 25', kind: 'interactive', status: 'idle' })
  day.peers.push({ sessionId: 's10', name: 'café', kind: 'interactive', status: 'idle' })
  await $.session.start(START)
  await $.command.run(HUDDLE)

  for (const surface of SURFACES) {
    // Tall enough for every row: off the terminal a session takes two.
    const pane = PANE(surface)
    const ui = await $.ui.mount({ ...pane, props: { ...pane.props, scroll: { offset: 0, bodyRows: 40 } } })
    await ui.press({ key: 'filter-all' })
    await ui.input({ key: 'post', text: 'hey', kind: 'change' })
    await ui.press({ key: 'mention-s1' })
    await ui.press({ key: 'mention-s9' })
    await ui.press({ key: 'mention-s1' })
    expect((await ui.find({ key: 'post' }))?.props.value).toBe('hey @coachcard-1e @sprint-25 ')
    // A name no mention can spell says so instead.
    await ui.press({ key: 'mention-s10' })
    expect((await ui.find({ key: 'post' }))?.props.value).toBe('hey @coachcard-1e @sprint-25 ')
    expect(await ui.find({ type: 'Text', text: /café can't be @mentioned/ })).toBeDefined()
    await ui.input({ key: 'post', text: '', kind: 'change' })
    await ui.unmount()
  }
  expect(day.appended).toEqual([])
})

test('typing is not drawn back into the post box; it grows to three lines', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  const box = async () => (await ui.find({ key: 'post' }))?.props

  await ui.input({ key: 'post', text: 'h', kind: 'change' })
  await ui.input({ key: 'post', text: 'hi', kind: 'change' })
  // A keystroke drawn back resets the field one character late.
  expect((await box())?.value).toBe('')
  expect((await box())?.rows).toBe(1)

  await ui.input({ key: 'post', text: 'one\ntwo', kind: 'change' })
  expect((await box())?.rows).toBe(2)
  await ui.input({ key: 'post', text: 'a\nb\nc\nd\ne', kind: 'change' })
  expect((await box())?.rows).toBe(3)
  expect((await box())?.value).toBe('')

  await ui.press({ key: 'filter-all' })
  await ui.press({ key: 'mention-s1' })
  expect((await box())?.value).toBe('a\nb\nc\nd\ne @coachcard-1e ')
  await ui.input({ key: 'post', text: '', kind: 'change' })
  expect((await box())?.rows).toBe(1)
  await ui.unmount()
})

test('postRowsFor counts wrapped and typed lines, at most three', () => {
  expect(postRowsFor('', 40)).toBe(1)
  expect(postRowsFor('x'.repeat(32), 40)).toBe(1)
  expect(postRowsFor('x'.repeat(33), 40)).toBe(2)
  expect(postRowsFor('a\nb', 40)).toBe(2)
  expect(postRowsFor('x'.repeat(500), 40)).toBe(3)
})

test('the feed draws mentions and code apart, and each other author with its icon', async ($, on) => {
  const day = world(on)
  day.lines = ['- 14:34 **huddle-5a**: try `U+2588`', '- 14:35 **you**: @coachcard-1e which tests?']
  day.mtimeMs = 1
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  const mention = await ui.find({ type: 'Text', text: /^@coachcard-1e$/ })
  expect(mention?.props).toMatchObject({ bold: true, color: 'warning' })
  expect(mention?.props.backgroundColor).toBeUndefined()
  // A code span is drawn on its own background (the terminal is monospaced already).
  expect((await ui.find({ type: 'Text', text: /^U\+2588$/ }))?.props.backgroundColor).toBe('subtle')
  // Your posts need no name; another author's header carries its icon and the agent badge.
  expect(await ui.find({ type: 'Text', text: /^👤 you$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\S+ huddle-5a$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agent' })).toBeDefined()
  await ui.unmount()
})

test('the post box is a one-line field on the terminal and a text area elsewhere', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  for (const [surface, rows] of [['terminal', 1], ['desktop', 2]] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect((await ui.find({ key: 'post' }))?.props.rows).toBe(rows)
    await ui.unmount()
  }
})

test('splitMentions and barFill', () => {
  expect(splitMentions('hi @a, (@b-2.) mail x@y.z')).toEqual([
    { text: 'hi ' },
    { text: '@a', isMention: true },
    { text: ', (' },
    { text: '@b-2', isMention: true },
    { text: '.) mail x@y.z' },
  ])
  expect([barFill(-5), barFill(9), barFill(100), barFill(140)]).toEqual(['0%', '9%', '100%', '100%'])
})

test('the talking arrow goes once the post is ten minutes old, with no other change', async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on, true)
  day.context = { sid: { mtimeMs: 1, text: JSON.stringify({ percent: 5, post: { at: clock.now(), to: ['coachcard-1e'] }, at: 1 }) } }
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '→ @coachcard-1e' })).toBeDefined()
  await clock.advance(10 * 60_000 + 2000)
  expect(await ui.find({ type: 'Text', text: '→ @coachcard-1e' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /talking/ })).toBeUndefined()
  await ui.unmount()
})

test('mentionNotice names the undelivered mentions in one short line', () => {
  expect(mentionNotice([])).toBe('')
  expect(mentionNotice(['ghost', 'a'])).toBe('⚠ @ghost, @a not notified')
})

test('postLayout cuts a long post to its first rows and counts its more row', () => {
  const short = postLayout('14:32 a ', 'hi', 40, false)
  expect(short).toEqual({ body: 'hi', isLong: false, rows: 1 })
  // Just past three rows by length: cut, with an ellipsis and a more row.
  const long = postLayout('14:32 a ', 'x'.repeat(120), 40, false)
  expect(long.isLong).toBe(true)
  expect(long.rows).toBe(4)
  expect(long.body.endsWith('…')).toBe(true)
  expect([...long.body].length).toBeLessThan(120)
  expect(postLayout('14:32 a ', 'x'.repeat(120), 40, true)).toEqual({ body: 'x'.repeat(120), isLong: true, rows: 5 })
})

test('an error notice stays; a repeated mention notice gets its own half minute', async ($, on) => {
  const clock = mock.clock(on)
  world(on, true)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.input({ key: 'post', text: '@ghost one' })
  await clock.advance(25_000)
  await ui.input({ key: 'post', text: '@ghost two' })
  await clock.advance(6_000)
  expect(await ui.find({ type: 'Text', text: '⚠ @ghost not notified' })).toBeDefined()
  await clock.advance(25_000)
  expect(await ui.find({ type: 'Text', text: '⚠ @ghost not notified' })).toBeUndefined()
  await ui.unmount()
})

test('each author keeps one colour', () => {
  expect(authorColor('huddle-5a')).toBe(authorColor('huddle-5a'))
  expect(authorColor('huddle-5a')).toMatch(/^#[0-9a-f]{6}$/)
})

test('a notice clears itself after half a minute', async ($, on) => {
  const clock = mock.clock(on)
  const day = world(on, true)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.input({ key: 'post', text: '@ghost hello' })
  expect(await ui.find({ type: 'Text', text: '⚠ @ghost not notified' })).toBeDefined()
  await clock.advance(31_000)
  expect(await ui.find({ type: 'Text', text: '⚠ @ghost not notified' })).toBeUndefined()
  expect(day.appended.length).toBe(1)
  await ui.unmount()
})

test('a long post shows its first rows and opens with more', async ($, on) => {
  const day = world(on)
  day.lines = [`- 14:32 **coachcard-1e**: ${'word '.repeat(200)}END`]
  day.mtimeMs = 1
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /END/ })).toBeUndefined()
  await ui.press({ key: 'more-0' })
  expect(await ui.find({ type: 'Text', text: /END/ })).toBeDefined()
  expect((await ui.find({ key: 'more-0' }))?.props.label).toBe('Show less')
  await ui.unmount()
})

test('consecutive posts of one author group under one header, timed first to last', () => {
  const groups = groupPosts([
    '- 14:55 **you**: sup',
    '- 14:56 **you**: how is it going?',
    '- 15:00 **huddle-5a**: fine',
    'not a post',
    '- 15:34 **you**: ok',
  ])
  expect(groups.map((group) => ('raw' in group ? 'raw' : `${group.name}×${group.posts.length}`))).toEqual(['you×2', 'huddle-5a×1', 'raw', 'you×1'])
  const first = groups[0]!
  expect('posts' in first && groupTime(first.posts)).toBe('14:55 – 14:56')

  // One row a post and one a header: three rows keep the newest group whole and nothing older.
  const cost = { header: () => 1, post: () => 1, raw: () => 1 }
  expect(fitGroups(groups, 2, cost)).toEqual([groups[3]])
  // A group is cut from its oldest posts.
  const cut = fitGroups(groupPosts(['- 01:00 **you**: a', '- 01:01 **you**: b', '- 01:02 **you**: c']), 3, cost)
  expect(cut.flatMap((group) => ('posts' in group ? group.posts.map((post) => post.body) : []))).toEqual(['b', 'c'])
  // The newest post shows however tall it is.
  expect(fitGroups(groups, 0, cost)).toEqual([groups[3]])
})

test('splitCode, initials and statusWord', () => {
  expect(splitCode('mix `U+2588` and `x`')).toEqual([{ text: 'mix ' }, { text: 'U+2588', isCode: true }, { text: ' and ' }, { text: 'x', isCode: true }])
  expect(['Huddle', 'coachcard-5b', 'sprint 25', 'huddle-40', 'long-name-here', 'a'].map(initials)).toEqual(['HU', '5B', 'S25', '40', 'LH', 'A'])
  expect(['busy', 'idle', undefined, 'waiting'].map((status) => statusWord({ sessionId: 'x', name: 'x', status }))).toEqual([
    'working', 'idle', 'idle', 'waiting',
  ])
})

test('a mention being typed is found, completed and matched against the sessions', () => {
  expect(['hi @co', 'hi @', '@', 'mail x@y', 'hi @co ', 'hi'].map(mentionQueryOf)).toEqual(['co', '', '', null, null, null])
  expect(completeMention('hi @co', 'coachcard-1e')).toBe('hi @coachcard-1e ')
  expect(completeMention('hi @', 'sprint 25')).toBe('hi @sprint-25 ')
  const everyone = [
    { sessionId: 'a', name: 'huddle-5a' },
    { sessionId: 'b', name: 'coachcard-5b' },
    { sessionId: 'c', name: 'Huddle' },
    { sessionId: 'd', name: 'Huddle' },
    { sessionId: 'e', name: 'café' },
  ]
  // Starts first, then holds; one per handle; a name no mention spells is left out.
  expect(suggest(everyone, 'hu').map((peer) => peer.sessionId)).toEqual(['a', 'c'])
  expect(suggest(everyone, '5').map((peer) => peer.sessionId)).toEqual(['a', 'b'])
  expect(suggest(everyone, '').map((peer) => peer.sessionId)).toEqual(['a', 'b', 'c'])
})

test('typing @ lists matching sessions; picking one completes the mention', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(PANE(surface))
    const box = async () => (await ui.find({ key: 'post' }))?.props
    expect(await ui.find({ key: 'suggestions' })).toBeUndefined()
    const drawn = (await box())?.value

    await ui.input({ key: 'post', text: 'hey @co', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /Sessions matching “co”/ })).toBeDefined()
    expect(await ui.find({ key: 'suggest-s1' })).toBeDefined()
    expect(await ui.find({ key: 'suggest-sid' })).toBeUndefined()
    // Typing is still not drawn back.
    expect((await box())?.value).toBe(drawn)

    await ui.press({ key: 'suggest-s1' })
    expect((await box())?.value).toBe('hey @coachcard-1e ')
    expect(await ui.find({ key: 'suggestions' })).toBeUndefined()

    // The @ button starts a mention and lists every session.
    await ui.press({ key: 'mention-picker' })
    expect((await box())?.value).toBe('hey @coachcard-1e @')
    expect(await ui.find({ type: 'Text', text: /Mention a session/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).filter((button) => button.key?.startsWith('suggest-'))).toHaveLength(3)
    // Pressed again, it closes the list.
    await ui.press({ key: 'mention-picker' })
    expect(await ui.find({ key: 'suggestions' })).toBeUndefined()
    await ui.input({ key: 'post', text: '', kind: 'change' })
    await ui.unmount()
  }
  expect(day.appended).toEqual([])
})

test('off the terminal, Send posts what is typed; the terminal posts on Enter alone', async ($, on) => {
  const day = world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const term = await $.ui.mount(PANE('terminal'))
  expect(await term.find({ key: 'send' })).toBeUndefined()
  await term.unmount()

  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ type: 'Text', text: /Enter to send/ })).toBeDefined()
  await ui.input({ key: 'post', text: 'sent by button', kind: 'change' })
  await ui.press({ key: 'send' })
  expect(day.appended.at(-1)).toMatch(/\*\*you\*\*: sent by button$/)
  expect((await ui.find({ key: 'post' }))?.props.value).toBe('')
  await ui.unmount()
})

test('your consecutive posts share one time range; the idle sessions fold into one row', async ($, on) => {
  const day = world(on)
  day.lines = ['- 14:56 **you**: how is it?', '- 15:34 **you**: still there?']
  day.mtimeMs = 1
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '14:56 – 15:34' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^14:56$/ })).toBeUndefined()

  expect(await ui.find({ key: 'mention-s1' })).toBeUndefined()
  expect((await ui.find({ key: 'filter-active' }))?.props.label).toBe('Active 2')
  expect((await ui.find({ key: 'idle-fold' }))?.props.label).toBe('○ 1 idle · coachcard-1e')
  await ui.press({ key: 'idle-fold' })
  expect(await ui.find({ key: 'mention-s1' })).toBeDefined()
  expect(await ui.find({ key: 'idle-fold' })).toBeUndefined()
  await ui.press({ key: 'filter-active' })
  expect(await ui.find({ key: 'mention-s1' })).toBeUndefined()
  await ui.unmount()
})

test('a wide pane puts every session in a sidebar, grouped by what it is doing', async ($, on) => {
  const day = world(on)
  day.lines = ['- 14:32 **coachcard-1e**: QA is green']
  day.mtimeMs = 1
  await $.session.start(START)
  await $.command.run(HUDDLE)
  for (const surface of SURFACES) {
    const pane = PANE(surface)
    const ui = await $.ui.mount({ ...pane, props: { ...pane.props, bodyColumns: 140, scroll: { offset: 0, bodyRows: 30 } } })
    expect(await ui.find({ key: 'sidebar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'WORKING · 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'IDLE · 1' })).toBeDefined()
    // No filter or toggle there: the idle session is listed too.
    expect(await ui.find({ key: 'peers' })).toBeUndefined()
    expect(await ui.find({ key: 'mention-s1' })).toBeDefined()
    expect(await ui.find({ key: 'stop-bg1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'All messages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /QA is green/ })).toBeDefined()
    expect((await ui.find({ key: 'post' }))?.type).toBe('Input')
    await ui.unmount()
  }
})

test('All keeps the list order: background first, then newest', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'filter-all' })
  const keys = (await ui.findAll({ type: 'Button' })).map((button) => button.key).filter((key) => key?.startsWith('mention-') && key !== 'mention-picker')
  expect(keys).toEqual(['mention-bg-full', 'mention-s1', 'mention-sid'])
  await ui.unmount()
})

test('an @ right after a code span is no mention, as delivery reads it', async ($, on) => {
  const day = world(on)
  day.lines = ['- 14:34 **huddle-5a**: run `x`@foo then @bar']
  day.mtimeMs = 1
  await $.session.start(START)
  await $.command.run(HUDDLE)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^@foo$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^@bar$/ })).toBeDefined()
  await ui.unmount()
})
