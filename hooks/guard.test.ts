import { describe, expect, test } from 'claude-code/testing'
import { absolute, bashRewriteReason, collapse, expandBraces, isInside, relation, splitCommand, type Where } from './guard'

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
    [`rsync -a --delete empty/ ~/.claude/`, WHERE, /rsync/],
    [`rsync -a --delete empty ~/.claude/huddle-x/../`, WHERE, /rsync/],
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
    // Found in the second review.
    [`rm -rf /[z-a] ~/.claude/huddle`, WHERE, /rm/],
    [`echo "$(rm -rf ~/.claude/huddle)"`, WHERE, /rm/],
    [`echo "done: \`chflags nouappnd ${DAY}\`"`, WHERE, /chflags/],
    [`find ~/.claude/huddle -print0 |& xargs -0 rm`, WHERE, /xargs rm/],
    [`\\rm -rf ~/.claude/huddle`, WHERE, /rm/],
    [`rm -rf ~/.claude/hu\\ddle`, WHERE, /rm/],
    [`find ~/.claude/huddle -exec /bin/rm {} +`, WHERE, /find -exec rm/],
    [`rm -rf ~/.claude/{huddle,x}`, WHERE, /rm/],
    [`chflags nouappnd ~/.claude/{skills,hud*}/a.md`, WHERE, /chflags/],
    [`timeout 5 rm -rf ~/.claude/huddle`, WHERE, /rm/],
    [`timeout -s KILL 5 rm ${DAY}`, WHERE, /rm/],
    [`stdbuf -oL rm ${DAY}`, WHERE, /rm/],
    [`if true; then rm -rf ~/.claude/huddle; fi`, WHERE, /rm/],
    [`pushd ~/.claude && rm -rf huddle`, WHERE, /rm/],
    [`cp -R /tmp/huddle ~/.claude/`, WHERE, /cp onto/],
    [`rsync -a /tmp/huddle ~/.claude`, WHERE, /rsync onto/],
    [`cp -t ~/.claude/huddle /tmp/fake.md`, WHERE, /cp onto/],
    [`cp /tmp/fake.md --target-directory=${'~/.claude/huddle'}`, WHERE, /cp onto/],
    [`echo x >&${DAY}`, WHERE, /redirect/],
    // Found reviewing PR #2.
    [`rm -rf ~/.claude/{${Array.from({ length: 70 }, (_, i) => `a${i}`).join(',')},huddle}`, WHERE, /rm/],
    [`rm -rf ~/.claude/hu{c..e}dle`, WHERE, /rm/],
    [`rm -rf ~/.claude/"hud"'dle'`, WHERE, /rm/],
    [`touch x; rm -rf ~/.claude/'hud'dle/a.md`, WHERE, /rm/],
    [`cd ~/.claude && pushd /tmp && popd && rm -rf huddle`, WHERE, /rm/],
    [`cd ~/.claude && pushd /tmp && pushd && rm -rf huddle`, WHERE, /rm/],
    [`cd ~/.claude && (cd /tmp); rm -rf huddle`, WHERE, /rm/],
    [`cd ~/.claude && cd /tmp && cd - && rm -rf huddle`, WHERE, /rm/],
    [`rsync -a /tmp/evil/ ~/.claude/`, WHERE, /rsync onto/],
    [`ditto /tmp/evil ~/.claude`, WHERE, /ditto onto/],
    [`cp -RT /tmp/evil ~/.claude`, WHERE, /cp onto/],
    [`env -S 'rm -rf ~/.claude/huddle'`, WHERE, /rm/],
    [`env --split-string='chflags nouappnd ${DAY}'`, WHERE, /chflags/],
    [`${'eval '.repeat(12)}ls`, WHERE, /too deeply/],
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
    [`echo "today: $(date +%F)" > /tmp/stamp`, WHERE],
    [`cp notes.md ~/`, WHERE],
    [`cp -R dist ~/.claude/`, WHERE],
    [`timeout 30 npm test`, WHERE],
    [`ls ~/.claude/{skills,agents}`, WHERE],
    [`cmd 2>&1 >&2 | tee /tmp/log`, WHERE],
    [`if [ -f ${DAY} ]; then cat ${DAY}; fi`, WHERE],
    [`rm -f build/file{1..200}.o`, WHERE],
    [`rsync -a dist/ ~/Projects/app/public/`, WHERE],
    [`cd /tmp && pushd ~/Projects && popd && rm -rf scratch`, WHERE],
    [`env -S 'echo hi'`, WHERE],
    [`eval eval ls`, WHERE],
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

test('brace expansion lists each word, leaving ${…} alone', () => {
  expect(expandBraces('~/.claude/{huddle,x}/a')).toEqual(['~/.claude/huddle/a', '~/.claude/x/a'])
  expect(expandBraces('a{b,c{d,e}}')).toEqual(['ab', 'acd', 'ace'])
  expect(expandBraces('${HOME}/x')).toEqual(['${HOME}/x'])
  expect(expandBraces('{solo}')).toEqual(['{solo}'])
  expect(expandBraces('f{1..3}')).toEqual(['f1', 'f2', 'f3'])
  expect(expandBraces('hu{c..e}dle')).toEqual(['hucdle', 'huddle', 'huedle'])
  expect(expandBraces('{a,b}{1..40}')).toBeUndefined()
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
