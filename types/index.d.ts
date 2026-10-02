// One layer of the stack, as `gh stack view --json` reports it plus our own ancestry check.
export type StackBranch = {
  name: string
  isMerged: boolean
  isQueued: boolean
  needsRebase: boolean
}

// What a look at one checkout found. `stacked` means the repo uses gh stack
// (its stack file was read); `none` is confirmed (no stack file); `unknown`
// means the look itself failed, so the guard fails closed.
export type Stack = {
  root: string
  status: 'stacked' | 'none' | 'unknown'
  reason: string
  // The checked-out branch ('' when detached, as in the middle of a rebase).
  branch: string
  // Every branch of every stack in the repo, and every stack's trunk.
  protectedBranches: string[]
  trunks: string[]
  // The stack the current branch is on, if any: its trunk and layers bottom to top.
  trunk: string
  branches: StackBranch[]
  remotes: string[]
  // The git config the guard reads (push/pull policy, remote push refspecs, branch upstreams), keys lowercased.
  config: Record<string, string[]>
  at: number
}

// What the pane adds on a refresh: PR, checks, unpushed commits, a dirty tree.
export type BranchDetail = {
  pr: number | null
  state: string | null
  checks: 'pass' | 'fail' | 'pending' | 'none' | null
  // Commits ahead of the branch's upstream; null when unknown.
  unpushed: number | null
  // False when the branch has no upstream yet (never pushed); null when unknown.
  published: boolean | null
  dirty: boolean
}

// One refresh of the pane, for one checkout, published whole.
export type Board = { root: string; rows: Record<string, BranchDetail>; at: number }

declare module 'claude-code' {
  interface PluginState {
    'stack-traffic-control': {
      // Keyed by repo root: the last look at that checkout's stack (band only; the guard looks fresh).
      stacks: Record<string, Stack>
      // The repo the session is in, so the band and pane know which stack to draw.
      root: string | null
      board: Board | null
      loading: boolean
      // A refresh was asked for while one ran: run again when it ends.
      pending: boolean
      // Where the Bash tool's persistent shell is, as far as top-level `cd`s tell us.
      shellDir: string | null
    }
  }
}
