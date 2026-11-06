# Worktrees

An isolated checkout per branch, each with its own slot, project slug, ports and containers, so stands do not collide:

```yaml
worktree:
  dir: ../demo.worktrees                   # default: <repo>.worktrees next to the repository
  copy: [.env.local]                       # files copied into every new worktree
  required: ['*-local.{yml,yaml}', certs]  # copied too, and a worktree without them is refused
  link: [node_modules/.cache]              # symlinked to the main checkout's
  install: npm ci                          # default: by the lockfile (bun, yarn, pnpm, npm); false = none
  slots: 9                                 # how many worktrees at most (1 to 99)
```

```bash
mcproc worktree add feat/x [--from main] [--slot 2] [--slug demo-x] [--no-install] [--allow-missing]
mcproc worktree ls
mcproc worktree remove feat/x [--force]     # by branch, path or slot
mcproc worktree sync [--allow-missing]      # a worktree made by another tool gets its files
mcproc worktree hook [install | remove | status]
```

`worktree add` does, in order: claims the lowest free slot (or `--slot`) in the registry, makes `git worktree add` on the
branch (a new branch starts at `--from`, default the main checkout's HEAD), then reads the new worktree's own manifest
(the main checkout's only when the worktree has none that loads) for the rest: it checks the required entries (see
[Required files](#required-files)), writes `.mcproc/mcproc.local.yaml` there with `repo`, `project` (`--slug`, default
`<project>-w<slot>`) and, when that manifest declares a `slot` var, `vars.slot`, copies and links what that manifest
declares, and runs its install. So a branch that introduces the slot scheme gets a correct worktree from the first try,
whatever the main checkout's manifest says. It prints the path, which manifest decided, and how to go on; if git fails
the slot is given back. A `readonly` local host in the manifest it runs from refuses it before anything is made (no
worktree, branch or slot).

Machine-local extras stay out of the repository: the main checkout's own `.mcproc/mcproc.local.yaml` may add to the
lists, and every link, from either source, is written as a root-anchored pattern to git's exclude file of the repository
(the file `git rev-parse --git-path info/exclude` names, usually `.git/info/exclude`, shared by its worktrees, never
tracked), so a linked folder does not show as untracked (when git
cannot name that file, mcproc says so and the link stays visible to `git status`):

```yaml
# .mcproc/mcproc.local.yaml of the main checkout
worktree:
  copy: [.env.local]
  required: [tool-local.yml]  # a file whose name the repository must not carry
  link: [notes]               # a folder the repository itself must not name
```

`worktree ls` reads only: each checkout's slot (0 is the main one), project slug, branch, apps online, lease state and
path; a slot whose folder is gone shows `(gone)`, and `add` and `remove` reclaim it. `worktree remove` stops and deletes
the worktree's apps (freeing its leases), removes the checkout and frees the slot; the branch stays. Uncommitted or
untracked changes refuse it unless `--force`, and the main checkout is never removed. The registry is
`<state>/slots/<project>-<hash>.json`.

The main checkout is the repository's own working tree, whatever git's layout: a submodule's checkout (git's
`core.worktree` names it), and the checkout of a repository made with `--separate-git-dir`. From one of that
repository's worktrees it is found only once `core.worktree` names it, since git keeps no path back to it there; the
refusal names the command that records it (`git config --file <git dir>/config core.worktree <its path>`, or with
`extensions.worktreeConfig` on, `git --git-dir=<git dir> config --worktree core.worktree <its path>`). A `core.worktree`
that names no checkout of the repository is refused, and so are a bare repository's worktrees: it has no main checkout.

The agent then passes `project: <worktree path>` on every call for that stand (`start`, `wait`, `logs`...).

## Required files

A `required` entry is copied exactly like a `copy` entry, and it must be there: a path must exist in the main checkout
(a link that leads nowhere counts as missing), a mask must match at least one path. An entry in both lists counts once.
`copy` is for conveniences such as a cache, whose absence is only noted; `required` is for what a worktree does not work
without, such as a hook config or development certificates kept out of git, which never come with the branch.

`worktree add` checks them once git has made the worktree and before anything is written into it (the override, the
copies, the links, the install), against the manifest that decides the rest plus the main checkout's override. A miss
refuses with `REQUIRED_MISSING`, naming each entry as written (the mask, never a file it was meant to match), where it
was looked for (the main checkout) and who required it (the worktree's own manifest, the main checkout's manifest or
the main checkout's override), and takes back all the add made: the worktree, its branch when this add created it (an
existing branch stays), the folders a branch with slashes made when they are left empty, and the slot. If
`git worktree remove` itself fails, the worktree, its slot and a branch the add created are kept, and the error names
what is left with the commands that clear it. Put the files into the main checkout and run it again; `--allow-missing`
(MCP `allow_missing`) makes the worktree without them, the misses listed under `missing` and `missing_required` and
marked `(required, allowed)`.

An entry with `*`, `?`, `[` or `{` is a mask, matched by Node's glob from the main checkout:

- `[a]` is one character, not an optional one: `*-local.y[a]ml` matches only `.yaml` files; `*-local.{yml,yaml}` matches
  both. Braces work, and an entry with braces alone (`{.env,.env.local}`) is a mask too, so one match satisfies it.
- `*` does not match a leading dot: `*.env` misses `.env`; start the mask with the dot (`.env*`).
- Avoid `**/`: it walks every folder, `node_modules` and `.git` included. Anchor a mask at the root or in a folder
  (`config/*-local.yml`).
- One match satisfies a mask: with two files it matches, the loss of one goes unnoticed. Name a file that must be there
  by its path.

The committed manifest travels with every clone, so on a fresh machine a mask that matches nothing refuses the
worktree, which is the point. Keep it to masks and typical artifacts (`certs`); a file name the project counts private
goes into the main checkout's `.mcproc/mcproc.local.yaml` (`worktree.required`), which never enters the repository.

## Worktrees made by other tools

Claude Code, Codex, other agents or a plain `git worktree add` make worktrees without mcproc: no slot, no override, no
install, and no copies unless mcproc is told. Two commands bring them the same files (MCP `worktree_sync` with
`allow_missing`, `worktree_hook` with `action`):

```bash
mcproc worktree sync [--allow-missing]            # in the worktree, or --project <its path>
mcproc worktree hook [install | remove | status]  # default: status
```

`worktree sync` brings an existing worktree what `add` would copy and link: the copy, required and link entries of the
worktree's own manifest when it has one that loads, else of the main checkout's, plus the main checkout's override,
copied from the main checkout. The worktree is the git top level of `--project` or the current folder, never the folder
a manifest search walks up to, so a worktree nested in the main checkout (`.claude/worktrees/x`) is found too. A
required miss refuses before anything is copied, unless `--allow-missing`. A `readonly` local host in the manifest that
decides refuses it as well (`READONLY_HOST`, as `exec` is), before anything is written; from the hook below that fails
the `git worktree add` loudly like a required miss, and `worktree hook remove` is refused on that host too, so remove
the hook before marking the host readonly. What is already in its place is `kept`, never overwritten, so a second sync
changes nothing; a copy is published whole or not at all, so a failed one leaves nothing a later sync would take for
done. Links are made where absent and go into git's exclude file. No slot, override or install: those make a stand, and
only `worktree add` makes one. In the main checkout it refuses (`BAD_ARGUMENT`): it copies from there. Worktrees made
before the hook below get their files from a `worktree sync` in each.

`worktree hook install` writes mcproc's `post-checkout` hook (mode 755) where git looks for it in the repository's own
git directory (`git rev-parse --git-path hooks/post-checkout`, usually `.git/hooks/post-checkout`): never a tracked
file, and shared by the main checkout and every worktree, so one install covers them all. From then on every worktree
made through git runs `mcproc worktree sync --hook` in it and gets its copies and links. A required miss there fails
that `git worktree add` loudly with the missing entries and `mcproc worktree sync` as the way to finish; git keeps the
worktree whatever the hook answers. An ordinary `git switch` or `git checkout` (a previous ref that is not all zeros)
runs only the hook's shell tests and starts no node. The main checkout's first checkout of an unborn HEAD passes a null
(all-zero) previous ref as well, so it starts node, and mcproc exits there silently: nothing is copied into the main
checkout. mcproc's own `worktree add` sets `MCPROC_WORKTREE_ADD=1`, so its checkout ends the hook in the shell; the add
copies by itself and rolls back on a miss.

The hook runs this node and this mcproc by their absolute paths, since hook runners may strip `PATH`; without them it
runs a `mcproc` in `PATH`, and without that it fails saying so. `install` again refreshes the paths (after a Node
upgrade, say), and needs a built mcproc (`MCPROC_CLI_ENTRY` names the `dist/cli.js` to run). `status` reports
`installed` with both paths and whether they still exist, `not installed`, `taken by lefthook`, `taken by another hook`,
or `moved aside` (mcproc's hook renamed to `post-checkout.old`, as lefthook does with a hook it replaces). `remove`
deletes mcproc's own hook only. `install` and `remove` are refused on a `readonly` local host, and refused as well:

- a hooks directory outside the repository's git directory (git's config named another): `BAD_ARGUMENT` (`status`
  too), since a hook there may be tracked or shared with other repositories and mcproc's carries this machine's paths.
  Add this line to the `post-checkout` you keep there: `mcproc worktree sync --hook "$1"`.
- a `post-checkout` that is not mcproc's (a file or a link, lefthook's included): `HOOK_TAKEN`, and nothing is
  overwritten or deleted. Add the line above to it; for lefthook, a job in `lefthook.yml`:

```yaml
post-checkout:
  jobs:
    - run: mcproc worktree sync --hook {1}
```

lefthook looks for its own binary in the worktree's `node_modules`, which a fresh worktree lacks, so a plain hook is the
more reliable carrier.

Git runs no `post-checkout` for `git worktree add --no-checkout`: run `mcproc worktree sync` once the files are checked
out. A Claude Code `WorktreeCreate` hook replaces Claude Code's own `git worktree add`; a worktree that hook makes
without a git checkout gets nothing from mcproc's hook, so have it run `mcproc worktree sync` in the new worktree.
