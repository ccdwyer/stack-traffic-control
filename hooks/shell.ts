// A small shell reader: enough of POSIX sh to find every simple command a
// Bash line would run, where it would run, and whether something hid one.
// It never expands globs; it only finds commands and their directories.

// A directory we cannot know from the text (`cd -`, `cd $X`, a cd that may not have run).
export const UNKNOWN_DIR = '\u0000unknown'

export type SimpleCommand = {
  // The words, wrappers (env, sudo, nohup, time, nice, command, exec, xargs, timeout) peeled.
  argv: string[]
  // Where it runs: undefined is where the line started; UNKNOWN_DIR is unknowable.
  dir: string | undefined
  // Variables set for it alone (`GIT_DIR=… git …`, `env GIT_DIR=… git …`).
  env: Record<string, string>
  // After `cd x; …` the cd may have failed: `dir` holds if x exists, else this does.
  ifCdFailed?: { target: string; dir: string | undefined }
}

export type Parsed = {
  commands: SimpleCommand[]
  // True when part of the line could not be read: an unbalanced quote or
  // substitution, a program name that is itself an expansion, a case statement.
  opaque: boolean
  // Where the shell itself is once the line has run, if it changed directory.
  endDir: string | undefined
  // The line itself runs a cd/pushd/popd (not inside a subshell or substitution).
  changesDir: boolean
  // A top-level `cd x` followed by `;`/newline: the shell is in `endDir` only if x exists.
  uncertainCd?: { target: string; dir: string | undefined }
}

export type Context = { home?: string }

