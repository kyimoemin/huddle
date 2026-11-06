import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { POST_TOOL, READ_TOOL, SECTION_TEXT } from './register'

const WHOLE = { isStdoutTruncated: false, isStderrTruncated: false }
type Answer = { exitCode: number; stdout?: string; stderr?: string }

/**
 * Stands in for the engine beneath the mod: HOME is /h, this session's id is
 * `sid`, `claude agents --json` names it `huddle-5a`, and every other command
 * is answered by `answer`. Returns the argv of each command run.
 */
function engine(
  on: On,
  answer: (argv: readonly string[]) => Answer = () => ({ exitCode: 0 }),
  huddleDirEnv?: string,
  /**
   * `CLAUDE_CODE_EXECPATH`: a path holding `broken` does not start, one holding
   * `/old/` starts and fails; `claude` itself does not start with `noCli`.
   */
  cli: { execPath?: string; noCli?: boolean } = {},
) {
  const runs: (readonly string[])[] = []
  const registered: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__huddle__${e.name}` } }
  })
  on('env.get', (_, e) => ({
    value:
      e.name === 'HOME' ? '/h' : e.name === 'HUDDLE_DIR' ? huddleDirEnv : e.name === 'CLAUDE_CODE_EXECPATH' ? cli.execPath : undefined,
  }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/Users/me/Projects/huddle' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    const isCli = e.argv[0] === 'claude' || (cli.execPath !== undefined && e.argv[0] === cli.execPath)
    if (isCli && (e.argv[0]!.includes('broken') || (e.argv[0] === 'claude' && cli.noCli))) {
      return { deny: `spawn ${e.argv[0]} ENOENT` }
    }
    if (isCli && e.argv[0]!.includes('/old/')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'unknown command', ...WHOLE } }
    }
    if (isCli) {
      const rows = [
        { sessionId: 'other', name: 'coachcard-1e' },
        { sessionId: 'be-1', name: 'coachcard-be' },
        { sessionId: 'be-2', name: 'coachcard-be' },
        { sessionId: 'sid', name: 'huddle-5a' },
      ]
      return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '', ...WHOLE } }
    }
    const { exitCode, stdout = '', stderr = '' } = answer(e.argv)
    return { value: { exitCode, stdout, stderr, ...WHOLE } }
  })
  return { runs, registered }
}

const START = { cwd: '/Users/me/Projects/huddle', surface: 'terminal', isInteractive: true } as const

test('session start registers post and read', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start(START)
  expect(registered).toEqual(['post', 'read'])
})

test("post appends one entry, signed with this session's name, to today's file", async ($, on) => {
  const { runs } = engine(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: 'finished QA\nall green' })

  expect(done.deny).toBeUndefined()
  const append = runs.find((argv) => argv[0] === '/bin/sh')!
  const [, , , , line, file, dir] = append
  expect(line).toMatch(/^- \d\d:\d\d \*\*huddle-5a\*\*: finished QA \/ all green$/)
  expect(file).toMatch(/^\/h\/\.claude\/huddle\/\d{4}-\d\d-\d\d\.md$/)
  expect(dir).toBe('/h/.claude/huddle')
  expect(String(done.result)).toContain('Posted to #huddle')
})

test('HUDDLE_DIR moves the channel', async ($, on) => {
  const { runs } = engine(on, undefined, '/tmp/chan')
  await $.session.start(START)

  await $.tool.call({ tool: POST_TOOL, text: 'hi' })

  const [, , , , , file, dir] = runs.find((argv) => argv[0] === '/bin/sh')!
  expect(file).toMatch(/^\/tmp\/chan\/\d{4}-\d\d-\d\d\.md$/)
  expect(dir).toBe('/tmp/chan')
})

test('post refuses empty text without writing', async ($, on) => {
  const { runs } = engine(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '   ' })

  expect(done.deny).toContain('non-empty')
  expect(runs.some((argv) => argv[0] === '/bin/sh')).toBe(false)
})

test('a failed append comes back as an error naming the cause', async ($, on) => {
  engine(on, () => ({ exitCode: 1, stderr: 'Operation not permitted' }))
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: 'hi' })

  expect(done.deny).toContain('Operation not permitted')
})

test("read returns today's tail, and says so when there is nothing", async ($, on) => {
  const { runs } = engine(on, (argv) =>
    argv[0] === '/usr/bin/tail' ? { exitCode: 0, stdout: '- 14:32 **a**: one\n- 14:35 **you**: two\n' } : { exitCode: 0 },
  )
  await $.session.start(START)

  const done = await $.tool.call({ tool: READ_TOOL, tail: 9999 })

  expect(done.result).toBe('- 14:32 **a**: one\n- 14:35 **you**: two')
  const tail = runs.find((argv) => argv[0] === '/usr/bin/tail')!
  expect(tail.slice(0, 3)).toEqual(['/usr/bin/tail', '-n', '200'])
})

test('read with days 2 heads each day that has posts', async ($, on) => {
  engine(on, (argv) =>
    argv.at(-1)!.endsWith('.md') && argv[0] === '/usr/bin/tail'
      ? { exitCode: 0, stdout: `- 09:00 **x**: from ${argv.at(-1)!.slice(-13, -3)}\n` }
      : { exitCode: 0 },
  )
  await $.session.start(START)

  const text = String((await $.tool.call({ tool: READ_TOOL, days: 2 })).result)
  const lines = text.split('\n')

  expect(lines.length).toBe(4)
  expect(lines[0]).toMatch(/^## \d{4}-\d\d-\d\d$/)
  expect(lines[2]).toMatch(/^## \d{4}-\d\d-\d\d$/)
  expect(lines[1]).toContain(lines[0]!.slice(3))
})

test('read with days 2 still heads a day that has no posts', async ($, on) => {
  // Only today's file exists.
  engine(on, (argv) =>
    argv[0] === '/usr/bin/tail' && argv.at(-1)!.endsWith(`${today()}.md`)
      ? { exitCode: 0, stdout: '- 09:00 **x**: today\n' }
      : { exitCode: 1 },
  )
  await $.session.start(START)

  const lines = String((await $.tool.call({ tool: READ_TOOL, days: 2 })).result).split('\n')

  expect(lines).toEqual([lines[0], '(no posts)', `## ${today()}`, '- 09:00 **x**: today'])
  expect(lines[0]).toMatch(/^## \d{4}-\d\d-\d\d$/)
})

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('read of an empty channel says there are no posts', async ($, on) => {
  engine(on, () => ({ exitCode: 1, stderr: 'No such file or directory' }))
  await $.session.start(START)

  expect((await $.tool.call({ tool: READ_TOOL })).result).toBe('No posts today.')
  expect((await $.tool.call({ tool: READ_TOOL, days: 2 })).result).toBe('No posts today or yesterday.')
})

