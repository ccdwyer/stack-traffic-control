# Stack Traffic Control

![Stack Traffic Control demo](media/demo.gif)

The band above the prompt, the `/stack` departure board, and a raw force-push refused with the `gh stack` alternative. [MP4](media/demo.mp4)


A Claude Code mod that acts as a departure board for [`gh stack`](https://gh.io/stacks), GitHub's official stacked-PR extension.

- **`/stack`** opens a pane listing the stack top to bottom. For each branch it shows the PR number, CI checks (✓ ✗ …), and whether the branch is ready, needs a rebase, is queued or has landed. It also shows unpushed commits (↑, or *unpublished* for a branch that has never been pushed) and uncommitted changes (✎). A **refresh** button updates it.
- **Above the prompt**, when you're on a stacked branch: `🛫 stack 2/4 · feature-b · 1 needs rebase`.
- **Guard.** In a repo that uses gh stack, some raw commands are refused, and the model is shown the exact `gh stack` command to use instead and why. The repo's stack file (`<git-common-dir>/gh-stack`) decides what is protected: every branch of every stack, and their trunks, are protected from force-pushes and deletes, whichever branch you're on. Rebase, pull and PR rules apply when you're on a stacked branch.

  | Raw command | Use instead |
  |---|---|
  | `git push --force` / `-f` / `--force-with-lease` / `+refspec` / `--mirror` / glob refspecs / `--delete` hitting a stack branch | `gh stack push`, `gh stack submit --auto`, `gh stack sync --prune` |
  | `git rebase` onto the trunk, a layer or `@{u}` (also `--onto=`, or a bare `git rebase`) | `gh stack rebase` (`--downstack`, `--upstack`, `--no-trunk`) |
  | `git pull` that would rebase or merge (flags and `pull.rebase` / `pull.ff` config; fast-forward-only pulls pass) | `gh stack sync` |
  | `gh pr edit --base` on a stack PR | `gh stack submit --auto` / `gh stack modify` |
  | `gh pr create` for a stack branch | `gh stack submit --auto` |

  These commands still run, with a note attached for the model:
  - A rebase that stays inside the branch (`git rebase -i HEAD~3`) runs, with a reminder to follow up with `gh stack rebase --upstack`.
  - `git rebase --continue`, `--abort` and `--skip` run, with a reminder about the `gh stack rebase` equivalents.

  These pass untouched:
  - force-pushing tags or unrelated branches
  - PRs whose head isn't a stack branch
  - PRs in another repo (`--repo`)
  - anything run off a stack

  The guard reads the Bash line the way a shell would. It looks inside:
  - quoting, escapes, line continuations and redirections. Quoted heredoc bodies are data. In unquoted heredocs and redirect targets, `$( … )` is checked.
  - `;`, `&&`, `||` and `|`
  - subshells `( … )`, groups `{ … }`, `if`/`while` bodies, and `$( … )` / backtick substitutions
  - `bash -c '…'` and `eval`
  - wrappers: `env`, `sudo`, `nohup`, `time`, `nice`, `command`, `exec`, `xargs`, `timeout`
  - `cd` / `pushd` (including `~` and options), `env -C`, `sudo -D`, `git -C`, `--git-dir` and `--work-tree`. A `cd` inside a pipeline, a background job or an `if` body is handled the way the shell handles it. It also remembers where the Bash tool's persistent shell is across calls.

  It **fails closed** in four cases, but only in repos that use gh stack:
  - The stack file can't be checked or read. The command is refused with the reason rather than allowed.
  - A `cd` leaves the directory unknowable (`cd -`, `cd $X`, a `cd` that may not have run). Git steps are refused until a literal `cd` settles it.
  - The line can't be read (a substitution as the program, an unbalanced quote) and could push, rebase, pull or edit a PR. It is refused, and the model is asked to run that step as a plain command.
  - A line switches branch and then pushes. It is refused, and the model is asked to split it, because the push can't be checked against a branch it isn't on yet.

  The guard also follows:
  - configured push refspecs (`remote.<name>.push`, `remote.<name>.mirror`) and `push.default`, including `upstream`
  - `branch.<name>.rebase`, `pull.rebase` and `pull.ff`, plus `git -c` overrides
  - `GIT_DIR` / `GIT_WORK_TREE` prefixes
  - `git rebase <upstream> <branch>`, which rewrites `<branch>` whatever HEAD is

  Known limits, as a safety net and not a sandbox:
  - a program name hidden in a variable (`$GIT push -f`)
  - a script run as `bash script.sh` / `source` with no git text on the line
  - git aliases
  - `git reset --hard` and `git merge` on a stacked branch, which aren't checked

"Needs rebase" combines `gh stack`'s own flag with a check that each layer contains its parent layer's tip. Repos that have never used gh stack (no stack file) are never looked into further, so the guard costs nothing there.

## Requirements

- [GitHub CLI](https://cli.github.com) with the stack extension: `gh extension install github/gh-stack`

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install stack-traffic-control@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```
