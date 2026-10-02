import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BranchDetail, Stack, StackBranch } from '../types'
import type { Context } from './shell'
import { UNKNOWN_DIR, isUnknown, joinDir, parse, resolvePath } from './shell'

const stacks = atom({ plugin: 'stack-traffic-control', key: 'stacks' } as const, {})
const root = atom({ plugin: 'stack-traffic-control', key: 'root' } as const, null)
const board = atom({ plugin: 'stack-traffic-control', key: 'board' } as const, null)
const loading = atom({ plugin: 'stack-traffic-control', key: 'loading' } as const, false)
const pending = atom({ plugin: 'stack-traffic-control', key: 'pending' } as const, false)
const shellDir = atom({ plugin: 'stack-traffic-control', key: 'shellDir' } as const, null)

const PANE = 'stack-board'
// How long a look stays good for the band. The guard always looks fresh.
const TTL_MS = 30_000

type $ = EngineInterface
type Ran = { exitCode: number; stdout: string; stderr: string; threw: boolean }

async function run($: $, argv: string[], cwd?: string, timeoutMs = 8_000): Promise<Ran> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, threw: false }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err).slice(0, 160), threw: true }
  }
}

// The repo root at `cwd`: a path, `null` when it is certainly not a repo, or `undefined` when the check failed.
async function repoRoot($: $, cwd?: string): Promise<string | null | undefined> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd, 3_000)
  if (top.exitCode === 0) return top.stdout.trim()
  if (/not a git repository|cannot change to|No such file or directory|Not a directory/i.test(top.stderr)) return null
  return undefined
}

const lines = (text: string) => text.split('\n').map(l => l.trim()).filter(l => l !== '')

// The truth about one checkout. The stack file is the authority: every branch
// of every stack it lists is protected, whatever `gh stack view` says.
async function lookAt($: $, at: string): Promise<Stack> {
  const now = await $.clock.now()
  const head = await run($, ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], at, 3_000)
  const branch = head.exitCode === 0 ? head.stdout.trim() : ''
  const base: Stack = {
    root: at, status: 'none', reason: '', branch, protectedBranches: [], trunks: [], trunk: '', branches: [],
    remotes: [], config: {}, at: now,
  }
  const unknown = (reason: string): Stack => ({ ...base, status: 'unknown', reason })

  const common = await run($, ['git', 'rev-parse', '--git-common-dir'], at, 3_000)
  if (common.exitCode !== 0) return unknown(`git rev-parse --git-common-dir failed${common.stderr ? `: ${common.stderr.trim()}` : ''}`)
  const file = `${joinDir(at, common.stdout.trim())}/gh-stack`
  const exists = await run($, ['test', '-e', file], at, 3_000)
  // Exit 1 is a firm "nothing there": gh stack has never been used in this repo.
  if (exists.exitCode === 1) return base
  if (exists.exitCode !== 0) return unknown(`could not check for the stack file (${exists.threw ? exists.stderr : `exit ${exists.exitCode}`})`)

  const raw = await run($, ['cat', file], at, 3_000)
  if (raw.exitCode !== 0) return unknown('could not read the stack file')
  const catalog = readCatalog(raw.stdout)
  if (typeof catalog === 'string') return unknown(catalog)

  const protectedBranches = [...new Set(catalog.flatMap(st => st.branches))]
  const trunks = [...new Set(catalog.map(st => st.trunk).filter(t => t !== ''))]
  const mine = catalog.find(st => branch !== '' && st.branches.includes(branch))

  const [remotes, settings] = await Promise.all([
    run($, ['git', 'remote'], at, 3_000),
    run($, ['git', 'config', '--get-regexp', CONFIG_KEYS], at, 3_000),
  ])
  const config: Record<string, string[]> = {}
  if (settings.exitCode === 0) {
    for (const line of settings.stdout.split('\n')) {
      const space = line.indexOf(' ')
      if (line.trim() === '') continue
      const key = (space === -1 ? line : line.slice(0, space)).toLowerCase()
      const val = space === -1 ? '' : line.slice(space + 1)
      ;(config[key] ??= []).push(val)
    }
  }

  let branches: StackBranch[] = []
  if (mine !== undefined) {
    // `gh stack view` adds merged / queued / needs-rebase for the current stack; the file alone does not.
    const view = await run($, ['gh', 'stack', 'view', '--json'], at)
    const flags = new Map<string, Record<string, unknown>>()
    if (view.exitCode === 0) {
      try {
        const parsed = JSON.parse(view.stdout) as { branches?: unknown }
        if (Array.isArray(parsed.branches)) {
          for (const b of parsed.branches as Array<Record<string, unknown>>) flags.set(String(b.name ?? ''), b)
        }
      } catch {
        // The file already told us what to protect; the flags are only for the board.
      }
    }
    const layers = mine.branches.map(name => ({
      name,
      isMerged: flags.get(name)?.isMerged === true,
      isQueued: flags.get(name)?.isQueued === true,
      flagged: flags.get(name)?.needsRebase === true,
    }))
    branches = await Promise.all(
      layers.map(async (b, i) => {
        if (b.isMerged) return { name: b.name, isMerged: true, isQueued: b.isQueued, needsRebase: false }
        // The active parent skips merged and queued layers below, down to the trunk.
        let k = i - 1
        while (k >= 0 && (layers[k]?.isMerged || layers[k]?.isQueued)) k -= 1
        const parent = k >= 0 ? (layers[k]?.name as string) : mine.trunk
        const check = await run($, ['git', 'merge-base', '--is-ancestor', parent, b.name], at, 3_000)
        // Exit 1 is a firm no; anything else (a missing ref, a timeout) leaves gh's flag to decide.
        return { name: b.name, isMerged: false, isQueued: b.isQueued, needsRebase: b.flagged || check.exitCode === 1 }
      }),
    )
  }

  return {
    ...base,
    status: 'stacked',
    protectedBranches,
    trunks,
    trunk: mine?.trunk ?? '',
    branches,
    remotes: remotes.exitCode === 0 ? lines(remotes.stdout) : [],
    config,
  }
}