const WRAPPER_FLAGS_WITH_VALUE: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'],
  nice: ['-n', '--adjustment'],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--replace'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  command: [],
  exec: ['-a'],
  nohup: [],
  time: ['-f', '--format', '-o', '--output'],
}
// Flags of a wrapper that change the directory the program runs in (short form may be glued: -C/dir).
const CHDIR_FLAGS: Record<string, { short: string; long: string }> = {
  env: { short: '-C', long: '--chdir' },
  sudo: { short: '-D', long: '--chdir' },
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
// Reserved words that lead into a command without being one; a cd after one may not run.
const LEADING_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', 'time'])
// Reserved words that end a construct and carry no command.
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

export const isUnknown = (dir: string | undefined) => dir !== undefined && dir.startsWith(UNKNOWN_DIR)

export const joinDir = (base: string | undefined, next: string): string => {
  if (isUnknown(next)) return UNKNOWN_DIR
  if (next.startsWith('/')) return next
  if (base === undefined) return next
  if (isUnknown(base)) return UNKNOWN_DIR
  return `${base.replace(/\/$/, '')}/${next}`
}

// Resolve a path the way a shell would, as far as the text allows: `~` from HOME,
// anything with an expansion or `-` (OLDPWD) is unknowable.
export function resolvePath(base: string | undefined, target: string | undefined, ctx: Context): string {
  if (target === undefined || target === '~') return ctx.home ?? UNKNOWN_DIR
  if (target.startsWith('~/')) return ctx.home === undefined ? UNKNOWN_DIR : `${ctx.home}/${target.slice(2)}`
  if (target === '-' || /[~$`*?]/.test(target)) return UNKNOWN_DIR
  return joinDir(base, target)
}

type Token =
  | { kind: 'word'; text: string; raw: boolean; subs: string[] }
  // Substitutions that run with the command but are not its words (redirect targets, heredoc bodies).
  | { kind: 'subs'; subs: string[] }
  | { kind: 'sep'; text: string }

// Read `$( ... )` starting just past `$(`; returns the inner text and the index after `)`.
function readSubstitution(src: string, start: number): { inner: string; end: number } | null {
  let depth = 1
  let quote: string | null = null
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i] as string
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { inner: src.slice(start, i), end: i + 1 }
    }
  }
  return null
}

// Every `$(...)` and backtick in text that the shell expands (a heredoc body); null if unbalanced.
function substitutionsIn(text: string): string[] | null {
  const found: string[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const sub = readSubstitution(text, i + 2)
      if (sub === null) return null
      found.push(sub.inner)
      i = sub.end - 1
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end === -1) return null
      found.push(text.slice(i + 1, end))
      i = end
    }
  }
  return found
}

// A heredoc delimiter word: its text, and whether any of it was quoted (which turns expansion off).
function readDelimiter(src: string, i: number): { text: string; quoted: boolean; end: number } {
  let j = i
  while (j < src.length && /[ \t]/.test(src[j] as string)) j += 1
  let text = ''
  let quoted = false
  while (j < src.length && !/[\s;&|()<>]/.test(src[j] as string)) {
    const ch = src[j] as string
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, j + 1)
      if (end === -1) break
      text += src.slice(j + 1, end)
      quoted = true
      j = end + 1
    } else if (ch === '\\') {
      text += src[j + 1] ?? ''
      quoted = true
      j += 2
    } else {
      text += ch
      j += 1
    }
  }
  return { text, quoted, end: j }
}

function tokenize(src: string): { tokens: Token[]; opaque: boolean } {
  const tokens: Token[] = []
  let cur = ''
  let has = false
  // A word holding an expansion we cannot see through ($VAR, $(...), `...`).
  let raw = false
  let subs: string[] = []
  // The next word is a redirection target, not an argument.
  let redirectNext = false
  let opaque = false
  const heredocs: Array<{ delimiter: string; strip: boolean; quoted: boolean }> = []
  const push = () => {
    if (has || cur !== '') {
      if (redirectNext) tokens.push({ kind: 'subs', subs })
      else tokens.push({ kind: 'word', text: cur, raw, subs })
      redirectNext = false
    } else if (subs.length > 0) tokens.push({ kind: 'subs', subs })
    cur = ''
    has = false
    raw = false
    subs = []
  }
  // At a newline, read the bodies of any heredocs opened on that line.
  const readHeredocs = (from: number): number => {
    let i = from
    const bodySubs: string[] = []
    while (heredocs.length > 0) {
      const { delimiter, strip, quoted } = heredocs.shift() as { delimiter: string; strip: boolean; quoted: boolean }
      let found = false
      const body: string[] = []
      while (i < src.length) {
        const end = src.indexOf('\n', i)
        const line = src.slice(i, end === -1 ? src.length : end)
        i = end === -1 ? src.length : end + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) {
          found = true
          break
        }
        body.push(line)
      }
      if (!found) i = src.length
      // An unquoted delimiter means the body is expanded: its substitutions run.
      if (!quoted) {
        const inner = substitutionsIn(body.join('\n'))
        if (inner === null) opaque = true
        else bodySubs.push(...inner)
      }
    }
    if (bodySubs.length > 0) tokens.push({ kind: 'subs', subs: bodySubs })
    return i
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i] as string
    const nextCh = src[i + 1]
    if (ch === '\\') {
      if (nextCh === '\n') i += 2
      else {
        cur += nextCh ?? ''
        has = true
        i += 2
      }
      continue
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end === -1) {
        opaque = true
        cur += src.slice(i + 1)
        has = true
        break
      }
      cur += src.slice(i + 1, end)
      has = true
      i = end + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let closed = false
      while (j < src.length) {
        const c = src[j] as string
        if (c === '\\' && j + 1 < src.length) {
          const n = src[j + 1] as string
          if ('"\\$`\n'.includes(n)) {
            if (n !== '\n') cur += n
            j += 2
            continue
          }
          cur += c
          j += 1
          continue
        }
        if (c === '"') {
          closed = true
          break
        }
        if (c === '$' && src[j + 1] === '(') {
          const sub = readSubstitution(src, j + 2)
          if (sub === null) {
            opaque = true
            j = src.length
            break
          }
          subs.push(sub.inner)
          raw = true
          j = sub.end
          continue
        }
        if (c === '`') {
          const end = src.indexOf('`', j + 1)
          if (end === -1) {
            opaque = true
            j = src.length
            break
          }
          subs.push(src.slice(j + 1, end))
          raw = true
          j = end + 1
          continue
        }
        if (c === '$') raw = true
        cur += c
        j += 1
      }
      if (!closed) opaque = true
      has = true
      i = j + 1
      continue
    }
    if (ch === '$' && nextCh === '(') {
      const sub = readSubstitution(src, i + 2)
      if (sub === null) {
        opaque = true
        break
      }
      subs.push(sub.inner)
      raw = true
      has = true
      i = sub.end
      continue
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end === -1) {
        opaque = true
        break
      }
      subs.push(src.slice(i + 1, end))
      raw = true
      has = true
      i = end + 1
      continue
    }
    if (ch === '$') raw = true
    if (ch === '#' && !has && cur === '') {
      const end = src.indexOf('\n', i)
      i = end === -1 ? src.length : end
      continue
    }
    if (ch === '<' && nextCh === '<') {
      push()
      if (src[i + 2] === '<') {
        // A here-string: its word is data, but its substitutions run.
        redirectNext = true
        i += 3
        continue
      }
      const strip = src[i + 2] === '-'
      const word = readDelimiter(src, i + (strip ? 3 : 2))
      heredocs.push({ delimiter: word.text, strip, quoted: word.quoted })
      i = word.end
      continue
    }
    if (ch === '>' || ch === '<') {
      // A redirection, glued to a word or not (`+b2>/tmp/log`, `2>&1`): its target is not an argument.
      if (/^\d+$/.test(cur) && !raw) {
        cur = ''
        has = false
      }
      push()
      let j = i + 1
      while (src[j] === '>' || src[j] === '&' || src[j] === '|') j += 1
      if (src[j - 1] === '&' && /[\d-]/.test(src[j] ?? '')) {
        i = j + 1
        continue
      }
      redirectNext = true
      i = j
      continue
    }
    if (/\s/.test(ch) && ch !== '\n') {
      push()
      i += 1
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      push()
      redirectNext = false
      if (ch === '\n' && heredocs.length > 0) {
        i = readHeredocs(i + 1)
        tokens.push({ kind: 'sep', text: '\n' })
        continue
      }
      const two = ch + (nextCh ?? '')
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        tokens.push({ kind: 'sep', text: two })
        i += 2
      } else {
        tokens.push({ kind: 'sep', text: ch })
        i += 1
      }
      continue
    }
    cur += ch
    i += 1
  }
  push()
  if (heredocs.length > 0) readHeredocs(src.length)
  return { tokens, opaque }
}

