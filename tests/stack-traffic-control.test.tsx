import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Two stacks in /repo: main → b1 → b2, and main → c1. /plain has never used gh stack.
const FILE = JSON.stringify({
  schemaVersion: 1,
  stacks: [
    { trunk: { branch: 'main' }, branches: [{ branch: 'b1' }, { branch: 'b2' }] },
    { trunk: { branch: 'main' }, branches: [{ branch: 'c1' }] },
  ],
})
const VIEW = JSON.stringify({
  trunk: 'main',
  currentBranch: 'b2',
  branches: [
    { name: 'b1', isMerged: false, isQueued: false, needsRebase: true },
    { name: 'b2', isMerged: false, isQueued: false, needsRebase: false },
  ],
})

type Proc = { exitCode: number; stdout?: string; stderr?: string }
const out = (p: Proc) => ({ value: { exitCode: p.exitCode, stdout: p.stdout ?? '', stderr: p.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } })
const ok = (stdout = '') => out({ exitCode: 0, stdout })
const fail = (exitCode = 1) => out({ exitCode })

type Host = {
  branch?: string // current branch in /repo ('' = detached)
  testExit?: number // exit of `test -e` for the stack file
  file?: string
  repo?: string
  prHeads?: Record<string, string>
  config?: Record<string, string>
  sessionDir?: string // what `git rev-parse --show-toplevel` answers with no cwd
}

function host(on: On, opts: Host = {}, seen: Array<{ argv: string[]; cwd?: string }> = []) {
  const branch = opts.branch ?? 'b2'
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const cwd = e.init?.cwd
    seen.push({ argv, cwd })
    const cmd = argv.join(' ')
    const where = cwd ?? opts.sessionDir ?? '/repo'
    const repo = where.startsWith('/plain') ? '/plain' : where.startsWith('/home/me/stack') ? '/home/me/stack' : where.startsWith('/repo') ? '/repo' : null
    if (argv[0] === 'test' && argv[1] === '-d') return ['/repo', '/plain', '/home/me/stack', '/tmp'].includes(argv[2] as string) ? ok() : fail(1)
    if (cmd === 'git rev-parse --show-toplevel') return repo === null ? out({ exitCode: 128, stderr: 'fatal: not a git repository' }) : ok(`${repo}\n`)
    if (repo === '/plain') {
      if (cmd === 'git symbolic-ref --quiet --short HEAD') return ok('main\n')
      if (cmd === 'git rev-parse --git-common-dir') return ok('.git\n')
      if (cmd.startsWith('test -e')) return fail(1)
      return fail(2)
    }
    if (cmd === 'git symbolic-ref --quiet --short HEAD') return branch === '' ? fail(1) : ok(`${branch}\n`)
    if (cmd === 'git rev-parse --git-common-dir') return ok('.git\n')
    if (cmd.startsWith('test -e')) return out({ exitCode: opts.testExit ?? 0 })
    if (cmd.startsWith('cat ')) return ok(opts.file ?? FILE)
    if (cmd === 'gh stack view --json') return branch === 'b2' ? ok(VIEW) : fail(2)
    if (cmd.startsWith('git merge-base --is-ancestor')) return ok()
    if (cmd === 'git remote') return ok('origin\n')
    if (cmd.startsWith('git config --get-regexp ')) {
      const entries = Object.entries(opts.config ?? {})
      return entries.length === 0 ? fail(1) : ok(entries.map(([k, v]) => `${k} ${v}`).join('\n') + '\n')
    }
    if (cmd.startsWith('gh repo view')) return ok(`${opts.repo ?? 'me/repo'}\n`)
    if (cmd.startsWith('gh pr view') && cmd.includes('headRefName')) {
      const head = opts.prHeads?.[argv[3] as string]
      return head === undefined ? fail() : ok(`${head}\n`)
    }
    return fail(2)
  })
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
}