const CONFIG_KEYS = '^(remote\\..*\\.(push|mirror)|remote\\.pushdefault|push\\.default|pull\\.(rebase|ff)|branch\\..*\\.(merge|rebase|remote|pushremote))$'

// The stack file's catalog, checked against the shape gh stack writes; a string says why it was refused.
function readCatalog(text: string): Array<{ trunk: string; branches: string[] }> | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'the stack file is not readable JSON'
  }
  const stacksOf = (parsed as { stacks?: unknown } | null)?.stacks
  if (!Array.isArray(stacksOf)) return 'the stack file has no stacks list'
  const out: Array<{ trunk: string; branches: string[] }> = []
  for (const st of stacksOf) {
    const trunk = (st as { trunk?: { branch?: unknown } } | null)?.trunk?.branch
    const list = (st as { branches?: unknown } | null)?.branches
    if (typeof trunk !== 'string' || trunk === '' || !Array.isArray(list)) return 'the stack file has a stack without a trunk or branches'
    const names: string[] = []
    for (const b of list) {
      const name = (b as { branch?: unknown } | null)?.branch
      if (typeof name !== 'string' || name === '') return 'the stack file has a branch without a name'
      names.push(name)
    }
    out.push({ trunk, branches: names })
  }
  return out
}

// The last value of a git config key: a `-c` on the command wins over the repo's config.
function setting(s: Stack, overrides: Record<string, string>, key: string): string | undefined {
  const k = key.toLowerCase()
  if (k in overrides) return overrides[k]
  const all = s.config[k]
  return all === undefined ? undefined : all[all.length - 1]
}

// The checkout at `cwd`; `null` when it is not a git repo.
async function stackAt($: $, cwd: string | undefined, fresh: boolean): Promise<Stack | null> {
  const at = await repoRoot($, cwd)
  if (at === null) return null
  if (at === undefined) {
    return {
      root: cwd ?? '', status: 'unknown', reason: 'git could not say whether this is a repo', branch: '', protectedBranches: [],
      trunks: [], trunk: '', branches: [], remotes: [], config: {}, at: await $.clock.now(),
    }
  }
  if (!fresh) {
    const cached = (await read($, stacks))[at]
    if (cached !== undefined && (await $.clock.now()) - cached.at < TTL_MS) return cached
  }
  const look = await lookAt($, at)
  await update($, stacks, all => ({ ...all, [at]: look }))
  // A look at the session's own checkout is what the band draws.
  if (cwd === undefined) await update($, root, () => at)
  return look
}

const onStack = (s: Stack) => s.branch !== '' && s.branches.some(b => b.name === s.branch)

// ---- The board ------------------------------------------------------------

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const NEUTRAL = ['SKIPPED', 'NEUTRAL']

function checksOf(rollup: unknown): BranchDetail['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  const states = rollup.map(c => {
    const one = c as { conclusion?: unknown; state?: unknown; status?: unknown }
    const done = String(one.status ?? '').toUpperCase()
    // A check run still going has no conclusion yet.
    if (done !== '' && done !== 'COMPLETED') return 'PENDING'
    return String(one.conclusion || one.state || '').toUpperCase()
  })
  if (states.some(s => FAILED.includes(s))) return 'fail'
  if (states.some(s => s !== 'SUCCESS' && !NEUTRAL.includes(s))) return 'pending'
  return states.includes('SUCCESS') ? 'pass' : 'none'
}

async function detailOf($: $, at: string, name: string, isCurrent: boolean): Promise<BranchDetail> {
  const [pr, ahead, status] = await Promise.all([
    run($, ['gh', 'pr', 'view', name, '--json', 'number,state,statusCheckRollup'], at, 10_000),
    run($, ['git', 'rev-list', '--count', `${name}@{upstream}..${name}`], at, 3_000),
    isCurrent ? run($, ['git', 'status', '--porcelain'], at, 3_000) : Promise.resolve(null),
  ])
  let info: { number?: unknown; state?: unknown; statusCheckRollup?: unknown } = {}
  if (pr.exitCode === 0) {
    try {
      info = JSON.parse(pr.stdout)
    } catch {
      info = {}
    }
  }
  let unpushed: number | null = null
  let published: boolean | null = null
  if (ahead.exitCode === 0) {
    unpushed = Number(ahead.stdout.trim())
    published = true
  } else {
    const upstream = await run($, ['git', 'rev-parse', '--verify', '--quiet', `${name}@{upstream}`], at, 3_000)
    if (upstream.exitCode === 1) published = false
  }
  const hasPr = typeof info.number === 'number'
  return {
    pr: hasPr ? (info.number as number) : null,
    state: typeof info.state === 'string' ? info.state : null,
    checks: hasPr ? checksOf(info.statusCheckRollup) : null,
    unpushed,
    published,
    dirty: status !== null && status.exitCode === 0 && status.stdout.trim() !== '',
  }
}

