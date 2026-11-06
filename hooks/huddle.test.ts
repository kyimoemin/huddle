import { expect, test } from 'claude-code/testing'
import {
  MAX_POST,
  addMention,
  appendLine,
  compactTokens,
  handle,
  lastContextTokens,
  sessionIcon,
  transcriptFile,
  cleanName,
  cleanText,
  dayFile,
  formatEntry,
  huddleDir,
  lastLines,
  mentionMessage,
  parseListAgents,
  parseSessions,
  resolveMentions,
  parseMentions,
  previousDayFile,
  tailFile,
  type Run,
} from './huddle'

/** A fake runner that records each argv and answers with `answer(argv)`. */
function fakeRun(answer: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string }) {
  const calls: (readonly string[])[] = []
  const run: Run = async (argv) => {
    calls.push(argv)
    const { exitCode, stdout = '', stderr = '' } = answer(argv)
    return { exitCode, stdout, stderr }
  }
  return { run, calls }
}

// Local-time constructor, so these hold in any time zone.
const AT = new Date(2026, 10, 6, 14, 32, 9)

test('the channel is ~/.claude/huddle, one file per local date', () => {
  expect(huddleDir('/Users/me/')).toBe('/Users/me/.claude/huddle')
  expect(dayFile('/Users/me/.claude/huddle', AT)).toBe('/Users/me/.claude/huddle/2026-11-06.md')
  expect(dayFile('/d/', AT)).toBe('/d/2026-11-06.md')
  expect(previousDayFile('/d', AT)).toBe('/d/2026-11-05.md')
  expect(previousDayFile('/d', new Date(2026, 2, 1, 0, 5))).toBe('/d/2026-02-28.md')
})

test('an entry is one line: time, bold name, text', () => {
  expect(formatEntry({ at: AT, name: 'coachcard-1e', text: 'finished QA' })).toBe(
    '- 14:32 **coachcard-1e**: finished QA',
  )
  expect(formatEntry({ at: new Date(2026, 0, 2, 9, 5), name: 'you', text: 'hi' })).toBe(
    '- 09:05 **you**: hi',
  )
})

test('line breaks become " / " and blank lines drop out', () => {
  expect(cleanText('  one\n\ntwo\r\nthree\rfour  ')).toBe('one / two / three / four')
  expect(cleanText('a\n   \nb')).toBe('a / b')
})

test('a post over the cap is cut to MAX_POST characters ending in …', () => {
  const cut = cleanText('x'.repeat(MAX_POST + 50))
  expect([...cut].length).toBe(MAX_POST)
  expect(cut.endsWith('…')).toBe(true)
  expect(cleanText('y'.repeat(MAX_POST))).toBe('y'.repeat(MAX_POST))
})

test('an author name cannot break the bold or the line', () => {
  expect(cleanName('**evil**\nname')).toBe('evil name')
  expect(cleanName('  ')).toBe('unknown')
})

test('mentions are found once each, not inside emails, without trailing dots', () => {
  expect(parseMentions('@coachcard-1e which tests? cc @you, and @coachcard-1e.')).toEqual([
    'coachcard-1e',
    'you',
  ])
  expect(parseMentions('mail me@example.com (@sprint_25)')).toEqual(['sprint_25'])
  expect(parseMentions('no mentions here')).toEqual([])
})

test('lastLines keeps the newest non-empty lines', () => {
  expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\n', 5)).toEqual(['a'])
  expect(lastLines('', 5)).toEqual([])
  expect(lastLines('a\nb', 0)).toEqual([])
})

