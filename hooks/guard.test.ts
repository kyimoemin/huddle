import { describe, expect, test } from 'claude-code/testing'
import { absolute, bashRewriteReason, collapse, isInside, type Where } from './guard'

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
    [`echo hi > ${DAY}`, WHERE, /overwrites .* with >/],
    [`: >| ${DAY}`, WHERE, /with >/],
    [`echo hi &> "${DAY}"`, WHERE, /with >/],
    [`cat x > $HOME/.claude/huddle/2026-11-06.md`, WHERE, /with >/],
    [`cd ~/.claude && echo x > huddle/a.md`, WHERE, /with >/],
    [`echo x > 2026-11-06.md`, INSIDE, /with >/],
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
  ]
  for (const [command, where, reason] of refused) {
    test(command, () => {
      expect(bashRewriteReason(command, where) ?? '').toMatch(reason)
    })
  }
})

describe('Bash commands that read or append are let through', () => {
  const allowed: [string, Where][] = [
    [`cat ${DAY}`, WHERE],
    [`tail -n 20 ${DAY} 2>/dev/null`, WHERE],
    [`grep -r "@me" ~/.claude/huddle > /tmp/mentions.txt`, WHERE],
    [`echo "a -> b" >> ${DAY}`, WHERE],
    [`printf '%s\\n' hi >> ${DAY}`, WHERE],
    [`echo x | tee -a ${DAY}`, WHERE],
    [`cp ${DAY} /tmp/copy.md`, WHERE],
    [`ls -lO ~/.claude/huddle`, WHERE],
    [`find ~/.claude/huddle -name '*.md' -exec grep -l todo {} +`, WHERE],
    [`rm -rf node_modules`, WHERE],
    [`echo hi > out.txt`, WHERE],
    [`sed -i '' 's/a/b/' notes.md`, WHERE],
    [`ls ~/.claude/huddle-archive && rm ~/.claude/huddle-archive/a.md`, WHERE],
    [`wc -l *.md`, INSIDE],
    [`cmd 2>&1 | tee -a ${DAY}`, WHERE],
  ]
  for (const [command, where] of allowed) {
    test(command, () => {
      expect(bashRewriteReason(command, where)).toBeUndefined()
    })
  }
})