async function refresh($: $) {
  if (await read($, loading)) {
    await update($, pending, () => true)
    return
  }
  await update($, loading, () => true)
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      await update($, pending, () => false)
      const saved = await read($, shellDir)
      const where = saved === null || isUnknown(saved) ? undefined : saved
      const stack = await stackAt($, where, true)
      await update($, root, () => stack?.root ?? null)
      if (stack === null || stack.status !== 'stacked' || !onStack(stack)) {
        await update($, board, () => null)
      } else {
        const rows = await Promise.all(
          stack.branches.map(async b => [b.name, await detailOf($, stack.root, b.name, b.name === stack.branch)] as const),
        )
        await update($, board, () => ({ root: stack.root, rows: Object.fromEntries(rows), at: stack.at }))
      }
      if (!(await read($, pending))) break
    }
  } finally {
    await update($, loading, () => false)
  }
}

// ---- The guard ------------------------------------------------------------

type Where = { dir?: string }
type GitOp =
  | ({ kind: 'push'; args: string[]; cfg: Record<string, string> } & Where)
  | ({ kind: 'rebase'; args: string[]; cfg: Record<string, string> } & Where)
  | ({ kind: 'pull'; args: string[]; cfg: Record<string, string> } & Where)
type PrOp =
  | ({ kind: 'pr-edit'; args: string[]; repo?: string } & Where)
  | ({ kind: 'pr-create'; args: string[]; repo?: string } & Where)
type Op = GitOp | PrOp | ({ kind: 'checkout' } & Where)

const GIT_GLOBAL_VALUED = new Set(['--namespace', '--config-env', '--super-prefix', '--list-cmds'])
const STACK_MUTATORS = new Set(['checkout', 'up', 'down', 'top', 'bottom', 'switch', 'trunk', 'init', 'add', 'modify', 'unstack', 'sync', 'rebase', 'merge'])
// `git checkout` modes that restore files and leave HEAD alone.
const PATH_CHECKOUT = new Set(['--', '-p', '--patch', '--ours', '--theirs', '--pathspec-from-file'])

// Does `git checkout <args>` move HEAD (as opposed to restoring files)?
function checkoutMoves(args: string[]): boolean {
  if (args.some(a => PATH_CHECKOUT.has(a) || a.startsWith('--pathspec-from-file='))) return false
  if (args.some(a => ['-b', '-B', '--orphan', '--detach', '-'].includes(a))) return true
  const plain = args.filter((a, k) => !a.startsWith('-') && args[k - 1] !== '--conflict')
  return plain.length === 1 && plain[0] !== '.' && plain[0] !== '..'
}

// The repo a git command acts on: GIT_DIR / --git-dir name it outright; else -C, GIT_WORK_TREE / --work-tree, the cwd.
function gitRepoDir(cwd: string | undefined, gitDir: string | undefined, workTree: string | undefined, ctx: Context): string | undefined {
  if (gitDir !== undefined) {
    const at = resolvePath(cwd, gitDir, ctx)
    if (isUnknown(at)) return UNKNOWN_DIR
    // `<repo>/.git` → `<repo>`; a bare repo is its own directory.
    return at.replace(/\/\.git\/?$/, '') || '/'
  }
  // A work tree alone does not choose the repository: git still finds it from the cwd.
  void workTree
  return cwd
}

