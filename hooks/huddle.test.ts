import { expect, test } from 'claude-code/testing'
import {
  MAX_POST,
  appendLine,
  cleanName,
  cleanText,
  dayFile,
  formatEntry,
  huddleDir,
  lastLines,
  parseMentions,
  previousDayFile,
  tailFile,
  type Run,
} from './huddle.ts'

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
  expect(script).toBe('mkdir -p "$3" && printf "%s\\n" "$1" >> "$2" && chflags uappnd "$2" "$3"')
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