test('the system prompt gains the huddle section last, but not under --bare', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  const base = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null }
  const full = await $.prompt.compose({ ...base, traits: [] })
  expect(full.sections.map((s) => s.id)).toEqual(['intro', 'huddle:channel'])
  expect(full.sections[1]).toEqual({ id: 'huddle:channel', text: SECTION_TEXT, scope: 'session' })

  const bare = await $.prompt.compose({ ...base, traits: ['bare'] })
  expect(bare.sections.map((s) => s.id)).toEqual(['intro'])
})

/**
 * The file system beneath the guard: `/h` is really `/private/h`, and
 * `/links/chan` is a link to the channel. Every other path is missing.
 */
function files(on: On) {
  on('fs.stat', (_, e) => {
    const real = e.path.startsWith('/h/')
      ? `/private${e.path}`
      : e.path.startsWith('/links/chan')
        ? `/private/h/.claude/huddle${e.path.slice('/links/chan'.length)}`
        : undefined
    if (real === undefined || e.path.endsWith('.md')) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real } }
  })
  const ran: string[] = []
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: {} }
  })
  return { ran }
}

test('Write, Edit and NotebookEdit in the channel are refused before they run', async ($, on) => {
  engine(on)
  const { ran } = files(on)
  await $.session.start(START)

  const write = await $.tool.call({ tool: 'Write', file_path: '/h/.claude/huddle/2026-11-06.md', content: 'x' })
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/h/.claude/huddle/../huddle/a.md', old_string: 'a', new_string: 'b' })
  const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/h/.claude/huddle/n.ipynb', new_source: 'x' })

  expect(write.deny).toContain('append-only')
  expect(write.deny).toContain('mcp__huddle__post')
  expect(edit.deny).toContain('append-only')
  expect(notebook.deny).toContain('append-only')
  expect(ran).toEqual([])
})