// What one simple command would do, before we know anything about the stack.
function opOf(argv: string[], startDir: string | undefined, env: Record<string, string>, ctx: Context): Op | null {
  const tool = argv[0]?.split('/').pop()
  const rest = argv.slice(1)
  if (tool === 'git') {
    let cwd = startDir
    let gitDir = env.GIT_DIR
    let workTree = env.GIT_WORK_TREE
    const cfg: Record<string, string> = {}
    const config = (pair: string) => {
      const eq = pair.indexOf('=')
      const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase()
      const val = eq === -1 ? 'true' : pair.slice(eq + 1)
      // remote.<name>.push is multi-valued and adds to the file's values; the rest are last-wins.
      cfg[key] = /^remote\..*\.push$/.test(key) && cfg[key] !== undefined ? `${cfg[key]}\n${val}` : val
    }
    let j = 0
    while (j < rest.length && (rest[j] as string).startsWith('-')) {
      const opt = rest[j] as string
      const value = rest[j + 1]
      if (opt === '-C') {
        cwd = resolvePath(cwd, value ?? '.', ctx)
        j += 2
      } else if (opt.startsWith('-C') && opt.length > 2) {
        cwd = resolvePath(cwd, opt.slice(2), ctx)
        j += 1
      } else if (opt === '-c') {
        config(value ?? '')
        j += 2
      } else if (opt.startsWith('-c') && opt.length > 2) {
        config(opt.slice(2))
        j += 1
      } else if (opt === '--git-dir' || opt === '--work-tree') {
        if (opt === '--git-dir') gitDir = value ?? '.'
        else workTree = value ?? '.'
        j += 2
      } else if (opt.startsWith('--git-dir=')) {
        gitDir = opt.slice(10)
        j += 1
      } else if (opt.startsWith('--work-tree=')) {
        workTree = opt.slice(12)
        j += 1
      } else if (GIT_GLOBAL_VALUED.has(opt)) j += 2
      else j += 1
    }
    const dir = gitRepoDir(cwd, gitDir, workTree, ctx)
    const sub = rest[j]
    const args = rest.slice(j + 1)
    if (sub === 'push' || sub === 'rebase' || sub === 'pull') return { kind: sub, args, cfg, dir }
    if (sub === 'switch' || (sub === 'checkout' && checkoutMoves(args))) return { kind: 'checkout', dir }
    return null
  }
  if (tool === 'gh') {
    let repo: string | undefined
    const words: string[] = []
    for (let k = 0; k < rest.length; k += 1) {
      const w = rest[k] as string
      if (w === '-R' || w === '--repo') {
        repo = rest[k + 1]
        k += 1
      } else if (w.startsWith('--repo=')) repo = w.slice(7)
      else if (w.startsWith('-R') && w.length > 2) repo = w.slice(2)
      else words.push(w)
    }
    const [noun, verb, ...args] = words
    if (noun === 'pr' && verb === 'edit') return { kind: 'pr-edit', args, repo, dir: startDir }
    if (noun === 'pr' && verb === 'create') return { kind: 'pr-create', args, repo, dir: startDir }
    if (noun === 'pr' && verb === 'checkout') return { kind: 'checkout', dir: startDir }
    if (noun === 'stack' && verb !== undefined && STACK_MUTATORS.has(verb)) return { kind: 'checkout', dir: startDir }
  }
  return null
}

const layerNames = (s: Stack) => s.branches.map(b => b.name)
const stackPath = (s: Stack) => (s.trunk === '' ? '' : ` (stack: ${[s.trunk, ...layerNames(s)].join(' → ')})`)
const isProtected = (s: Stack, name: string) => s.protectedBranches.includes(name) || s.trunks.includes(name)

function isStackRef(s: Stack, ref: string | undefined): boolean {
  if (ref === undefined) return false
  // `@{u}` alone is the current branch's upstream: on a stacked branch, a layer or the trunk.
  if (/^(HEAD)?@\{(u|upstream|push)\}$/i.test(ref)) return true
  const upstreamOf = ref.match(/^(.+)@\{(u|upstream|push)\}$/i)
  if (upstreamOf !== null) return isProtected(s, upstreamOf[1] as string)
  return [...s.protectedBranches, ...s.trunks].some(n =>
    ref === n || ref === `refs/heads/${n}` ||
    s.remotes.some(r => ref === `${r}/${n}` || ref === `refs/remotes/${r}/${n}`))
}

const PUSH_VALUED = new Set(['-o', '--push-option', '--receive-pack', '--exec'])
// Rebase options that take the next word as their value (-S/--gpg-sign only take an attached one).
const REBASE_VALUED = new Set(['-x', '--exec', '-s', '--strategy', '-X', '--strategy-option', '-C', '--onto', '--empty', '--whitespace'])

type Judgement = { deny: string } | { note: string } | null

function remoteHint(s: Stack): string {
  return s.remotes.length > 1 && setting(s, {}, 'remote.pushDefault') === undefined
    ? ` This repo has several remotes (${s.remotes.join(', ')}) and no remote.pushDefault: add \`--remote <name>\` to the gh stack command.`
    : ''
}

function header(s: Stack, command: string): string {
  const shown = command.length > 160 ? `${command.slice(0, 159)}…` : command
  const where = s.branch === '' ? 'with HEAD detached in a repo that uses gh stack' : onStack(s) ? `on stacked branch \`${s.branch}\`` : 'in a repo that uses gh stack'
  return `Stack Traffic Control: \`${shown}\` runs ${where}${stackPath(s)}.`
}