type Peeled = {
  argv: string[]
  dir: string | undefined
  env: Record<string, string>
  inner: string | null
  opaque: boolean
  // A reserved word (if, then, do, ...) led into it: it may not run.
  guarded: boolean
}

// Strip leading wrappers so argv[0] is the program that really runs.
function peel(argv: string[], dir: string | undefined, ctx: Context): Peeled {
  let words = [...argv]
  let where = dir
  let guarded = false
  const env: Record<string, string> = {}
  for (let round = 0; round < 12; round += 1) {
    for (;;) {
      const m = words[0]?.match(ASSIGNMENT)
      if (m === undefined || m === null) break
      env[m[1] as string] = m[2] as string
      words = words.slice(1)
    }
    while (words.length > 0 && LEADING_KEYWORDS.has(words[0] as string)) {
      guarded = guarded || words[0] !== 'time'
      words = words.slice(1)
    }
    const head = words[0]
    if (head === undefined) break
    const base = head.split('/').pop() as string
    if (base in WRAPPER_FLAGS_WITH_VALUE) {
      const valued = WRAPPER_FLAGS_WITH_VALUE[base] as string[]
      const chdir = CHDIR_FLAGS[base]
      let k = 1
      while (k < words.length) {
        const w = words[k] as string
        const assign = base === 'env' ? w.match(ASSIGNMENT) : null
        if (assign !== null) {
          env[assign[1] as string] = assign[2] as string
          k += 1
        } else if (w === '--') {
          k += 1
          break
        } else if (w.startsWith('-') && w !== '-') {
          if (chdir !== undefined && (w === chdir.short || w === chdir.long)) where = resolvePath(where, words[k + 1], ctx)
          else if (chdir !== undefined && w.startsWith(`${chdir.long}=`)) where = resolvePath(where, w.slice(chdir.long.length + 1), ctx)
          else if (chdir !== undefined && w.startsWith(chdir.short) && w.length > 2 && !w.startsWith('--')) where = resolvePath(where, w.slice(2), ctx)
          k += valued.includes(w) ? 2 : 1
        } else if (base === 'nice' && /^-?\d+$/.test(w)) k += 1
        else if (base === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(w)) k += 1
        else break
      }
      words = words.slice(k)
      continue
    }
    if (SHELLS.has(base)) {
      // `bash -c 'cmd'`, `sh -lc 'cmd'`: the string is the command line.
      const c = words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w))
      if (c !== -1) return { argv: words, dir: where, env, inner: words[c + 1] ?? '', opaque: words[c + 1] === undefined, guarded }
      // A shell reading a script file or stdin: we cannot see inside.
      return { argv: words, dir: where, env, inner: null, opaque: true, guarded }
    }
    if (base === 'eval') return { argv: words, dir: where, env, inner: words.slice(1).join(' '), opaque: false, guarded }
    break
  }
  return { argv: words, dir: where, env, inner: null, opaque: false, guarded }
}

