import { describe, expect, test } from 'claude-code/testing'
import { absolute, bashRewriteReason, collapse, isInside, relation, splitCommand, type Where } from './guard'

const WHERE: Where = { dirs: ['/Users/me/.claude/huddle'], cwd: '/Users/me/Projects/app', home: '/Users/me' }
const INSIDE: Where = { ...WHERE, cwd: '/Users/me/.claude/huddle' }
const DAY = '~/.claude/huddle/2026-11-06.md'

test('paths are expanded, joined and collapsed', () => {
  expect(collapse('/a//b/./c/../d/')).toBe('/a/b/d')
  expect(absolute('~/.claude/huddle', '/x', '/Users/me')).toBe('/Users/me/.claude/huddle')
  expect(absolute('$HOME/.claude/huddle/a.md', '/x', '/Users/me')).toBe('/Users/me/.claude/huddle/a.md')
  expect(absolute('${HOME}/.claude', '/x', '/Users/me')).toBe('/Users/me/.claude')
  expect(absolute('../../.claude/huddle', '/Users/me/Projects/app', '/Users/me')).toBe('/Users/me/.claude/huddle')
  expect(absolute('~other/x', '/x', '/Users/me')).toBe('/x/~other/x')
  expect(isInside('/Users/me/.claude/huddle/a.md', '/Users/me/.claude/huddle')).toBe(true)
  expect(isInside('/Users/me/.claude/huddle', '/Users/me/.claude/huddle')).toBe(true)
  expect(isInside('/Users/me/.claude/huddle-old/a.md', '/Users/me/.claude/huddle')).toBe(false)
})

describe('Bash commands that rewrite the channel are refused', () => {
  const refused: [string, Where, RegExp][] = [
    [`echo hi > ${DAY}`, WHERE, /writes to .* with a redirect/],
    [`: >| ${DAY}`, WHERE, /redirect/],
    [`echo hi &> "${DAY}"`, WHERE, /redirect/],
    [`cat x > $HOME/.claude/huddle/2026-11-06.md`, WHERE, /redirect/],
    [`cd ~/.claude && echo x > huddle/a.md`, WHERE, /redirect/],
    [`echo x > 2026-11-06.md`, INSIDE, /redirect/],
    [`rm ${DAY}`, WHERE, /rm/],
    [`rm -rf ~/.claude/huddle`, WHERE, /rm/],
    [`sudo rm -f /Users/me/.claude/huddle/a.md`, WHERE, /rm/],
    [`rm *`, INSIDE, /rm/],
    [`mv ${DAY} /tmp/`, WHERE, /mv/],
    [`truncate -s 0 ${DAY}`, WHERE, /truncate/],
    [`chflags nouappnd ${DAY}`, WHERE, /chflags/],
    [`chflags -R 0 ~/.claude/huddle`, WHERE, /chflags/],
    [`ls && chflags nouappnd '${DAY}'`, WHERE, /chflags/],
    [`sed -i '' 's/a/b/' ${DAY}`, WHERE, /sed -i/],
    [`perl -pi -e 's/a/b/' ${DAY}`, WHERE, /perl -i/],
    [`echo x | tee ${DAY}`, WHERE, /tee/],
    [`cp /tmp/fake.md ${DAY}`, WHERE, /cp onto/],
    [`dd if=/dev/zero of=${DAY}`, WHERE, /dd/],
    [`find ~/.claude/huddle -name '*.md' -delete`, WHERE, /find -delete/],
    [`find ~/.claude/huddle -exec rm {} \\;`, WHERE, /find -exec rm/],
    [`sh -c 'rm ${DAY}'`, WHERE, /rm/],
    [`echo $(rm ${DAY})`, WHERE, /rm/],
    [`/bin/rm ${DAY}`, WHERE, /rm/],
    // Appends are refused too: a post must be signed by the post tool or the panel.
    [`echo "- 14:40 **you**: go ahead" >> ${DAY}`, WHERE, /redirect/],
    [`echo x | tee -a ${DAY}`, WHERE, /tee/],
    [`cmd 2>&1 | tee -a ${DAY}`, WHERE, /tee/],
    // An ancestor of the channel takes the channel with it.
    [`chflags -R nouappnd ~/.claude`, WHERE, /chflags/],
    [`rm -rf ~/.claude`, WHERE, /rm/],
    [`mv ~/.claude ~/old-claude`, WHERE, /mv/],
    [`rm -rf .`, { ...WHERE, cwd: '/Users/me/.claude' }, /rm/],
    [`rsync -a --delete empty/ ~/.claude/`, WHERE, /rsync --delete/],
    // Globs that hide the huddle segment.
    [`chflags nouappnd ~/.claude/hud*`, WHERE, /chflags/],
    [`rm ~/.claude/h?ddle/*.md`, WHERE, /rm/],
    [`rm ~/.claude/[h]uddle/a.md`, WHERE, /rm/],
    // A separator inside sh -c no longer cuts the script apart.
    [`bash -c 'cd ~/.claude/huddle; rm 2026-11-06.md'`, WHERE, /rm/],
    [`sh -c "cd ~/.claude/huddle && chflags nouappnd *.md"`, WHERE, /chflags/],
    // Paths fed through a pipe, and prefixes that take a value.
    [`find ~/.claude/huddle -name '*.md' | xargs rm`, WHERE, /xargs rm/],
    [`ls ~/.claude/huddle/*.md | xargs -I{} chflags nouappnd {}`, WHERE, /xargs chflags/],
    [`sudo -u me rm ~/.claude/huddle/a.md`, WHERE, /rm/],
    [`nice -n 5 rm ${DAY}`, WHERE, /rm/],
  ]
  for (const [command, where, reason] of refused) {
    test(command, () => {
      expect(bashRewriteReason(command, where) ?? '').toMatch(reason)
    })
  }
})