const hasGlob = (ref: string) => /[*?[]/.test(ref)
const isTrue = (v: string | undefined) => v !== undefined && ['true', 'yes', 'on', '1'].includes(v.toLowerCase())

function judgePush(s: Stack, args: string[], cfg: Record<string, string>, command: string): Judgement {
  let forceAll = false
  let mirror = false
  let all = false
  let deleting = false
  let repoFlag: string | undefined
  const positional: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k] as string
    if (a === '--') {
      positional.push(...args.slice(k + 1))
      break
    }
    if (a === '--repo') {
      repoFlag = args[k + 1] ?? ''
      k += 1
      continue
    }
    if (a.startsWith('--repo=')) {
      repoFlag = a.slice(7)
      continue
    }
    if (PUSH_VALUED.has(a)) {
      k += 1
      continue
    }
    if (a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') forceAll = true
    else if (a === '--mirror') mirror = true
    else if (a === '--all' || a === '--branches') all = true
    else if (a === '--delete' || a === '-d') deleting = true
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('f')) forceAll = true
      if (a.includes('d')) deleting = true
    } else if (!a.startsWith('-')) positional.push(a)
  }
  const deny = (what: string) => ({
    deny: `${header(s, command)} ${what} Raw force-pushes and deletes move one layer without the others and can clobber a parent or child PR. ` +
      'Use `gh stack push` (per-branch --force-with-lease; skips merged and queued branches), `gh stack submit --auto` ' +
      'to also create PRs and fix their bases, or `gh stack sync --prune` to clean up merged branches.' +
      `${remoteHint(s)} Ask the user if a raw push is really needed.`,
  })
  const remote = repoFlag ?? positional[0] ??
    setting(s, cfg, `branch.${s.branch}.pushRemote`) ?? setting(s, cfg, 'remote.pushDefault') ??
    setting(s, cfg, `branch.${s.branch}.remote`) ?? 'origin'
  if (mirror || isTrue(setting(s, cfg, `remote.${remote}.mirror`))) return deny('A mirror push force-updates every branch, the stack included.')
  if (all && forceAll) return deny('A forced `--all` push rewrites every branch, the stack included.')
  let refspecs = positional.slice(repoFlag !== undefined ? 0 : 1)
  if (refspecs.length === 0) {
    // No refspec: the remote's configured push refspecs, else push.default decides what moves.
    const key = `remote.${remote.toLowerCase()}.push`
    const configured = [...(s.config[key] ?? []), ...(cfg[key]?.split('\n') ?? [])].filter(r => r !== '')
    if (configured.length > 0) refspecs = configured
    else {
      if (!forceAll) return null
      const mode = (setting(s, cfg, 'push.default') ?? 'simple').toLowerCase()
      if (mode === 'matching') return deny('With push.default=matching, a forced push with no refspec rewrites every matching branch, the stack included.')
      if (mode === 'nothing') return null
      if (s.branch === '') return deny('HEAD is detached, so it is not clear which branch a forced push updates.')
      const merge = setting(s, cfg, `branch.${s.branch}.merge`)?.replace(/^refs\/heads\//, '')
      const target = (mode === 'upstream' || mode === 'tracking') && merge !== undefined ? merge : s.branch
      return isProtected(s, target) ? deny(`It force-pushes \`${target}\`.`) : null
    }
  }
  for (const spec of refspecs) {
    const plus = spec.startsWith('+')
    const body = plus ? spec.slice(1) : spec
    const forced = forceAll || plus
    // `:` and `+:` push every branch that exists on both sides.
    if (body === ':') {
      if (forced) return deny(`The matching refspec \`${spec}\` force-updates every branch the remote shares, the stack included.`)
      continue
    }
    const colon = body.indexOf(':')
    const src = colon === -1 ? body : body.slice(0, colon)
    const dstRaw = colon === -1 ? body : body.slice(colon + 1)
    let dst = dstRaw.replace(/^refs\/heads\//, '')
    if (dst === 'HEAD' || dst === '@') dst = s.branch
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) continue
    if (hasGlob(src) || hasGlob(dst)) {
      if (forced || deleting) return deny(`The pattern \`${spec}\` can match stack branches.`)
      continue
    }
    if (dst === '') {
      if (forced) return deny('HEAD is detached, so it is not clear which branch a forced push updates.')
      continue
    }
    if ((src === '' || deleting) && isProtected(s, dst)) return deny(`It deletes stack branch \`${dst}\` on the remote.`)
    if (forced && isProtected(s, dst)) return deny(`It force-pushes stack branch \`${dst}\`.`)
  }
  return null
}

// The arguments of a rebase: where onto, the upstream, and the branch it checks out and rewrites.
function rebaseArgs(args: string[]): { onto?: string; upstream?: string; branch?: string; root: boolean } {
  let onto: string | undefined
  const positional: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k] as string
    if (a === '--onto') {
      onto = args[k + 1]
      k += 1
    } else if (a.startsWith('--onto=')) onto = a.slice(7)
    else if (REBASE_VALUED.has(a)) k += 1
    else if (a.startsWith('-')) continue
    else positional.push(a)
  }
  const root = args.includes('--root')
  return root ? { onto, branch: positional[0], root } : { onto, upstream: positional[0], branch: positional[1], root }
}

const REBASE_CONTROL = ['--continue', '--abort', '--quit', '--edit-todo', '--show-current-patch', '--skip']

function judgeRebase(s: Stack, args: string[], command: string): Judgement {
  if (args.some(a => REBASE_CONTROL.includes(a) && a !== '--skip')) {
    return { note: 'If this rebase was started by `gh stack rebase`, finish it with `gh stack rebase --continue` / `--abort` instead so the cascade carries on.' }
  }
  if (args.includes('--skip')) {
    return { note: '`gh stack rebase` has no --skip: skipping during a stack rebase drops a commit and stops the cascade. If gh stack started this rebase, resolve and use `gh stack rebase --continue`.' }
  }
  const { onto, upstream, branch, root } = rebaseArgs(args)
  const rewritten = branch ?? s.branch
  const deny = (what: string) => ({
    deny: `${header(s, command)} ${what} ` +
      'Use `gh stack rebase` (cascades the whole stack), `gh stack rebase --downstack` (trunk up to this branch), ' +
      '`gh stack rebase --upstack` (this branch to the top) or `gh stack rebase --no-trunk` (layers only). ' +
      `On conflicts, resolve and run \`gh stack rebase --continue\` (or \`--abort\`).${remoteHint(s)}`,
  })
  if (branch !== undefined) {
    // `git rebase <upstream> <branch>` checks out and rewrites <branch>, whatever HEAD is.
    if (!s.protectedBranches.includes(branch) && !s.trunks.includes(branch)) return null
    return deny(`It checks out and rewrites stack branch \`${branch}\`, leaving the branches above it on the old commits.`)
  }
  if (!onStack(s)) return null
  // No upstream named means the branch's upstream, which on a stacked branch is a layer or the trunk.
  if (isStackRef(s, onto) || isStackRef(s, upstream) || (upstream === undefined && !root)) {
    return deny(`Rebasing stacked branch \`${rewritten}\` by hand leaves the branches above it on the old commits.`)
  }
  return { note: `\`${rewritten}\` is stacked: after rewriting it, run \`gh stack rebase --upstack\` so the branches above follow, then \`gh stack push\`.` }
}