test('a link into the channel is refused too', async ($, on) => {
  engine(on)
  const { ran } = files(on)
  await $.session.start(START)

  const write = await $.tool.call({ tool: 'Write', file_path: '/links/chan/2026-11-06.md', content: 'x' })

  expect(write.deny).toContain('append-only')
  expect(ran).toEqual([])
})

test('writes elsewhere and Bash reads run as usual; a Bash append is refused', async ($, on) => {
  engine(on)
  const { ran } = files(on)
  await $.session.start(START)

  await $.tool.call({ tool: 'Write', file_path: '/h/notes/huddle.md', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'tail -n 5 ~/.claude/huddle/2026-11-06.md' })
  const append = await $.tool.call({ tool: 'Bash', command: 'echo "- 14:40 **you**: hi" >> ~/.claude/huddle/2026-11-06.md' })

  expect(ran).toEqual(['Write', 'Bash'])
  expect(append.deny).toContain('mcp__huddle__post')
})

test('Bash that rewrites or unflags the channel is refused with the reason', async ($, on) => {
  engine(on)
  const { ran } = files(on)
  await $.session.start(START)

  const unflag = await $.tool.call({ tool: 'Bash', command: 'chflags nouappnd ~/.claude/huddle/*.md' })
  const clobber = await $.tool.call({ tool: 'Bash', command: 'echo x > /private/h/.claude/huddle/2026-11-06.md' })

  expect(unflag.deny).toContain('runs chflags on it')
  expect(clobber.deny).toContain('with a redirect')
  expect(ran).toEqual([])
})

test('the guard protects ~/.claude/huddle even while HUDDLE_DIR points elsewhere', async ($, on) => {
  engine(on, undefined, '/tmp/chan')
  files(on)
  await $.session.start(START)

  const real = await $.tool.call({ tool: 'Bash', command: 'rm ~/.claude/huddle/2026-11-06.md' })
  const test = await $.tool.call({ tool: 'Bash', command: 'rm /tmp/chan/2026-11-06.md' })

  expect(real.deny).toContain('runs rm on it')
  expect(test.deny).toContain('runs rm on it')
})

/** Records each message the mod sends; `refuse` names session ids that refuse. */
function mailbox(on: On, refuse: readonly string[] = []) {
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })
    return refuse.some((id) => e.to.includes(id))
      ? { isDelivered: false, reason: 'recipient gone' }
      : { isDelivered: true }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { sent, toasts }
}

test('a post @mentioning sessions messages each of them, a shared name each holder', async ($, on) => {
  const { runs } = engine(on)
  const { sent, toasts } = mailbox(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e and @coachcard-be: QA is green' })

  expect(sent.length).toBe(3)
  expect(sent.every((m) => m.text.startsWith('You were mentioned in #huddle by huddle-5a:'))).toBe(true)
  expect(sent.every((m) => m.text.includes('**huddle-5a**: @coachcard-1e and @coachcard-be: QA is green'))).toBe(true)
  expect(String(done.result)).toContain('Mentions: notified @coachcard-1e, @coachcard-be')
  expect(toasts).toEqual([])
  // One sessions lookup serves both the author's name and the mentions.
  expect(runs.filter((argv) => argv[0] === 'claude').length).toBe(1)
})

test('an unknown name or a refused delivery is reported and toasted; the post still stands', async ($, on) => {
  const { runs } = engine(on)
  const { sent, toasts } = mailbox(on, ['other'])
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '@ghost @coachcard-1e @huddle-5a @you hi' })

  expect(runs.some((argv) => argv[0] === '/bin/sh')).toBe(true)
  expect(done.deny).toBeUndefined()
  expect(sent.length).toBe(1)
  const result = String(done.result)
  expect(result).toContain('@ghost: no running session has that name')
  expect(result).toContain('@coachcard-1e (recipient gone): not delivered')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('@ghost')
})