const ran = (on: On, isError = false) => {
  const calls: string[] = []
  on('tool.call', (_$, e) => {
    calls.push(String((e as { command?: unknown }).command))
    return isError ? { isError: true as const, result: 'failed', text: 'failed' } : { result: 'ok' }
  })
  return calls
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const denied = async (call: Promise<{ deny?: string }>) => (await call).deny ?? ''

test('force-pushes and deletes of any stack branch are redirected', async ($, on) => {
  host(on)
  const calls = ran(on)
  for (const command of [
    'git push --force', 'git push -f origin b2', 'git push --force-with-lease', 'git push origin +b1',
    'git push -uf origin b2', 'git push --mirror origin', 'git push --force origin HEAD:b1',
    'git push -f origin c1', 'git push --force origin "refs/heads/*"', "git push origin '+refs/heads/*:refs/heads/*'",
    'git push origin :b1', 'git push --delete origin b1', 'git push -d origin c1', 'git push --repo origin +b2',
    'git push --repo=origin +b2', 'git push origin +b2>/tmp/push.log', 'git push -f origin main',
  ]) {
    expect(await denied($.tool.call(bash(command)))).toMatch(/gh stack push/)
  }
  expect(calls.length).toBe(0)
})

test('force-pushing a tag or an unrelated branch passes', async ($, on) => {
  host(on)
  const calls = ran(on)
  await $.tool.call(bash('git push --force origin v1.2.3'))
  await $.tool.call(bash('git push origin +refs/tags/v1'))
  await $.tool.call(bash('git push -f origin scratch'))
  await $.tool.call(bash('git push origin b2 2>&1'))
  expect(calls.length).toBe(4)
})

test('off the stack, the stack branches are still protected', async ($, on) => {
  host(on, { branch: 'scratch' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git push --force origin HEAD:b2')))).toMatch(/b2/)
  expect(await denied($.tool.call(bash('git push --all --force')))).toMatch(/--all/)
  await $.tool.call(bash('git push --force'))
  await $.tool.call(bash('git rebase main'))
  await $.tool.call(bash('git pull --rebase'))
  expect(calls.length).toBe(3)
})

test('detached HEAD in a stack repo: forced pushes are refused, rebase control runs', async ($, on) => {
  host(on, { branch: '' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/detached/)
  await $.tool.call(bash('git rebase --continue'))
  expect(calls).toEqual(['git rebase --continue'])
})

test('wrappers, subshells, keywords, substitutions and continuations are seen through', async ($, on) => {
  host(on)
  const calls = ran(on)
  for (const command of [
    '(git push --force)', '{ git push --force; }', "bash -c 'git push --force'", 'env FOO=1 git push --force',
    'sudo -u me git push -f', 'echo "$(git push --force)"', 'git push --\\\nforce', 'command git push -f',
    'nohup git push --force &', 'git -C /repo push --force', 'git -C/repo push --force', 'git --git-dir=/repo/.git push -f',
    'if true; then git push --force; fi', 'while true; do git push -f; done', '! git push -f',
    'env -C /repo git push --force',
  ]) {
    expect(await denied($.tool.call(bash(command)))).toMatch(/Stack Traffic Control/)
  }
  expect(calls.length).toBe(0)
})

test('heredoc bodies and quoted text are data, not commands', async ($, on) => {
  host(on)
  const calls = ran(on)
  await $.tool.call(bash("git commit -F - <<'EOF'\nDo not git push --force this branch.\nEOF"))
  await $.tool.call(bash('git commit -m "git push --force; git rebase main"'))
  await $.tool.call(bash("git commit -m 'echo $(git push -f)'"))
  await $.tool.call(bash('cat <<-EOF\n\tgit rebase main\n\tEOF\ngit status'))
  expect(calls.length).toBe(4)
  expect(await denied($.tool.call(bash('cat <<EOF\nnotes\nEOF\ngit push -f')))).toMatch(/gh stack push/)
})

test('an unreadable line that could push is refused in a stack repo', async ($, on) => {
  host(on)
  ran(on)
  // A variable holding git is invisible to any text check; documented in the README.
  expect(await denied($.tool.call(bash('$GIT push --force')))).toBe('')
  expect(await denied($.tool.call(bash('"$(which git)" push --force')))).toMatch(/can't be read/)
  expect(await denied($.tool.call(bash("git commit -m 'unbalanced && git push -f")))).toMatch(/can't be read/)
})

test('rebases onto the stack are redirected; local ones get a note', async ($, on) => {
  host(on)
  const calls = ran(on)
  for (const command of [
    'git rebase main', 'git rebase origin/b1', 'git rebase --onto=main HEAD~3', 'git rebase --onto main HEAD~2',
    'git rebase -C 10 main', 'git rebase --strategy-option theirs main', 'git rebase @{u}', 'git rebase', 'git rebase -i',
    'git rebase b1@{u}',
  ]) {
    expect(await denied($.tool.call(bash(command)))).toMatch(/gh stack rebase/)
  }
  const local = await $.tool.call(bash('git rebase -i HEAD~3'))
  expect(String(local.context?.[0])).toMatch(/--upstack/)
  await $.tool.call(bash('git rebase -S HEAD~3'))
  await $.tool.call(bash('git rebase feature@{u}'))
  const skip = await $.tool.call(bash('git rebase --skip'))
  expect(String(skip.context?.[0])).toMatch(/no --skip/)
  expect(calls).toEqual(['git rebase -i HEAD~3', 'git rebase -S HEAD~3', 'git rebase feature@{u}', 'git rebase --skip'])
})

test('git pull: rebase and merge policies are redirected, fast-forward only passes', async ($, on) => {
  host(on)
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git pull --rebase')))).toMatch(/gh stack sync/)
  expect(await denied($.tool.call(bash('git pull --no-rebase --rebase')))).toMatch(/gh stack sync/)
  expect(await denied($.tool.call(bash('git pull --ff-only --no-ff')))).toMatch(/merge commit/)
  expect(await denied($.tool.call(bash('git pull --no-ff')))).toMatch(/merge commit/)
  await $.tool.call(bash('git pull --ff-only'))
  await $.tool.call(bash('git pull --ff-only --rebase'))
  await $.tool.call(bash('git pull'))
  expect(calls).toEqual(['git pull --ff-only', 'git pull --ff-only --rebase', 'git pull'])
})

test('git pull follows pull.rebase and pull.ff config', async ($, on) => {
  host(on, { config: { 'pull.rebase': 'true' } })
  ran(on)
  expect(await denied($.tool.call(bash('git pull')))).toMatch(/rebase pull/)
})

test('pull.ff=only makes a plain pull safe', async ($, on) => {
  host(on, { config: { 'pull.ff': 'only', 'pull.rebase': 'true' } })
  const calls = ran(on)
  await $.tool.call(bash('git pull'))
  expect(calls.length).toBe(1)
})

test('PR bases and raw PR creation go through gh stack submit; other repos and PRs pass', async ($, on) => {
  host(on, { repo: 'me/repo', prHeads: { '12': 'b1', '99': 'unrelated', '13': 'c1' } })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('gh pr edit 12 --base main')))).toMatch(/gh stack submit/)
  expect(await denied($.tool.call(bash('gh pr edit 13 --base main')))).toMatch(/gh stack submit/)
  expect(await denied($.tool.call(bash('gh pr edit 12 -Bmain')))).toMatch(/gh stack submit/)
  expect(await denied($.tool.call(bash('gh --repo me/repo pr edit 12 --base main')))).toMatch(/gh stack submit/)
  expect(await denied($.tool.call(bash('gh pr edit 12 --repo https://github.com/me/repo.git/ --base main')))).toMatch(/gh stack submit/)
  expect(await denied($.tool.call(bash('gh pr create --title x')))).toMatch(/gh stack submit/)
  await $.tool.call(bash('gh pr edit 99 --base main'))
  await $.tool.call(bash('gh pr edit 12 --repo notme/repo --base main'))
  await $.tool.call(bash('gh pr edit 12 --title better'))
  await $.tool.call(bash('gh pr create --head scratch'))
  expect(calls.length).toBe(4)
})

test('a branch switch followed by a push is split, a file restore is not', async ($, on) => {
  host(on, { branch: 'scratch' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git switch b2 && git push --force')))).toMatch(/separate commands/)
  await $.tool.call(bash('git checkout -- README && git push origin b2'))
  await $.tool.call(bash('git checkout HEAD -- file && git pull --ff-only'))
  expect(calls.length).toBe(2)
})

test('cd is followed, including ~ and across Bash calls', async ($, on) => {
  host(on, { sessionDir: '/plain' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('cd ~/stack && git push --force')))).toMatch(/gh stack push/)
  await $.tool.call(bash('git push --force'))
  expect(calls).toEqual(['git push --force'])
  await $.tool.call(bash('cd /repo'))
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/gh stack push/)
  await $.tool.call(bash('cd /plain'))
  await $.tool.call(bash('git push --force'))
  expect(calls).toEqual(['git push --force', 'cd /repo', 'cd /plain', 'git push --force'])
})

test('an unknowable directory fails closed once a stack repo is in play', async ($, on) => {
  host(on)
  const calls = ran(on)
  await $.tool.call(bash('git push origin b2'))
  expect(await denied($.tool.call(bash('cd - && git push --force')))).toMatch(/not clear which directory/)
  expect(await denied($.tool.call(bash('git fetch && cd /plain; git push --force')))).toMatch(/not clear which directory/)
  expect(await denied($.tool.call(bash('false || cd /plain; git push --force')))).toMatch(/not clear which directory/)
  expect(await denied($.tool.call(bash('if false; then cd /plain; fi; git push -f')))).toMatch(/not clear which directory/)
  await $.tool.call(bash('cd $SOMEWHERE'))
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/not clear which directory/)
  await $.tool.call(bash('cd /plain'))
  await $.tool.call(bash('git push --force'))
  // Within one && list, a push after a cd runs only if the cd did.
  await $.tool.call(bash('git status && cd /plain && git push --force'))
  expect(calls).toEqual(['git push origin b2', 'cd $SOMEWHERE', 'cd /plain', 'git push --force', 'git status && cd /plain && git push --force'])
})

test('a cd in a failed command makes the directory unknown', async ($, on) => {
  host(on)
  ran(on, true)
  await $.tool.call(bash('git push origin b2'))
  await $.tool.call(bash('cd /no/such'))
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/not clear which directory/)
})

test('a failed look fails closed', async ($, on) => {
  host(on, { testExit: 2 })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/couldn't confirm/)
  await $.tool.call(bash('git rebase --continue'))
  await $.tool.call(bash('git pull --ff-only'))
  expect(calls.length).toBe(2)
})

test('an unreadable stack file fails closed', async ($, on) => {
  host(on, { file: 'not json' })
  ran(on)
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/not readable JSON/)
})