// The last fast-forward flag given, if any.
function lastFf(args: string[]): 'only' | 'ff' | 'no-ff' | null {
  let ff: 'only' | 'ff' | 'no-ff' | null = null
  for (const a of args) {
    if (a === '--ff-only') ff = 'only'
    else if (a === '--ff') ff = 'ff'
    else if (a === '--no-ff') ff = 'no-ff'
  }
  return ff
}

function rebaseValue(v: string | undefined): boolean | null {
  if (v === undefined) return null
  const low = v.toLowerCase()
  if (['true', 'yes', 'on', '1', 'merges', 'm', 'interactive', 'i', 'preserve', 'p'].includes(low)) return true
  if (['false', 'no', 'off', '0'].includes(low)) return false
  return null
}

function judgePull(s: Stack, args: string[], cfg: Record<string, string>, command: string): Judgement {
  if (!onStack(s)) return null
  // Flags win over -c, -c over branch config, branch config over pull.* config; for flags the last one wins.
  let rebase: boolean | null = null
  for (const a of args) {
    if (a === '--rebase' || a === '-r') rebase = true
    else if (a.startsWith('--rebase=')) rebase = rebaseValue(a.slice(9)) ?? true
    else if (a === '--no-rebase') rebase = false
  }
  if (rebase === null) rebase = rebaseValue(setting(s, cfg, `branch.${s.branch}.rebase`))
  if (rebase === null) rebase = rebaseValue(setting(s, cfg, 'pull.rebase'))
  let ff = lastFf(args)
  if (ff === null) {
    const conf = setting(s, cfg, 'pull.ff')?.toLowerCase()
    ff = conf === 'only' ? 'only' : conf === undefined ? null : rebaseValue(conf) === false ? 'no-ff' : 'ff'
  }
  // Fast-forward only never rewrites or merges (it wins over --rebase too). With no policy at all,
  // git refuses a divergent pull and only fast-forwards.
  if (ff === 'only') return null
  if (rebase === null && ff === null) return null
  const what = rebase === true ? 'a rebase pull strands the layers above this one' : 'a merge pull puts a merge commit into a stack that must stay linear'
  return {
    deny: `${header(s, command)} \`git pull\` updates this layer alone: ${what}. Use \`gh stack sync\` (fetch, cascade-rebase, ` +
      `push with lease, sync PR state), or \`gh stack rebase\`. \`git pull --ff-only\` is still allowed.${remoteHint(s)}`,
  }
}

// `owner/name` from OWNER/REPO, HOST/OWNER/REPO, git@host:owner/name.git or https://host/owner/name(.git)(/).
function slugOf(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = trimmed.split(/[/:]/).filter(p => p !== '')
  return parts.slice(-2).join('/').toLowerCase()
}

async function repoSlug($: $, at: string): Promise<string | null> {
  const view = await run($, ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], at, 8_000)
  return view.exitCode === 0 ? view.stdout.trim() : null
}

function flag(args: string[], short: string, long: string): string | null {
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k] as string
    if (a === short || a === long) return args[k + 1] ?? ''
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1)
    if (a.startsWith(short) && a.length > short.length && !a.startsWith('--')) return a.slice(short.length)
  }
  return null
}

const PR_EDIT_VALUED = new Set(['-B', '--base', '-t', '--title', '-b', '--body', '-F', '--body-file', '-m', '--milestone', '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project'])

