import type { Register } from 'claude-code'
import { huddleDir } from './huddle'
import { absolute, bashRewriteReason, collapse, isInside, type Where } from './guard'
import { type $, deliverMentions, errorText, ownName, post, read } from './channel'
import { registerPanel, startPanel } from './panel'

// Literal so `claude plugin validate` can read the matchers that use them.
export const POST_TOOL = 'mcp__huddle__post'
export const READ_TOOL = 'mcp__huddle__read'

const SECTION_ID = 'huddle:channel'
const DEFAULT_TAIL = 50
const MAX_TAIL = 200

export const SECTION_TEXT = [
  '# huddle',
  'There is one shared channel, #huddle, that the person and every local Claude Code session can read and post to.',
  `- Post with ${POST_TOOL} when the person or another session would want to know: a result, a hand-off, a blocker, or an answer to someone who mentioned you. Keep posts short.`,
  `- Read it with ${READ_TOOL} only when it bears on your task or you were mentioned. Do not read it otherwise.`,
  '- Write @name to mention a session by the name ListAgents shows. A mentioned session gets a message saying so.',
].join('\n')

/** Where a path really lands, following links; a missing file through its folder. */
async function realPath($: $, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    const cut = path.lastIndexOf('/')
    if (cut <= 0) return undefined
    try {
      const dir = (await $.fs.stat(path.slice(0, cut), { resolve: true })).realPath
      return dir === undefined ? undefined : `${dir}/${path.slice(cut + 1)}`
    } catch {
      return undefined
    }
  }
}

/**
 * The channel as the guard matches it: ~/.claude/huddle always (so testing
 * with HUDDLE_DIR still protects the real one), HUDDLE_DIR when set, and the
 * real path of each, so a link or /tmp vs /private/tmp is no way around it.
 */
async function guardWhere($: $): Promise<Where> {
  const cwd = await $.session.cwd()
  if (guardDirs) return { ...guardDirs, cwd }
  const home = (await $.env.get('HOME')) ?? ''
  const lexical = [huddleDir(home), (await $.env.get('HUDDLE_DIR')) ?? '']
    .filter((dir) => dir !== '')
    .map((dir) => absolute(dir, cwd, home))
  const real = await Promise.all(lexical.map((dir) => realPath($, dir)))
  const resolved = real.filter((dir): dir is string => dir !== undefined).map(collapse)
  const found = { dirs: [...new Set([...lexical, ...resolved])], home }
  // Keep it once every folder resolved; until the first post makes the folder,
  // ask again next time so its real path is picked up.
  if (resolved.length === lexical.length) guardDirs = found
  return { ...found, cwd }
}

let guardDirs: { dirs: string[]; home: string } | undefined

const refusal = (what: string) =>
  `huddle: #huddle is append-only, so this call was refused: it ${what}. Post with ${POST_TOOL} and read with ${READ_TOOL}.`

const clampTail = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_TAIL, Math.max(1, Math.floor(value)))
    : DEFAULT_TAIL

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'post',
      description:
        'Append one message to #huddle, the channel shared by the person and every local Claude Code session. Append-only: posts cannot be edited or deleted. Newlines become " / "; over 2,000 characters is cut. Write @name to mention a session.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The message.' } },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'read',
      description:
        "Read the newest #huddle messages: today's by default, or yesterday's as well with days: 2. Call only when the channel bears on your task or you were mentioned.",
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', enum: [1, 2], description: '1 for today (default), 2 to add yesterday.' },
          tail: { type: 'integer', minimum: 1, maximum: MAX_TAIL, description: `Newest lines per day (default ${DEFAULT_TAIL}).` },
        },
      },
      isDeferred: false,
    })
    await startPanel($)
    return started
  })

  on('tool.call', { tool: POST_TOOL }, async ($, e) => {
    const text = (e as { text?: unknown }).text
    if (typeof text !== 'string' || text.trim() === '') return { deny: 'huddle: text must be a non-empty string.' }
    try {
      const author = await ownName($)
      const line = await post($, author, text)
      const mentions = await deliverMentions($, author, text, line)
      return { result: `Posted to #huddle: ${line}${mentions ? `\nMentions: ${mentions}` : ''}` }
    } catch (error) {
      return { deny: `huddle: the post was not saved: ${errorText(error)}` }
    }
  })

  on('tool.call', { tool: READ_TOOL }, async ($, e) => {
    const input = e as { days?: unknown; tail?: unknown }
    try {
      return { result: await read($, input.days === 2 ? 2 : 1, clampTail(input.tail)) }
    } catch (error) {
      return { deny: `huddle: could not read the channel: ${errorText(error)}` }
    }
  })

  // Layer 2 of the append-only rule: no file tool writes in the channel, and
  // no Bash command rewrites, deletes, moves or unflags it. Best effort; the
  // uappnd flag is the hard stop, so a guard that fails lets the call through.
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const where = await guardWhere($)
    const lexical = absolute(path, where.cwd, where.home)
    const real = await realPath($, lexical)
    const hits = [lexical, real].some((p) => p !== undefined && where.dirs.some((dir) => isInside(collapse(p), dir)))
    return hits ? { deny: refusal(`uses ${e.tool} on ${path}`) } : next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reason = bashRewriteReason(e.command, await guardWhere($))
    return reason === undefined ? next(e) : { deny: refusal(reason) }
  })

  // Both tools touch only ~/.claude/huddle, and post can only append there.
  on('tool.check', { tool: POST_TOOL }, () => ({ decision: 'allow', reason: 'huddle: append-only channel' }))
  on('tool.check', { tool: READ_TOOL }, () => ({ decision: 'allow', reason: 'huddle: read-only' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) return composed
    return { sections: [...composed.sections, { id: SECTION_ID, text: SECTION_TEXT, scope: 'session' }] }
  })

  registerPanel(on)
}