test('a repo without a stack file is never looked into further', async ($, on) => {
  const seen: Array<{ argv: string[] }> = []
  host(on, { sessionDir: '/plain' }, seen)
  const calls = ran(on)
  await $.tool.call(bash('git push --force'))
  await $.tool.call(bash('git rebase main'))
  expect(calls.length).toBe(2)
  expect(seen.some(s => s.argv[0] === 'cat' || s.argv.join(' ') === 'gh stack view --json')).toBe(false)
})

test('unrelated commands are not looked at', async ($, on) => {
  const seen: Array<{ argv: string[] }> = []
  host(on, {}, seen)
  ran(on)
  await $.tool.call(bash('git status && ls -la'))
  await $.tool.call(bash('npm test'))
  expect(seen.length).toBe(0)
})

test('the band shows the stack above every other mod\'s band, on each surface', async ($, on) => {
  host(on)
  ran(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
  await $.tool.call(bash('git push origin b2'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'stack-traffic-control',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /stack 2\/2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 needs rebase/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await ui.unmount()
  }
})

test('round 3: rebasing a named stack branch is refused from anywhere', async ($, on) => {
  host(on, { branch: 'scratch' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git rebase main b2')))).toMatch(/rewrites stack branch `b2`/)
  expect(await denied($.tool.call(bash('git rebase --onto main b1 b2')))).toMatch(/b2/)
  expect(await denied($.tool.call(bash('git rebase -i HEAD~3 b2')))).toMatch(/b2/)
  await $.tool.call(bash('git rebase main scratch'))
  expect(await denied($.tool.call(bash('git rebase main scratch && git push -f')))).toMatch(/separate commands/)
  expect(calls).toEqual(['git rebase main scratch'])
})

test('round 3: merge pulls, branch config and -c overrides are judged', async ($, on) => {
  host(on, { config: { 'branch.b2.rebase': 'true', 'pull.rebase': 'false' } })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git pull')))).toMatch(/rebase pull/)
  expect(await denied($.tool.call(bash('git pull --no-rebase')))).toMatch(/merge commit/)
  expect(await denied($.tool.call(bash('git -c pull.rebase=false -c branch.b2.rebase=false pull')))).toMatch(/merge commit/)
  await $.tool.call(bash('git -c pull.ff=only pull'))
  expect(calls).toEqual(['git -c pull.ff=only pull'])
})

test('round 3: a merge pull with no config is refused, yes/1 spellings count', async ($, on) => {
  host(on, { config: { 'pull.rebase': 'yes' } })
  ran(on)
  expect(await denied($.tool.call(bash('git pull')))).toMatch(/rebase pull/)
  expect(await denied($.tool.call(bash('git pull --rebase=false')))).toMatch(/merge commit/)
})

test('round 3: matching and configured push refspecs are judged', async ($, on) => {
  host(on, { config: { 'remote.origin.push': '+b1:b1', 'remote.mirror.mirror': 'true' } })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('git push origin +:')))).toMatch(/matching refspec/)
  expect(await denied($.tool.call(bash('git push --force origin :')))).toMatch(/matching refspec/)
  expect(await denied($.tool.call(bash('git push origin')))).toMatch(/force-pushes stack branch `b1`/)
  expect(await denied($.tool.call(bash('git push mirror')))).toMatch(/mirror push/)
  await $.tool.call(bash('git push origin :'))
  expect(calls).toEqual(['git push origin :'])
})

test('round 3: push.default=upstream pushes the upstream branch', async ($, on) => {
  host(on, { branch: 'scratch', config: { 'push.default': 'upstream', 'branch.scratch.merge': 'refs/heads/b2' } })
  ran(on)
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/b2/)
})