async function judgePr($: $, s: Stack, op: PrOp, command: string): Promise<Judgement> {
  if (op.kind === 'pr-edit' && flag(op.args, '-B', '--base') === null) return null
  if (op.repo !== undefined) {
    const slug = await repoSlug($, s.root)
    // Another repository's PR has nothing to do with this stack.
    if (slug !== null && slugOf(op.repo) !== slugOf(slug)) return null
  }
  const stackBranch = (name: string) => s.protectedBranches.includes(name.replace(/^[^:]+:/, ''))
  if (op.kind === 'pr-edit') {
    const target = op.args.find((a, k) => !a.startsWith('-') && !PR_EDIT_VALUED.has(op.args[k - 1] ?? ''))
    const deny = (what: string) => ({
      deny: `${header(s, command)} ${what} Use \`gh stack submit --auto\` (updates every base) or \`gh stack modify\` ` +
        `to restructure the stack.${remoteHint(s)}`,
    })
    if (target === undefined) return onStack(s) ? deny('PR bases in a stack are managed by gh stack; editing one by hand breaks the chain.') : null
    const argv = ['gh', 'pr', 'view', target, '--json', 'headRefName', '-q', '.headRefName']
    if (op.repo !== undefined) argv.push('--repo', op.repo)
    const head = await run($, argv, s.root, 8_000)
    if (head.exitCode === 0) {
      return stackBranch(head.stdout.trim()) ? deny('PR bases in a stack are managed by gh stack; editing one by hand breaks the chain.') : null
    }
    // A base change on a PR we cannot look up, in a stack repo: it may be a layer.
    return deny(`Couldn't look up PR \`${target}\` to check whether it is a stack layer, so its base was not changed.`)
  }
  const head = flag(op.args, '-H', '--head')
  const forStack = head !== null && head !== '' ? stackBranch(head) : onStack(s)
  if (!forStack) return null
  return {
    deny: `${header(s, command)} \`gh pr create\` would open a PR outside the stack, against the wrong base. ` +
      'Use `gh stack submit --auto` (creates PRs for every branch without one, bases set, linked as a stack); ' +
      `add \`--open\` to mark them ready for review.${remoteHint(s)}`,
  }
}

const PROTECTED_TEXT = /\b(push|rebase|pull)\b|\bpr\b[\s\S]*\b(edit|create)\b/

const short = (command: string) => (command.length > 120 ? `${command.slice(0, 119)}…` : command)