test('appendLine is one sh call with the line and paths as positional args', async () => {
  const { run, calls } = fakeRun(() => ({ exitCode: 0 }))

  const file = '/h/.claude/huddle/2026-11-06.md'
  const line = '- 14:32 **you**: $(rm -rf ~) "quoted" `tick`'
  await appendLine(run, file, line)

  expect(calls.length).toBe(1)
  const [sh, flag, script, arg0, ...args] = calls[0]!
  expect([sh, flag, arg0]).toEqual(['/bin/sh', '-c', 'sh'])
  expect(script).toBe('mkdir -p "$3" && printf "%s\\n" "$1" >> "$2" && { chflags uappnd "$2" "$3" 2>/dev/null || true; }')
  expect(args).toEqual([line, file, '/h/.claude/huddle'])
  // The script never carries the post text.
  expect(script!.includes('rm -rf')).toBe(false)
})

test('appendLine throws when the write fails', async () => {
  const { run } = fakeRun(() => ({ exitCode: 1, stderr: 'Operation not permitted\n' }))

  let message = ''
  try {
    await appendLine(run, '/h/.claude/huddle/2026-11-06.md', 'x')
  } catch (error) {
    message = String(error)
  }
  expect(message.includes('Operation not permitted')).toBe(true)
})

test('tailFile reads the last lines with tail, and nothing for a missing file', async () => {
  const { run, calls } = fakeRun((argv) =>
    argv.at(-1)!.endsWith('missing.md')
      ? { exitCode: 1, stderr: 'No such file or directory' }
      : { exitCode: 0, stdout: '- 14:32 **a**: one\n- 14:35 **b**: two\n' },
  )

  expect(await tailFile(run, '/h/day.md', 50)).toEqual(['- 14:32 **a**: one', '- 14:35 **b**: two'])
  expect(calls[0]).toEqual(['/usr/bin/tail', '-n', '50', '/h/day.md'])
  expect(await tailFile(run, '/h/missing.md', 50)).toEqual([])
  expect(await tailFile(run, '/h/day.md', 0)).toEqual([])
  expect(calls.length).toBe(2)
})

const ROWS = [
  { sessionId: 's1', name: 'coachcard-1e' },
  { sessionId: 's2', name: 'coachcard-be' },
  { sessionId: 's3', name: 'coachcard-be' },
  { sessionId: 'me', name: 'huddle-5a' },
]

test('a mention reaches every session with that name, case-insensitively', () => {
  expect(resolveMentions(['Coachcard-1E', 'coachcard-be'], ROWS, 'me')).toEqual({
    targets: [
      { name: 'coachcard-1e', sessionId: 's1' },
      { name: 'coachcard-be', sessionId: 's2' },
      { name: 'coachcard-be', sessionId: 's3' },
    ],
    unknown: [],
  })
})

test('self and @you reach nobody and are not unknown; other names are', () => {
  expect(resolveMentions(['huddle-5a', 'you', 'ghost'], ROWS, 'me')).toEqual({ targets: [], unknown: ['ghost'] })
})

test('the mention message names the author and carries the line', () => {
  const text = mentionMessage('huddle-5a', '- 14:35 **huddle-5a**: @coachcard-1e which tests?')
  expect(text.startsWith('You were mentioned in #huddle by huddle-5a:\n- 14:35')).toBe(true)
  expect(text).toContain('mcp__huddle__post')
})

test('parseSessions keeps rows with a sessionId and a name', () => {
  const out = JSON.stringify([{ sessionId: 'a', name: 'x', pid: 1 }, { sessionId: 'b' }, null, { name: 'y' }])
  expect(parseSessions(out)).toEqual([{ sessionId: 'a', name: 'x', pid: 1 } as never])
  expect(parseSessions('{}')).toEqual([])
})

