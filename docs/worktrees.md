# Worktrees

An isolated checkout per branch, each with its own slot, project slug, ports and containers, so stands do not collide:

```yaml
worktree:
  dir: ../demo.worktrees       # default: <repo>.worktrees next to the repository
  copy: [.env.local]           # files copied into every new worktree
  link: [node_modules/.cache]  # symlinked to the main checkout's
  install: npm ci              # default: by the lockfile (bun, yarn, pnpm, npm); false = none
  slots: 9                     # how many worktrees at most (1 to 99)
```

```bash
mcproc worktree add feat/x [--from main] [--slot 2] [--slug demo-x] [--no-install]
mcproc worktree ls
mcproc worktree remove feat/x [--force]     # by branch, path or slot
```

`worktree add` does, in order: claims the lowest free slot (or `--slot`) in the registry, makes `git worktree add` on the
branch (a new branch starts at `--from`, default the main checkout's HEAD), then reads the new worktree's own manifest
(the main checkout's only when the worktree has none that loads) for the rest: it writes `.mcproc/mcproc.local.yaml` there
with `repo`, `project` (`--slug`, default `<project>-w<slot>`) and, when that manifest declares a `slot` var, `vars.slot`,
copies and links what that manifest declares, and runs its install. So a branch that introduces the slot scheme gets a
correct worktree from the first try, whatever the main checkout's manifest says. It prints the path, which manifest
decided, and how to go on; if git fails the slot is given back.

Machine-local extras stay out of the repository: the main checkout's own `.mcproc/mcproc.local.yaml` may add to the
lists, and every link, from either source, is written as a root-anchored pattern to git's exclude file of the repository
(`.git/info/exclude`, shared by its worktrees, never tracked), so a linked folder does not show as untracked (when git
cannot name that file, mcproc says so and the link stays visible to `git status`):

```yaml
# .mcproc/mcproc.local.yaml of the main checkout
worktree:
  copy: [.env.local]
  link: [notes]               # a folder the repository itself must not name
```

`worktree ls` reads only: each checkout's slot (0 is the main one), project slug, branch, apps online, lease state and
path; a slot whose folder is gone shows `(gone)`, and `add` and `remove` reclaim it. `worktree remove` stops and deletes
the worktree's apps (freeing its leases), removes the checkout and frees the slot; the branch stays. Uncommitted or
untracked changes refuse it unless `--force`, and the main checkout is never removed. The registry is
`<state>/slots/<project>-<hash>.json`.

The agent then passes `project: <worktree path>` on every call for that stand (`start`, `wait`, `logs`...).