async function shellContext($: $): Promise<Context> {
  return { home: await $.env.get('HOME') }
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stack',
      description: 'Stack Traffic Control: show the current gh stack as a departure board',
      immediate: true,
    })
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'stack' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Stack' })
    void refresh($)
    return { text: opened.isPlaced ? 'Stack board opened.' : 'Stack board opens once the terminal is wide enough.' }
  })

  // Checkouts change between turns: keep the band honest.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const saved = await read($, shellDir)
    const base = saved ?? undefined
    const c = await shellContext($)

    const parsed = parse(command, base, c)

    // Track where the persistent shell is, for every Bash call, not only git ones.
    const settle = async (ran: Awaited<ReturnType<typeof next>>) => {
      if (ran.deny !== undefined || !parsed.changesDir) return ran
      // A failed line may have stopped before or after its cd.
      let after = ran.isError === true ? UNKNOWN_DIR : parsed.endDir
      // `cd x; …` succeeding overall says nothing about the cd: x must exist.
      if (after !== UNKNOWN_DIR && parsed.uncertainCd !== undefined && after === parsed.uncertainCd.target) {
        if ((await run($, ['test', '-d', parsed.uncertainCd.target], undefined, 3_000)).exitCode !== 0) after = parsed.uncertainCd.dir
      }
      if (after !== base) await update($, shellDir, () => after ?? null)
      return ran
    }

    if (!/\b(git|gh)\b/.test(command)) return settle(await next(e))
    const notes: string[] = []
    const looked = new Map<string, Stack | null>()
    const look = async (dir: string | undefined) => {
      const key = dir ?? ''
      if (!looked.has(key)) looked.set(key, await stackAt($, dir, true))
      return looked.get(key) ?? null
    }
    // Some repo this session looked at uses gh stack (or could not be checked).
    const anyStackRepo = async () =>
      Object.values(await read($, stacks)).some(s => s.status !== 'none') || [...looked.values()].some(s => s !== null && s.status !== 'none')
    const unreadable = (why: string) => ({
      deny: `Stack Traffic Control: ${why}, and this session works in a repo that uses gh stack, so \`${short(command)}\` ` +
        'was not run. Run the git or gh step as a plain command, from a directory given literally (`cd /abs/path && …` or `git -C /abs/path …`).',
    })

    if (parsed.opaque && PROTECTED_TEXT.test(command)) {
      const s = isUnknown(base) ? null : await look(base)
      if ((s !== null && s.status !== 'none') || (isUnknown(base) && (await anyStackRepo()))) {
        return unreadable("part of the line can't be read (a substitution as the program, a script, an unbalanced quote or a case statement)")
      }
    }

    let switched = false
    for (const cmd of parsed.commands) {
      let at = cmd.dir
      // After `cd x; …`, the command runs in x only if x exists.
      if (cmd.ifCdFailed !== undefined && (await run($, ['test', '-d', cmd.ifCdFailed.target], undefined, 3_000)).exitCode !== 0) {
        at = cmd.ifCdFailed.dir
      }
      const op = opOf(cmd.argv, at, cmd.env, c)
      if (op === null) continue
      if (op.kind === 'checkout') {
        switched = true
        continue
      }
      if (isUnknown(op.dir)) {
        if (await anyStackRepo()) return unreadable(`it's not clear which directory \`${cmd.argv.slice(0, 3).join(' ')}\` runs in (\`cd -\`, \`cd $VAR\`, or a \`cd\` that may not have run)`)
        continue
      }
      const s = await look(op.dir)
      if (s === null || s.status === 'none') continue
      // The checkout this command would see is not the one we can look at now.
      if (switched) {
        return {
          deny: `Stack Traffic Control: \`${short(command)}\` changes branch and then runs \`${cmd.argv.slice(0, 3).join(' ')}\` in one go, ` +
            'in a repo that uses gh stack, so the second step cannot be checked against the branch it will run on. Run them as separate commands.',
        }
      }
      if (s.status === 'unknown') {
        if (op.kind === 'rebase' && op.args.some(a => ['--continue', '--abort', '--skip', '--quit'].includes(a))) continue
        if (op.kind === 'pull' && lastFf(op.args) === 'only') continue
        return {
          deny: `Stack Traffic Control: couldn't confirm whether \`${short(command)}\` touches a gh stack, so it was not run ` +
            `(${s.reason}). Retry in a moment, run \`gh stack view\` to see what's wrong, or ask the user.`,
        }
      }
      let verdict: Judgement
      if (op.kind === 'push') verdict = judgePush(s, op.args, op.cfg, command)
      else if (op.kind === 'rebase') verdict = judgeRebase(s, op.args, command)
      else if (op.kind === 'pull') verdict = judgePull(s, op.args, op.cfg, command)
      else verdict = await judgePr($, s, op, command)
      // `git rebase <upstream> <branch>` leaves HEAD on <branch>: later steps see another checkout.
      if (op.kind === 'rebase' && rebaseArgs(op.args).branch !== undefined) switched = true
      if (verdict === null) continue
      if ('deny' in verdict) return verdict
      notes.push(verdict.note)
    }

    const ran = await settle(await next(e))
    if (notes.length === 0 || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notes.map(n => `Stack Traffic Control: ${n}`)] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const at = await read($, root)
    if (at === null || e.props.hasSurvey) return next(e)
    const stack = (await read($, stacks))[at]
    if (stack === undefined || stack.status !== 'stacked' || !onStack(stack)) return next(e)
    const index = stack.branches.findIndex(b => b.name === stack.branch)
    const behind = stack.branches.filter(b => b.needsRebase).length
    const { Box, Text } = $.ui.resolve(e)
    const mine = (
      <Box>
        <Text>🛫 stack {index + 1}/{stack.branches.length}</Text>
        <Text dimColor> · {stack.branch}</Text>
        {behind > 0
          ? <Text color="yellow"> · {behind} need{behind === 1 ? 's' : ''} rebase</Text>
          : <Text color="green"> · no rebase needed</Text>}
      </Box>
    )
    // The band is one instance shared by every mod: draw ours above whatever the others drew.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = await read($, root)
    const stack = at === null ? undefined : (await read($, stacks))[at]
    const shown = await read($, board)
    const busy = await read($, loading)
    const refreshButton = <Button key="refresh" label={busy ? 'refreshing…' : 'refresh'} onPress={() => refresh($)} />
    if (stack === undefined || stack.status !== 'stacked' || !onStack(stack)) {
      const why =
        stack?.status === 'unknown' ? `Couldn't read the stack: ${stack.reason}`
        : stack?.status === 'stacked' ? `\`${stack.branch || 'HEAD'}\` is not on a stack in this repo.`
        : 'This checkout is not on a gh stack.'
      return (
        <Box flexDirection="column">
          <Text dimColor>{busy && stack === undefined ? 'Looking for a stack…' : why}</Text>
          {stack?.status === 'unknown' ? null : <Text dimColor>Start one with `gh stack init`, or switch with `gh stack checkout`.</Text>}
          {refreshButton}
        </Box>
      )
    }
    // Details from another checkout (or none yet) are not shown against this stack.
    const rows = shown !== null && shown.root === stack.root ? shown.rows : {}
    const width = Math.max(10, Math.min(28, (e.props.bodyColumns ?? 60) - 34))
    const cut = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width))
    return (
      <Box flexDirection="column">
        <Text bold>DEPARTURES · trunk {stack.trunk}</Text>
        {[...stack.branches].reverse().map(b => {
          const d = rows[b.name]
          const isCurrent = b.name === stack.branch
          const status = b.isMerged ? 'landed' : b.isQueued ? 'queued' : b.needsRebase ? 'rebase' : 'ready'
          const color = b.isMerged ? 'gray' : b.needsRebase ? 'yellow' : 'green'
          const pr = d === undefined ? '…' : d.pr !== null ? `#${d.pr}` : '—'
          const ci = d?.checks === 'pass' ? '✓' : d?.checks === 'fail' ? '✗' : d?.checks === 'pending' ? '…' : ' '
          const push = d === undefined ? '' : d.published === false ? ' unpublished' : d.unpushed === null ? ' ?' : d.unpushed > 0 ? ` ↑${d.unpushed}` : ''
          const dirty = d?.dirty ? ' ✎' : ''
          return (
            <Box key={b.name}>
              <Text bold={isCurrent}>{isCurrent ? '▶ ' : '  '}{cut(b.name)} </Text>
              <Text dimColor>{pr.padEnd(6)} </Text>
              <Text color={d?.checks === 'fail' ? 'red' : undefined}>{ci} </Text>
              <Text color={color}>{status}</Text>
              <Text dimColor>{push}{dirty}</Text>
            </Box>
          )
        })}
        <Text dimColor>✓✗… checks · ↑ unpushed · ✎ uncommitted · ? unknown</Text>
        {refreshButton}
      </Box>
    )
  })
}