test('ListAgents rows stand in for claude agents: self from the header, peers by name [ref]', () => {
  const rows = parseListAgents(
    {
      listing: 'This session is huddle-5a [2195f3] — the name other sessions use to message it.\n\nPeer sessions (2): ...',
      sections: [
        {
          kind: 'sessions',
          rows: [
            { name: 'coachcard-1e', ref: '3d3fa0', type: 'interactive', status: 'idle' },
            { name: 'nightly-qa', ref: '[06853d]', type: 'background', status: 'busy' },
            { name: 'laptop-2', ref: 'abcdef', type: 'remote', status: 'idle' },
            { ref: 'ffffff' },
          ],
        },
        // Not local sessions: left out.
        { kind: 'subagents', rows: [{ name: 'explorer', id: 'a1', type: 'Explore', status: 'busy' }] },
      ],
    },
    'sid',
  )
  expect(rows).toEqual([
    { sessionId: 'sid', name: 'huddle-5a' },
    { sessionId: 'ref:3d3fa0', name: 'coachcard-1e', kind: 'interactive', status: 'idle', address: 'coachcard-1e [3d3fa0]' },
    { sessionId: 'ref:06853d', name: 'nightly-qa', kind: 'background', status: 'busy', address: 'nightly-qa [06853d]' },
  ])
  // No row carries the short id Stop needs.
  expect(rows.some((row) => row.id !== undefined)).toBe(false)
  expect(resolveMentions(['coachcard-1e'], rows, 'sid').targets).toEqual([
    { name: 'coachcard-1e', sessionId: 'ref:3d3fa0', address: 'coachcard-1e [3d3fa0]' },
  ])
  expect(parseListAgents({}, 'sid')).toEqual([])
})

test('mentions differing only in case reach a session once', () => {
  expect(parseMentions('@Docs-pass see above, @docs-pass ping')).toEqual(['Docs-pass'])
})

test("the person can mention this session from its own panel; a session can't mention itself", () => {
  expect(resolveMentions(['huddle-5a'], ROWS, 'me', true)).toEqual({
    targets: [{ name: 'huddle-5a', sessionId: 'me', isSelf: true }],
    unknown: [],
  })
  expect(resolveMentions(['huddle-5a'], ROWS, 'me')).toEqual({ targets: [], unknown: [] })
})

test('a name with spaces is mentioned with dashes; the plain name still works', () => {
  expect(handle(' sprint  25 ')).toBe('sprint-25')
  const rows = [{ sessionId: 's1', name: 'sprint 25' }, { sessionId: 's2', name: 'huddle-5a' }]
  expect(resolveMentions(parseMentions('@Sprint-25 and @huddle-5a'), rows, 'me').targets.map((t) => t.sessionId)).toEqual(['s1', 's2'])
})

test('addMention appends @handle once, spaced from what is typed', () => {
  expect(addMention('', 'sprint 25')).toBe('@sprint-25 ')
  expect(addMention('hey', 'b')).toBe('hey @b ')
  expect(addMention('hey ', 'b')).toBe('hey @b ')
  expect(addMention('hey @B ', 'b')).toBe('hey @B ')
})

test('a session keeps one icon, picked by its id', () => {
  expect(sessionIcon('abc')).toBe(sessionIcon('abc'))
  const icons = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(sessionIcon))
  expect(icons.size).toBeGreaterThan(3)
})

test('the transcript path is the cwd with every other character a dash', () => {
  expect(transcriptFile('/h/.claude/', '/Users/me/my.proj', 'sid')).toBe('/h/.claude/projects/-Users-me-my-proj/sid.jsonl')
})

test("a transcript's context is its last main-thread reply's input tokens", () => {
  const reply = (tokens: number, extra: object = {}) =>
    JSON.stringify({
      type: 'assistant',
      ...extra,
      message: { model: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: tokens, cache_creation_input_tokens: 10, output_tokens: 5 } },
    })
  const text = ['{"cut', reply(100), JSON.stringify({ type: 'user' }), reply(900, { isSidechain: true }), ''].join('\n')
  expect(lastContextTokens(text)).toEqual({ tokens: 112, model: 'm1' })
  expect(lastContextTokens('{"type":"user"}\n')).toBeUndefined()
})

test('token counts are compact', () => {
  expect(compactTokens(950)).toBe('950')
  expect(compactTokens(114_247)).toBe('114k')
  expect(compactTokens(1_000_000)).toBe('1M')
  expect(compactTokens(1_250_000)).toBe('1.3M')
})