test('round 3: pipes, background, braces and substitution sites place commands right', async ($, on) => {
  host(on, { sessionDir: '/repo' })
  const calls = ran(on)
  expect(await denied($.tool.call(bash('cd /plain | git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('cd /plain & git push --force')))).toMatch(/gh stack push/)
  await $.tool.call(bash('{ cd /plain; }; git push -f'))
  expect(calls).toEqual(['{ cd /plain; }; git push -f'])
  expect(await denied($.tool.call(bash('cd /repo; echo "$(git push -f)"')))).toMatch(/gh stack push/)
})

test('round 3: substitutions in unquoted heredocs and redirect targets run', async ($, on) => {
  host(on)
  const calls = ran(on)
  expect(await denied($.tool.call(bash('cat <<EOF\n$(git push --force origin b1)\nEOF')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('printf x >"$(git push --force origin b1; printf /tmp/log)"')))).toMatch(/gh stack push/)
  await $.tool.call(bash("cat <<'EOF'\n$(git push --force origin b1)\nEOF"))
  expect(calls.length).toBe(1)
})

test('round 3: repository selection follows -C ~, GIT_DIR, --git-dir and cd options', async ($, on) => {
  host(on, { sessionDir: '/plain' })
  const calls = ran(on)
  for (const command of [
    'git -C ~/stack push -f', 'GIT_DIR=/repo/.git git push -f', 'env GIT_DIR=/repo/.git git push --force',
    'git --git-dir=/repo/.git --work-tree=/plain push -f', 'cd -P /repo && git push --force', 'cd -- /repo && git push --force',
    'env -C/repo git push --force', 'sudo -D/repo git push -f',
  ]) {
    expect(await denied($.tool.call(bash(command)))).toMatch(/gh stack push/)
  }
  expect(calls.length).toBe(0)
})

test('round 3: git checkout . and path modes are not branch switches', async ($, on) => {
  host(on)
  const calls = ran(on)
  await $.tool.call(bash('git checkout . && git pull --ff-only'))
  await $.tool.call(bash('git checkout --ours file && git push origin b2'))
  expect(calls.length).toBe(2)
})

test('round 3: a failed line that only mentions cd keeps the directory', async ($, on) => {
  host(on)
  ran(on, true)
  await $.tool.call(bash('git push origin b2'))
  await $.tool.call(bash('git commit -m "cd into the repo"'))
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/gh stack push/)
})

test('round 3: a PR base change fails closed when the PR cannot be looked up', async ($, on) => {
  host(on, { branch: 'scratch' })
  ran(on)
  expect(await denied($.tool.call(bash('gh pr edit 12 --base main')))).toMatch(/Couldn't look up PR/)
})

test('round 3: a malformed stack file fails closed', async ($, on) => {
  host(on, { file: '{"stacks":[{}]}' })
  ran(on)
  expect(await denied($.tool.call(bash('git push --force')))).toMatch(/without a trunk/)
})

test('round 4: subshells, failed cds, functions and piped groups keep the real directory', async ($, on) => {
  host(on)
  const calls = ran(on)
  expect(await denied($.tool.call(bash('(cd /plain); git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('cd /does-not-exist; git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('f() { cd /plain; }; git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('{ cd /plain; } | git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('{ cd /plain; } & git push --force')))).toMatch(/gh stack push/)
  expect(await denied($.tool.call(bash('f() { cd /plain; }; f; git push --force')))).toMatch(/not clear which directory/)
  expect(calls.length).toBe(0)
})

test('round 4: -c push refspecs, checkout -m, --work-tree alone and HEAD@{u}', async ($, on) => {
  host(on, { branch: 'scratch' })
  ran(on)
  expect(await denied($.tool.call(bash("git -c remote.origin.push='+refs/heads/b1:refs/heads/b1' push")))).toMatch(/b1/)
  expect(await denied($.tool.call(bash('git checkout -m b2 && git push --force')))).toMatch(/separate commands/)
  expect(await denied($.tool.call(bash('git --work-tree=/tmp push --force origin b1')))).toMatch(/gh stack push/)
})

test('round 4: HEAD@{u} on a stacked branch is a stack rebase', async ($, on) => {
  host(on)
  ran(on)
  expect(await denied($.tool.call(bash('git rebase HEAD@{u}')))).toMatch(/gh stack rebase/)
  expect(await denied($.tool.call(bash('git rebase --onto=HEAD@{upstream} HEAD~3')))).toMatch(/gh stack rebase/)
})