// The directory a `cd`/`pushd`/`popd` command moves to, as far as the text says.
function cdOf(argv: string[], dir: string | undefined, ctx: Context): string {
  const [head, ...args] = argv
  if (head === 'popd') return UNKNOWN_DIR
  let k = 0
  while (k < args.length && (args[k] as string).startsWith('-') && args[k] !== '-') {
    if (args[k] === '--') {
      k += 1
      break
    }
    k += 1
  }
  const target = args[k]
  // `pushd` with no argument (or +N/-N) rotates the directory stack.
  if (head === 'pushd' && (target === undefined || /^[+-]\d+$/.test(target))) return UNKNOWN_DIR
  return resolvePath(dir, target, ctx)
}

export function parse(line: string, startDir: string | undefined, ctx: Context = {}, budget = { left: 64 }): Parsed {
  const commands: SimpleCommand[] = []
  const { tokens, opaque: tokOpaque } = tokenize(line)
  let opaque = tokOpaque
  let dir = startDir
  let changesDir = false
  const dirs: Array<string | undefined> = []
  let words: Token[] = []
  // The separator before the current command.
  let before = ''
  // A cd waiting for the separator after it: in a pipeline or in the background it runs in a subshell.
  let pendingCd: { to: string; before: string; guarded: boolean } | null = null
  // A cd ran after `&&` in this list: once the list ends, it may not have run.
  let chainMoved = false
  let depth = 0
  // An unconditional `cd x;` that may have failed: where the shell is if it did.
  let ifCdFailed: { target: string; dir: string | undefined } | undefined
  // Brace groups: where each started, and the one that just closed (rolled back if piped or backgrounded).
  const braceDirs: Array<string | undefined> = []
  let closedBrace: { dir: string | undefined; fallback: typeof ifCdFailed } | null = null
  // Functions defined on the line whose bodies cd: calling one makes the directory unknown.
  const cdFunctions = new Set<string>()
  let defining: { name: string; depth: number; dir: string | undefined; fallback: typeof ifCdFailed; cds: boolean } | null = null
  let pendingName: string | null = null

  const sub = (inner: string, at: string | undefined) => {
    if (budget.left <= 0) {
      opaque = true
      return
    }
    budget.left -= 1
    const p = parse(inner, at, ctx, budget)
    commands.push(...p.commands)
    if (p.opaque) opaque = true
  }

  const flush = () => {
    if (words.length === 0) return
    const taken = words
    words = []
    // Substitutions run first, in the directory the command starts in.
    for (const t of taken) if (t.kind !== 'sep') for (const s of t.subs) sub(s, dir)
    const wordTokens = taken.filter((t): t is Extract<Token, { kind: 'word' }> => t.kind === 'word')
    let argv = wordTokens.map(t => t.text)
    // `{ … }` runs in the current shell: it groups, nothing more.
    while (argv[0] === '{') {
      braceDirs.push(dir)
      argv = argv.slice(1)
    }
    while (argv[argv.length - 1] === '}') {
      argv = argv.slice(0, -1)
      if (argv.length > 0) {
        // `{ cmd }`-style close on the same command: settle it first.
        words = []
      }
      const start = braceDirs.length > 0 ? braceDirs.pop() : dir
      closedBrace = { dir: start, fallback: ifCdFailed }
      if (defining !== null && braceDirs.length === defining.depth) {
        // A function body ends: defining it ran nothing, so the shell stays where it was.
        if (defining.cds) cdFunctions.add(defining.name)
        dir = defining.dir
        ifCdFailed = defining.fallback
        defining = null
        closedBrace = null
      }
    }
    if (argv.length === 0 || CLOSING_KEYWORDS.has(argv[0] as string) || argv[0] === '}') return
    if (['for', 'select', 'function', 'in'].includes(argv[0] as string)) return
    if (argv[0] === 'case') {
      // Patterns and arms are hard to separate reliably: say so rather than guess.
      opaque = true
      return
    }
    const first = wordTokens.find(t => t.text !== '{')
    if (first !== undefined && first.raw && !LEADING_KEYWORDS.has(first.text)) opaque = true
    const peeled = peel(argv, dir, ctx)
    if (peeled.opaque) opaque = true
    if (cdFunctions.has(peeled.argv[0] ?? '')) {
      dir = UNKNOWN_DIR
      return
    }
    if (peeled.inner !== null) {
      sub(peeled.inner, peeled.dir)
      return
    }
    const head = peeled.argv[0]
    if (head === 'cd' || head === 'pushd' || head === 'popd') {
      if (defining !== null) defining.cds = true
      if (depth === 0 && defining === null) changesDir = true
      pendingCd = { to: cdOf(peeled.argv, dir, ctx), before, guarded: peeled.guarded }
      return
    }
    if (peeled.argv.length > 0) {
      const fallback = ifCdFailed !== undefined && peeled.dir === dir ? { target: ifCdFailed.target, dir: ifCdFailed.dir } : undefined
      commands.push({ argv: peeled.argv, dir: peeled.dir, env: peeled.env, ...(fallback ? { ifCdFailed: fallback } : {}) })
    }
  }

  // Settle a waiting cd once we know what follows it.
  const settleCd = (after: string) => {
    const cd = pendingCd
    pendingCd = null
    if (cd === null) return
    const inSubshell = ['|', '|&', '&'].includes(after) || ['|', '|&'].includes(cd.before)
    if (inSubshell) return
    if (cd.guarded || cd.before === '||') {
      dir = UNKNOWN_DIR
      ifCdFailed = undefined
    } else if (cd.before === '&&' || after === '&&') {
      // After `&&` the cd ran only if it worked; before `&&` what follows runs only if it worked.
      dir = cd.to
      if (cd.before === '&&') chainMoved = true
      ifCdFailed = undefined
    } else {
      // `cd x;` — what follows runs either way: in x if it exists, else where we were.
      // A second uncertain cd stacks guesses we cannot keep apart: say unknown.
      if (ifCdFailed !== undefined || isUnknown(cd.to)) {
        ifCdFailed = undefined
        dir = UNKNOWN_DIR
      } else {
        ifCdFailed = { target: cd.to, dir }
        dir = cd.to
      }
    }
  }

  for (const t of tokens) {
    if (t.kind !== 'sep') {
      words.push(t)
      continue
    }
    // `name ( )` starts a function definition.
    if (t.text === '(' && words.length === 1 && words[0]?.kind === 'word') {
      pendingName = (words[0] as { text: string }).text
      words = []
      continue
    }
    if (t.text === ')' && pendingName !== null) {
      defining = { name: pendingName, depth: braceDirs.length, dir, fallback: ifCdFailed, cds: false }
      pendingName = null
      continue
    }
    flush()
    settleCd(t.text)
    const closed = closedBrace as { dir: string | undefined; fallback: typeof ifCdFailed } | null
    closedBrace = null
    if (closed !== null && ['|', '|&', '&'].includes(t.text)) {
      // A piped or backgrounded group runs in a subshell: its cd never reached us.
      dir = closed.dir
      ifCdFailed = closed.fallback
    }
    if (t.text === '(') {
      dirs.push(dir)
      depth += 1
    } else if (t.text === ')') {
      if (dirs.length > 0) dir = dirs.pop()
      depth = Math.max(0, depth - 1)
    } else if (t.text === ';' || t.text === '\n' || t.text === '&' || t.text === ';;' || t.text === '||') {
      // What follows runs whether or not the cd after `&&` did.
      if (chainMoved) dir = UNKNOWN_DIR
      chainMoved = false
    }
    before = t.text
  }
  flush()
  settleCd('')
  if (defining !== null) {
    dir = defining.dir
    opaque = true
  }
  // A line ending in `… && cd x` moved only if it succeeded; the caller treats a failed line as unknown.
  return { commands, opaque, endDir: dir, changesDir, ...(ifCdFailed !== undefined ? { uncertainCd: ifCdFailed } : {}) }
}