test('a post with no mentions sends nothing', async ($, on) => {
  engine(on)
  const { sent } = mailbox(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: 'mail me@example.com' })

  expect(sent).toEqual([])
  expect(String(done.result)).not.toContain('Mentions')
})

test("the CLI runs as the session's own binary when CLAUDE_CODE_EXECPATH is set", async ($, on) => {
  const bundled = '/Applications/Claude.app/Contents/Resources/claude'
  const { runs } = engine(on, undefined, undefined, { execPath: bundled })
  mailbox(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e hi' })

  expect(String(done.result)).toContain('**huddle-5a**')
  expect(String(done.result)).toContain('notified @coachcard-1e')
  expect(runs.filter((argv) => argv[1] === 'agents').map((argv) => argv[0])).toEqual([bundled])
})

test('a bundled binary that will not start falls back to claude on the PATH', async ($, on) => {
  const { runs } = engine(on, undefined, undefined, { execPath: '/broken/claude' })
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: 'hi' })

  expect(String(done.result)).toContain('**huddle-5a**')
  expect(runs.filter((argv) => argv[1] === 'agents').map((argv) => argv[0])).toEqual(['/broken/claude', 'claude'])
})

test('with no claude CLI at all, posts still land, signed with the folder, and mentions say why', async ($, on) => {
  const { runs } = engine(on, undefined, undefined, { noCli: true })
  const { toasts } = mailbox(on)
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e hi' })

  expect(done.deny).toBeUndefined()
  expect(runs.some((argv) => argv[0] === '/bin/sh')).toBe(true)
  expect(String(done.result)).toContain('**huddle**: @coachcard-1e hi')
  expect(String(done.result)).toContain('the claude command could not be run')
  expect(toasts[0]).toContain('mentions not delivered')
})

test('with no claude CLI, ListAgents names this session and mentions go to name [ref]', async ($, on) => {
  engine(on, undefined, undefined, { noCli: true })
  const { sent } = mailbox(on)
  on('tool.call', { tool: 'ListAgents' }, () => ({
    result: {
      listing: 'This session is huddle-5a [2195f3] — the name other sessions use to message it.',
      sections: [{ kind: 'sessions', total: 1, rows: [{ name: 'coachcard-1e', ref: '3d3fa0', type: 'interactive', status: 'idle' }] }],
    },
  }))
  await $.session.start(START)

  const done = await $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e hi' })

  expect(String(done.result)).toContain('**huddle-5a**: @coachcard-1e hi')
  expect(String(done.result)).toContain('notified @coachcard-1e')
  expect(sent.map((m) => m.to)).toEqual(['coachcard-1e [3d3fa0]'])
})

test('overlapping lookups share one claude agents run', async ($, on) => {
  const { runs } = engine(on)
  mailbox(on)
  await $.session.start(START)

  await Promise.all([
    $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e one' }),
    $.tool.call({ tool: POST_TOOL, text: '@coachcard-1e two' }),
  ])

  expect(runs.filter((argv) => argv[1] === 'agents').length).toBe(1)
})

test("a bundled binary that runs but fails is retried as claude on the PATH", async ($, on) => {
  const { runs } = engine(on, undefined, undefined, { execPath: '/old/claude' })
  await $.session.start(START)
  const done = await $.tool.call({ tool: POST_TOOL, text: 'hi' })

  expect(String(done.result)).toContain('**huddle-5a**')
  expect(runs.filter((argv) => argv[1] === 'agents').map((argv) => argv[0])).toEqual(['/old/claude', 'claude'])
})