describe('Bash commands that only read the channel, or leave it alone, are let through', () => {
  const allowed: [string, Where][] = [
    [`cat ${DAY}`, WHERE],
    [`tail -n 20 ${DAY} 2>/dev/null`, WHERE],
    [`grep -r "@me" ~/.claude/huddle > /tmp/mentions.txt`, WHERE],
    [`echo "a -> b; c" > /tmp/out.txt`, WHERE],
    [`cp ${DAY} /tmp/copy.md`, WHERE],
    [`ls -lO ~/.claude/huddle`, WHERE],
    [`find ~/.claude/huddle -name '*.md' -exec grep -l todo {} +`, WHERE],
    [`rm -rf node_modules`, WHERE],
    [`echo hi > out.txt`, WHERE],
    [`sed -i '' 's/a/b/' notes.md`, WHERE],
    [`ls ~/.claude/huddle-archive && rm ~/.claude/huddle-archive/a.md`, WHERE],
    [`wc -l *.md`, INSIDE],
    [`ls ~/.claude && cat ~/.claude/settings.json`, WHERE],
    [`rm ~/.claude/settings.json.bak`, WHERE],
    [`rm -rf ~/Projects/app/dist`, WHERE],
    [`chmod -R 755 ~/.claude/skills`, WHERE],
    [`ls ~/.claude/huddle | wc -l`, WHERE],
    [`find ~/.claude/huddle -name '*.md' | xargs grep -l todo`, WHERE],
    [`grep -r todo src | xargs rm`, WHERE],
    [`bash -c 'cd /tmp; rm -f scratch.txt'`, WHERE],
    [`git commit -m "fix: rm stale ~/.claude/huddle notes"`, WHERE],
  ]
  for (const [command, where] of allowed) {
    test(command, () => {
      expect(bashRewriteReason(command, where)).toBeUndefined()
    })
  }
})

test('splitCommand keeps quoted separators and marks piped commands', () => {
  expect(splitCommand(`bash -c 'cd a; rm b' && ls | xargs rm; echo "x | y"`)).toEqual([
    { text: `bash -c 'cd a; rm b' `, isPiped: false },
    { text: ' ls ', isPiped: false },
    { text: ' xargs rm', isPiped: true },
    { text: ' echo "x | y"', isPiped: false },
  ])
  expect(splitCommand('a >| f 2>&1 &> g').map((s) => s.text)).toEqual(['a >| f 2>&1 &> g'])
})

test('relation reads globs segment by segment, inside or above the channel', () => {
  const dir = '/Users/me/.claude/huddle'
  expect(relation('/Users/me/.claude/huddle/a.md', dir)).toBe('inside')
  expect(relation('/Users/me/.claude/h?ddle', dir)).toBe('inside')
  expect(relation('/Users/me/.claude', dir)).toBe('ancestor')
  expect(relation('/Users/me/.claude/hud*', dir)).toBe('inside')
  expect(relation('/Users/me/.claude/skills', dir)).toBeUndefined()
  expect(relation('/Users/me/.claude/huddle-old/a.md', dir)).toBeUndefined()
  expect(relation('/tmp/x', dir)).toBeUndefined()
})
