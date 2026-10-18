# mcproc

pm2 process control for coding agents, over MCP and on the command line. One manifest per project
describes what each launch is; the agent (or you) starts, restarts, reads logs and, above all, sees
which ports each app really listens on. Works on the local machine and on remote hosts over ssh
and `docker exec`. The processes are plain pm2 processes: `pm2 monit` in any shell shows the same thing.

## Install and register

```bash
npm i -g mcproc            # or run it with: npx -y mcproc
claude mcp add -s user mcproc -- mcproc mcp       # Claude Code, once, user scope
```
From a checkout instead: `bun run build && node dist/cli.js install` writes a `mcproc` launcher into
`~/.local/bin` (adding that directory to your shell rc when it is not on `PATH` yet); `install --uninstall` removes it.
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.mcproc]
command = "mcproc"
args = ["mcp"]
```
The server finds the project from `MCPROC_PROJECT`, then `CLAUDE_PROJECT_DIR` (set by Claude Code),
then the client's MCP roots, then its working directory, and looks upward for `.mcproc/mcproc.yaml`.
Every tool also accepts an explicit `project` path.

## Quick start

```bash
cd my-project
mcproc init          # writes .mcproc/ (gitignored) with a manifest draft: on a turbo repo the dev task's apps are live, the rest commented out
$EDITOR .mcproc/mcproc.yaml   # write a description for each app; uncomment what else you need
mcproc start base    # or an app name, or "all"
mcproc ls            # status, pid, uptime and real vs declared ports
mcproc init --adopt-ports   # write the ports ls shows as undeclared into the manifest
mcproc logs api -n 200
mcproc logs base --since 2m    # every app of a profile, merged by time stamp
mcproc doctor        # why a host cannot be driven, and what to do
```

## Upgrading from 0.10

`{{` in a manifest string is now a template (see *Variables*). A manifest from 0.10 that holds a literal `{{` in a
string under `apps`, `hosts`, `worktree` or `exec`, such as a docker `--format '{{.Names}}'` in a `run` line, no longer
loads: write the literal as `\{{` (`docker ps --format '\{{.Names}}'`), which renders as `{{`. The refusal is
`BAD_TEMPLATE` and names the field, for example `apps.ps.run: unexpected "." in ".Names"`.

## The manifest: `.mcproc/mcproc.yaml`

```yaml
version: 1
project: demo                  # pm2 namespace and process-name prefix; default: directory name
vars:                          # per-checkout values, see *Variables*
  slot: 0
apps:
  libs:
    description: one-shot build of the shared libraries into dist/
    kind: task                 # runs once; ls shows done / failed (exit N)
    run: npm run build:libs
  api-build:
    description: tsc watch build of the API into dist/
    kind: build                # build | server | worker | task (default server)
    run: npx tsc -w -p apps/api
  api:
    description: HTTP API serving /health
    run: node dist/apps/api/main.js
    cwd: .                     # relative to the project root
    env: { PORT: 3310 }
    port: 3310                 # declared listening port (or ports: [3310, 9230])
    url: http://localhost:3310/   # optional: the address to open; ls/describe show it with the HTTP answer, monit shows it
    memory: 600M               # expected memory, see *Memory*
    containers: [demo-db]      # docker containers the app owns
    watch: [dist/apps/api]     # pm2 restarts the server when the build output changes
    depends_on:
      - { app: libs, condition: completed }   # wait for the build to exit 0
      - api-build                              # plain name = started (start order only)
profiles:
  base: [libs, api-build, api]   # "all" is built in
hosts:                         # "local" is implicit
  stand:
    ssh: stand                 # alias from ~/.ssh/config; no secrets live here
    cwd: /srv/demo             # project root on that host
  prod:
    ssh: prod
    docker: { container: demo-app, user: node }
    cwd: /home/node/demo
    readonly: true             # every mutating tool is refused here
```
Other app fields: `host` (see below), `url_check` (see *URLs*), `watch_delay`, `ignore_watch`, `autorestart`, `pm2:` (raw pm2 fields merged last).
Other host fields: `ssh_args`, `shell` (default `/bin/bash -lc`), `pm2` (binary or command), `pm2_home`,
`runtime`, `env` (merged into every app on that host). Names match `^[a-z0-9][a-z0-9._-]*$`.

The folder is created with a `.gitignore` containing `*`: it never enters your repository, so each
checkout keeps its own. `.mcproc/README.md` holds free-form notes that `describe` returns.

### Kinds

| kind | what it is | autorestart | `ls` shows after it exits (autorestart on: pm2's words; off: the words below) |
|---|---|---|---|
| `server` | a process that listens (default) | on | `stopped`, `errored` |
| `worker` | a process without a port | on | `stopped`, `errored` |
| `build` | a long-running watch build | on | `stopped`, `errored` |
| `task` | runs once: a build, a migration, a seed | off | `done`, `failed (exit N)`, `stopped` |

Autorestart defaults to on for every kind except `task`, which defaults it off. `autorestart: false` on any kind
gives the same behaviour as a task, and `autorestart: true` on a task is refused. For an app with autorestart off,
the exit code is pm2's `exit_code`: 0 is `done`; no code, 130 or 143 (a stop) is `stopped`; any other code is
`failed (exit N)`. So a task that itself exits 130 or 143 reads `stopped`. A manual stop reads `stopped` because
mcproc puts `trap 'exit 130' INT; trap 'exit 143' TERM;` in front of the command of an app with autorestart off,
since pm2 itself records exit code 0 for a process killed by a signal. Two edges: a `run` that starts with `exec …`
replaces the shell and loses the trap, so a manual stop of it reads `done`; a task whose process tree takes longer
than pm2's kill timeout (1.6 s by default) to exit after SIGINT, whether it ignores the signal or only cleans up
slowly, is killed with SIGKILL and also reads `done`. The host shell must be POSIX (`bash` or `sh`): the default shell and the
documented `/bin/sh -c` both are. pm2 keeps no exit time, so UPTIME stays `-`. `start` on a done or failed task runs
it again. `init` drafts `build`, `migrate`, `seed` and `once` scripts as tasks and watch-style commands as `build`.

### Monorepos

On a turbo repo whose `turbo.json` has a persistent `dev` task, `init` drafts the dev stack live: each workspace package
with a `dev` script becomes an uncommented app named after the package, and together they form the `dev` profile, so
`start dev` runs them. Their placeholder description, `TODO: what this app does`, lets the manifest load as is until you
replace it. The root `dev` script, other persistent tasks (under a commented profile) and every other script stay commented.

- Libraries consumed from `dist/` (a `build` script plus `main`, `module`, `types` or an `exports` target under `dist/`)
  share two apps instead of a `<pkg>-build` each: `libs`, one `turbo run build` over them (`kind: task`), and `libs-watch`,
  `turbo watch build` once `libs` has completed (turbo 1 has no `turbo watch`, so there `libs` comes alone). A live app
  that depends on such a library, directly or through other packages, gets
  `depends_on: [{ app: libs, condition: completed, timeout: 600 }]`: the longest wait the manifest allows, since a cold
  build of many libraries can outlast the default 60 s.
- A library live through its own `dev` watch is drafted as a `build` app and left out of `libs`, so its first build is not
  awaited: the draft leaves a note on each app that uses it saying how to wait for it.
- Ports are also guessed for Next (3000), Vite (`server.port` in `vite.config.*`, or `preview.port` for `vite preview`,
  as a literal or an env read's fallback, `process.env` or loadEnv's `env`, directly or through a constant of the config;
  5173 or 4173 when the section sets no port, no guess when it sets one `init` cannot read) and, in `src/`, `PORT = N`,
  `DEFAULT_PORT = N`, `PORT ?? N`, `PORT || N` or `.listen(N)`. The guess shows as `port?` in each candidate's
  `# source:` trailer; a live app also declares it as `port:` (and `url:`), so check it with `ls` (a wrong guess shows
  ✗) and correct it by hand: `--adopt-ports` adds the real port but leaves the guess in place.
- `init --adopt-ports` (MCP: `adopt_ports`) drafts nothing and ignores `--force`: it needs an existing manifest and writes
  the ports `ls` reports as undeclared for the running apps into it, comments and layout kept, then prints the diff. Ports
  from 32768 up (the ephemeral range, almost always transient) and ports another app declares are reported, not adopted.
  It refuses a manifest that marks the local host readonly, and a file that changed while the hosts were probed
  (`ALREADY_EXISTS`: run it again).

### Apps on several hosts

When part of a dev stack runs elsewhere, say watch builds on your machine and the dev server inside a
dev container, bind those apps to their host with `host:`:

```yaml
apps:
  libs-watch:
    description: watch build of the shared libraries
    kind: build
    run: npm run watch:libs
    host: local
  web:
    description: dev server inside the dev container
    run: npm run dev
    host: devbox
hosts:
  devbox:
    ssh: dev@devbox.local
    ssh_args: ["-p", "2222"]
    cwd: /home/dev/project
```

A bound app always runs on its host. An app without `host:` runs wherever the command points:
`--host`, or local when there is none.

- Without `--host`, every command reaches each app at its own host. `ls` prints one table with a HOST
  column (one probe per host, in parallel). `start`/`stop`/`restart`/`delete` of a profile or `all` go to
  each app's host in dependency order, and a dependency on another host starts first, on that host.
  `logs -f` streams them all, and `monit` shows them all on one screen.
- With `--host X`, a command reaches only the apps that run on X: the apps bound to X and the unbound
  ones. Naming an app bound elsewhere is refused before anything runs.
- A host that does not answer never holds the others back. `ls` shows its apps as `unreachable` rows
  with the reason. `monit` keeps their last known rows and names the host in the footer. `logs -f` prints
  one note per app and picks the stream up where it was once the host is back, and a host that was down
  at the start gets connected later. A change that fails on one host keeps the rows of what already
  happened (`start` skips what comes after the failure). A readonly host refuses the whole change before
  any host is touched, and the error names the apps that run there, dependencies included.
- ssh gives up connecting after 10 s (`-o ConnectTimeout=10`). A `ConnectTimeout` in `ssh_args` wins.

## Variables and a per-checkout override

Ports, container names and paths that differ per checkout are variables, declared once under `vars:` with a default:

```yaml
vars:
  slot: 0                      # the main checkout; a worktree gets its own (see *Worktrees*)
  web_port: '{{ 5181 + slot * 100 }}'   # a default may use the vars before it
apps:
  web:
    description: dev server
    run: npm run dev -- --port {{ web_port }}
    port: '{{ web_port }}'     # port and ports are templates only as quoted strings
  db:
    description: postgres for the stand
    run: docker run --rm --name {{ project }}-db -p {{ 5432 + slot }}:5432 postgres
    containers: [ '{{ project }}-db' ]
```

- `{{ expr }}` takes names, integers, `+ - * / %` and parentheses; division truncates. `\{{` writes a literal `{{`,
  which a docker `--format '{{.Names}}'` in a `run` line needs. The syntax is `{{ }}` because bash, Caddy and compose own
  the other ones.
- The built-ins are `project` (the pm2 namespace of this checkout) and `root` (its project root).
- Templates work in every string field under `apps`, `hosts`, `worktree` and `exec.env`. They do not work in `project`, in
  the names of apps, profiles and hosts, or in the `vars` names.
- `.mcproc/mcproc.local.yaml` is the checkout's own override (it lives in the gitignored folder). It holds `project` (the
  slug this checkout runs under), `repo` (the main checkout, for a worktree) and `vars` (values that win over the
  defaults). A var the manifest does not declare is refused. In a main checkout it may also hold `worktree` (`copy`,
  `link`): machine-local extras for every new worktree (see *Worktrees*).
- `describe` without an app prints the resolved vars, where each value came from, and the override's path.

The slot idiom: the manifest says `slot: 0` and writes ports as `'{{ 5181 + slot * 100 }}'` and containers as
`{{ project }}-db`. The main checkout keeps 5181 and `demo-db`; a worktree at slot 2 gets 5381 and `demo-w2-db`.

## Memory: budgets and the lease queue

Several stands on one machine can starve it, so a `start` asks for memory first. The manifest declares what an app needs:

```yaml
resources:
  reserve: 2G                  # what the host keeps for everything else (default 2G; also a percentage, 15%)
  margin: 10%                  # added to every estimate (default 10%)
  settle: 20                   # seconds a fresh start still counts as ramping up (default 20)
apps:
  api:
    memory: 1.5G               # what the app is expected to take
    containers: [demo-db]      # docker containers it owns: removed with it, counted in its memory
```

- **The estimate**, per app: the larger of the declared `memory:` and what a running sibling slot of the same app
  measures (its process tree plus its declared containers; the largest among the siblings). The lease's need is
  `ceil(estimate × (1 + margin))`.
- **Admission.** The start runs at once when `MemAvailable − reserve − ramping` covers the need and nothing is pending
  ahead of it. `ramping` is the need of running leases admitted within `settle` seconds, or whose starter is still alive.
  Otherwise the answer is `queued #N`, and the queue is strict FIFO: a small start never jumps a large one. A stand that
  could not fit even on an idle host is refused with `NEVER_FITS`.
- **The watcher** is a pm2 process, `mcproc-watcher` in the `mcproc` namespace. It judges the head every 2 s and at once
  when the queue changes, exits after a minute idle, and the next queued start launches it again. While the head waits,
  each tick reads the memory alone; its siblings are measured again when that reading lets it fit, when the queue
  changes, and every 30 s. Each full judgement budgets the head again (apps that came up meanwhile drop out of its need),
  and a queued start keeps the `--host` it was given. It ends leases whose owner is gone (`checkout gone`, `requester gone`) and an admitted exec
  that has not run within 60 s (`the exec did not take its turn`). `stop` and `delete` cancel the starts they overlap
  before stopping, and free the running leases afterwards.
- `docker stats` costs about 2 s per call, so the containers' memory is asked only by `ls` (its MEM column includes it for
  apps that declare `containers:`), `describe` and the sibling measurement; never by monit's loop or by `wait`.
- **Looking and cancelling.** `mcproc leases` (tool `leases`) shows the host's queue: who runs, who waits and why, the
  memory reading and the watcher. `leases cancel <id>` cancels a pending lease or a starting exec; a starting start is
  refused: stop its target instead. `ls` shows a queued app as `queued #N`, `wait` rides through the queue, `doctor`
  reports the state directory and the watcher. `start --note <text>` keeps a reason on the lease.
- **State** lives in `~/.local/state/mcproc` (or `$XDG_STATE_HOME/mcproc`, or `MCPROC_STATE_DIR`): `leases/`, `slots/`,
  `watcher.json` and `watcher.ecosystem.json`. A dev checkout runs the watcher from the bundle `MCPROC_CLI_ENTRY` names.

### Exec: one-off work under a lease

```bash
mcproc exec --memory 4G --note "e2e run" -- npx vitest run     # --timeout <s> bounds the wait in the queue (default 600, max 3600)
```

`exec` runs a command from the project root with the manifest's `exec.env` (templates allowed, so it can point at this
checkout's ports) and `MCPROC_PROJECT` set. With `--memory` it is a lease like a start: it runs at once when the host has
room, else waits its turn, and frees the lease when the command exits. Without it, it runs at once. The MCP tool returns
the exit code and the last 200 lines of output, and is marked destructive: it runs any local argv. It reads that output
through pipes: a process the command leaves behind on them (a server sent to the background) loses them one second after
the command exits (its next write gets EPIPE), so such a process should detach its own stdio.

### Limits

- Leases are local: `exec` and the worktree commands refuse a `host`, and a `start` of an app bound to a remote host that
  declares `memory:` is refused (`LEASE_UNSUPPORTED_HOST`). That makes monit's `R` key (`start all --reload`) refuse such
  a manifest.
- Without `/proc/meminfo` (not Linux) there is no memory reading, so nothing is checked.

## Worktrees

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
(`.git/info/exclude`, shared by its worktrees, never tracked), so a linked folder never shows as untracked:

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

## Readiness: `wait` and `depends_on` conditions

`wait` (MCP tool, `mcproc wait <app> --until <cond> [-t 60]` on the CLI) blocks until an app is usable or finished,
instead of sleeping and polling:

| `until` | met when |
|---|---|
| `listening` | every declared port is bound (needs `port`/`ports`) |
| `url-ok` | the `url` answers 2xx/3xx, checked as `ls` checks it (on the host, and from this machine when the host gets no answer; see *URLs*) |
| `exited` | the process left `online`; with autorestart off the answer carries `exit_code` and `done` / `failed (exit N)` / `stopped`, otherwise pm2's `stopped` or `errored` |
| `log:<regex>` | a new line of its out or err log matches (ANSI stripped, matched against the line without pm2's time stamp; the answer keeps the stamp; history is not searched) |
| `idle:<seconds>` | no log output for that long: a watcher settled |
| `reloaded` | the app's next in-process reload (see *Reloads*) has been quiet for 2 s; the answer carries its time, its line count and its first restart or rebuild line, else its first line |

Without `curl` or `wget` on the host, `url-ok` under `url_check: auto` asks from this machine; under `url_check: host` it runs to the timeout and reports `unchecked`.
`log:`, `idle:` and `reloaded` see only output written after the call begins, and notice a dead process only every 5 s; for
"is it up" prefer `listening` or `url-ok`. `wait --until exited` succeeds (exit code 0) once the process has exited,
whatever its exit code; scripts read `exit_code` in `--json` or the `(exit N)` in the line. A wait on an app that
was never started is a `NOT_STARTED` error, not a result. `listening` needs a declared port, `url-ok` a declared
url and `reloaded` an app without `reloads: false`, else `BAD_ARGUMENT`. `exited` on an app that has already stopped answers at once.

After a `restart`, and for an app that pm2 itself restarts on a change (`watch:`), wait until `listening`. An app that
reloads in place (a watcher: tsx watch, nodemon, `node --watch`, Vite, `next dev`) keeps its process and its port, so
`listening` answers at once while the old code may still run: after an edit, follow it with `wait until: reloaded`.

The answer is one line: `web: listening after 1.3 s (:3000 ✓)`, `libs: done after 12.4 s (exit 0)`. On timeout
(default 60 s, max 600) it says what was last seen (`web: listening not reached after 60.0 s (status online, :3000 ✗
nothing listens)`), and `ok` is false. If the process dies meanwhile, the wait ends at once with its reason and
status and no observation, for example `web: exited (stopped) after 3.2 s while waiting for listening` (`observed`
is in `--json`). Either way it is a result, not an error, and the CLI exits 1. Local apps are checked twice a second, remote ones once; `log:`/`idle:`/`reloaded` read the log as it grows. A process that pm2 is
restarting (a watch restart, a restart delay) is not dead: the wait goes on, bounded by the timeout. `listening` and
`url-ok` count only while the process is online or launching; a restart in progress is waited out, and a port or url that
still answers after the process died is not ready. Claude
Code does not cut a long MCP call, but moves one into the background after two minutes. A cancelled MCP `wait` (or
`start`) call stops the polling at once.

`depends_on` entries can name what they wait for:

```yaml
depends_on:
  - logger                                        # a name: start order only
  - { app: libs, condition: completed }           # the task exited with code 0
  - { app: api,  condition: ready, timeout: 90 }  # ports listening, or the url answers; default 60 s, max 600
```

`completed` needs a `kind: task` dependency; `ready` one with a port or a url (ports are checked when declared, the
url otherwise). `start` launches dependencies first, as before, and waits at each such edge, on the dependency's
host, also when the dependent runs elsewhere. A done task is run again, a running one is waited on. When a dependency
fails, times out or dies, the dependent is not started: its row reads `skipped` with the reason, and so do the apps
that depend on it; unrelated apps still start. The answer adds `waited 4.2 s for libs (completed)` for each wait that was met (a failed
wait shows in the rows), `start`'s JSON carries the waits as `waits[]`, and the CLI exits 1 when anything was skipped. With `--host X`, dependencies that run elsewhere are neither started nor waited for.
`restart` does not order apps by their dependencies or wait for conditions; `start` does, and `start --reload`
restarts the apps that are already online the same way.

## Logs since a point in time

After a restart, "what happened since" is one call over a profile instead of a tail per app. The MCP `logs` tool takes
`targets` (apps, profiles or `all`) and `since`: a span (`90s`, `2m`, `2h`, at most 24 h), a time
(`2026-10-14T07:30[:00[.000]]`), or `last`, everything since your previous `logs` call over those apps in this MCP
session (a first call gives the last 100 lines of each log file). A time without a zone is the host's local time; with
`Z` or `+02:00` it is converted with each host's own zone. Lines are picked by pm2's stamps, which are in each host's
local time, and ordered by the moment they were written: each host's UTC offset, read along with its clock, puts hosts
in different zones on one timeline (a host whose zone cannot be read is placed by its raw stamps, and a note says so).
Each host's clock may still drift: a host whose clock runs ahead or behind has its lines placed that much later or
earlier. Each file is read at most 1 MB back: when the window reaches further, `skipped` names the bytes not read.
`lines` caps the merged answer (the most recent kept) and `truncated` counts what was dropped; `targets` without
`since` gives the latest `lines` (default 100) across the apps.
On the command line, `mcproc logs base --since 2m` prints the merged lines and exits, and `-f --since 2m` then follows
from exactly where that read ended; an app that was not running yet is shown from the same cutoff once it starts. `last`
needs the session that keeps the marks, so the CLI refuses it.

## Reloads

Dev tools in watch mode reload after an edit inside their own process. pm2 sees none of it: RESTARTS stays 0, and a
port that never closed says nothing about which code answers. mcproc reads these reloads from the app's log. A
reload is one of these lines, matched without pm2's stamp and with ANSI stripped:

- a restart: tsx's `[tsx] … Restarting...`, nodemon's `restarting due to changes`, `node --watch`'s `Restarting '…'`;
- a rebuild: Vite's `[vite] page reload` or `hmr update`, Next's `✓ Compiled in …` (with a page path, `✓ Compiled /page
  in …`, it is that page's first compile and does not count) and `Reload env:`, tsc's `File change detected. Starting
  incremental compilation`;
- a repeated `listening on` or `listening at` line, for watchers that print nothing else (`bun --watch`).

Marker lines less than 2 s apart, stdout and stderr together, are one reload: a library rebuild that prints a line per
changed file counts once, and so does a restart followed by the server's new `listening` line. The first burst after
pm2 starts the process, when it holds only `listening` lines, is the boot, not a reload. A restart less than 2 s after
the boot's `listening` line joins the boot's burst: it counts once, and is shown by the restart line. Counting starts at
pm2's start of the process: lines an earlier run left in the same log file never count.

Per app:

```yaml
apps:
  api:
    description: API under a home-grown file watcher
    run: node scripts/dev.js
    reloads:
      match: ['^\[devwatch\] reloaded']   # more markers (JavaScript regular expressions)
      ignore: ['listening on queue']       # never a reload
      defaults: true                       # false: only your own patterns, no built-in markers
```

`reloads: false` turns it off for an app. Own patterns follow the rules of `errors` patterns: matched against the first
2000 characters of each line, a repeat of a repeat refused when the manifest loads, and stopped when they take longer
than 2 seconds on an app's log, which leaves that app's reloads uncounted with an error while the other apps go on.

Four places show them:

- `wait until: reloaded` (`mcproc wait web --until reloaded`) answers once the app's next reload has been quiet for 2 s,
  with its time, its line count and its first restart or rebuild line, else its first line:
  `web: reloaded after 3.0 s (3 lines from 2026-10-14T12:00:01.000): [vite] (client) page reload /src/a.ts`. A server
  whose reload restarts it may print its new `listening` line more than 2 s later, after the reload was answered: wait
  until `listening` next. A wait that times out or is aborted while a reload is still under way says so, with `ok`
  false: `reload in progress since 2026-10-14T12:00:59.000 (2 lines): [tsx] change in src/a.ts Restarting...`.
- `incidents` with `include_reloads: true` (`mcproc incidents --reloads`) adds one `reloaded` incident per app with
  the reloads since the last call: how many, the first and the last one's time, and the last one's first restart or
  rebuild line, else its first line.
- `ls` with `reloads: true` (`mcproc ls --reloads`) adds each running app's reloads since its pm2 start to RESTARTS,
  `0 (+7)`, and to each JSON row as `reloads: { count, last, partial }`. It reads each host's logs once more, so a plain
  `ls` does not count them.
- `monit` shows them in the selected app's detail line while it runs (online or launching), `restarts 0 (+7 reloads,
  last 12:01:05)`, counted for the apps whose logs it follows: the selected one on the dashboard, every running one in
  the flat view. `monit --once` counts from the history it reads.

Limits. A count marked `≥` (`0 (+≥7)`, `+≥7 reloads`) is a lower bound: the log was cleared since the process started,
or the app wrote more than the last 1 MB that is read. monit and `monit --once` count from the history they read, the
last `--lines` lines of each log (200 by default), so an app that has run for a while often shows `+≥7` there where
`ls --reloads` shows an exact `+7`. An err log whose first line came more than a minute after the start also marks
monit's count `≥`: monit cannot tell where in the file its history began. A reload whose lines are split between two
`incidents` calls is reported in both. With `include_reloads`, an app whose own `reloads` patterns run away also has
its error incidents held back, and its point stays where it was, until the patterns are fixed. The process start is
pm2's start time read in the host's current time zone, so a daylight saving change since the start, or a pm2 daemon
started under a different `TZ`, can shift it, and with it which lines count.

A process that runs several servers (a turbo or concurrently dev task, `docker compose up`) is one app, and only its
first burst of `listening` lines is the boot: a later server whose first `listening` line comes more than 2 s after the
one before it counts as a reload. Put that server's line in the app's `reloads.ignore`, for example
`ignore: ['ws listening on']`.

## Tools (MCP) and commands (CLI)

| tool | what it does |
|------|--------------|
| `describe [app]` | project summary with descriptions, URL, profiles, hosts and the notes file; or one app in detail |
| `ls [app]` | one row per app, each from the host it runs on: pm2 status, pid, uptime, restarts, memory and CPU of the whole process tree, ports with `✓`/`✗` against the declared ones, the URL with its HTTP answer (`(here)` when it answered from this machine, a short reason when down), the real runtime command; `reloads` (`--reloads`) adds each running app's in-process reloads since its pm2 start to RESTARTS, `0 (+2)` |
| `ports [port]` | every listening socket on the host with its pid and owning app, or who holds one port |
| `logs [app \| targets, since]` | tail of one app's out/err (ANSI stripped), or the merged, time-ordered lines of several apps: the latest lines, or since a span (`2m`), a host-local time, or `last` (since your previous `logs` call over those apps in this MCP session); `app \| line`, `app ! line` for stderr |
| `incidents [app]` | new errors with context since they were last taken, plus crashes and restarts (cheap to poll; `peek` looks without taking); `include_reloads` (`--reloads`) adds each app's in-process reloads since the last call |
| `wait <app> until=…` | block until listening / url-ok / exited / a log line matches / idle / reloaded, with a timeout; ok false with what was last seen |
| `hosts`, `doctor` | hosts from the manifest with the apps bound to each; per-host readiness (reachable, Node, which pm2 and why, ps/ss/tar, daemon; the host's environment and where each url answers) |
| `init` | manifest draft from package.json scripts, workspaces, nx `project.json`, `turbo.json` (a turbo repo's dev task drafts live, with a `dev` profile and `libs` / `libs-watch` builders for dist-built libraries), `ecosystem.json`, `Procfile`; `adopt_ports` writes the ports `ls` reports as undeclared into the existing manifest |
| `start <target>` | app or profile, dependencies first; online apps untouched unless `reload`. Dependencies declared with `condition: ready` or `completed` are waited for (with their timeout), and a dependent whose dependency failed or timed out is skipped with the reason. When the host cannot hold the stand yet the answer is `queued #N` and a watcher starts it in FIFO order |
| `leases`, `lease_cancel <id>` | the host's lease queue (who runs, who waits and why, estimates, the watcher); cancel a pending lease |
| `exec [--memory] -- <command>` | a one-off command from the project root with `exec.env`, under a memory lease when `--memory` is given; destructive, local host only |
| `worktree add <branch>`, `worktree ls`, `worktree remove <ref>` | an isolated checkout with its own slot, slug and ports; every checkout with its slot and apps online; remove one and free its slot |
| `restart`, `stop`, `delete <target>` | by app or profile |
| `flush [app]` | truncate pm2 log files; incidents start over from there |
| `unpack` | bring pm2 (assembled with npm from the lockfile mcproc ships), and Node when the host has none ≥ 18, into `<cwd>/.mcproc/runtime` on that host |

Every tool takes `project` and `host` (see *Apps on several hosts*: without `host`, each app is reached
where it runs). Read-only tools are annotated as such; mutating tools refuse `readonly` hosts and
unknown app names before touching any host.

## `mcproc monit`

A terminal dashboard on the same data: a table of apps with real memory and CPU (summed over each
app's process tree, which is what `bun run dev` or `next dev` hide behind their launcher), the ports
with ✓/✗, the runtime command, a live log tail with history, and the selected app's details.
`j`/`k` (or Tab) select an app, `↑`/`↓`, PageUp/PageDown and the mouse wheel scroll the log pane (End
returns to the tail), `r`/`s`/`x` restart/start/stop, `c` twice clears the logs of the running apps in view
(the log pane title then shows `cleared HH:MM`, and `incidents` starts over there), `R` twice reloads every app in view
the way `mcproc start all --reload` does (in dependency order with their `depends_on` waits: running apps restart,
stopped ones start, and `kind: task` apps run again; a view with an app on a readonly host is refused whole, so narrow
it with `h`), `o`/`e`/`b` switch the log stream, `f` switches to the
flat view (every app's logs merged into one labeled stream, `app | line`, `app ! line` for stderr, one
color per app, like `mcproc logs -f`; `f` again returns), `i` opens the incidents of the apps in view (errors, crashes
and restarts with their context, as the `incidents` tool shows them: the last 15 minutes, or since the last clear, then
new ones as they happen; `i` again goes back), `h` cycles hosts, `q` quits. The incidents screen is for you: it reads
from its own position and never takes anything, so the agent's next `incidents` call returns exactly what it would have. With host-bound
apps the screen opens on every app at its own host, with a HOST column, and reads each app's logs where
it runs. `h` then cycles from `all` to each host, narrowing the screen the way `--host` narrows a command. Long log lines
wrap with indented continuations. `mcproc monit --once` prints one frame as text, which is what an
agent or a script reads.

Memory is the sum of each process's resident set, so shared pages count once per process; pm2's own
root-pid figure is shown next to it in the details. CPU is per core over the refresh interval.

### Live logs

`monit` and `logs -f` show a line moments after the app writes it. On this machine mcproc reads the
pm2 log files itself and the system tells it when they change, so no command runs per read. On a host
reached over ssh or docker, one connection stays open while you watch: a small `sh` loop there checks
the followed files four times a second and sends only what was added. If that connection drops, mcproc
reconnects and meanwhile reads on its own clock (monit every 2 s, `logs -f` every second).

pm2 stamps every line to the millisecond (`2026-10-12T21:00:00.123: …`). The flat view orders the lines
of one host by that stamp, then by arrival; with apps on several hosts, whose clocks may differ, by
arrival. Apps started before mcproc 0.3.2 keep second stamps until their next restart.

## Colors

`mcproc logs` and `monit` show the colors your apps write, as on their own terminal. `logs` prints them only
to a terminal: `--color` (or `FORCE_COLOR`) forces them into a pipe, `--no-color` or `NO_COLOR` turns them
off. `--json`, the MCP `logs` tool and `monit --once` always give plain text. Other escapes an app writes
(cursor moves, window titles) are dropped.

Many tools stop coloring when their output is not a terminal, and under pm2 it never is. Give such an app
`FORCE_COLOR: 1` in its `env`. mcproc never sets it on its own, because it puts color codes into that app's
pm2 log files:

```yaml
apps:
  web:
    description: Next.js dev server
    run: npm run dev
    env: { FORCE_COLOR: 1 }
```

## New errors at a glance: `incidents`

`incidents` (MCP tool, and `mcproc incidents` on the CLI) returns only the errors that are new since they were last
taken, each with lines of context before and after, a stack trace folded in, plus crashes and restarts pm2 saw. Nothing
new is one short line, so an agent can poll it during long work with whatever its client offers (a loop, a cron, a
monitor), and read `logs` only for an incident worth a closer look. `mcproc incidents -f` keeps watching in a terminal.

A call takes what it returns: the pick-up point, kept in `.mcproc/incidents.json`, moves past those incidents for every
session, agent and CLI call on this machine, so nobody gets the same incident twice. `peek` (`--peek`) looks without
taking. A first call looks back 15 minutes (`since`). One poll reads at most 1 MB of new log per file (the most recent
part) and says how much it skipped.

Clearing logs starts it over: `flush`, or `c` twice in `mcproc monit` (the logs of the running apps in view), empties
the log files and records when; nothing logged before the clear comes up again, and monit shows `cleared HH:MM` in the
log pane title.

What counts as an error: `level=error|fatal`, JSON `"level":"error"` or 50/60, `ERROR`/`FATAL` as a word, `SomeError:` /
`…Exception`, `Traceback`, `panic:`, `Unhandled…`, and Node's `E…` codes such as `EADDRINUSE`. A lowercase "error" in
a sentence does not count, and neither does a line merely being on stderr. Per app:

```yaml
apps:
  api:
    errors:
      match: ['Request failed with status 5\d\d']   # more patterns (JavaScript regular expressions)
      ignore: ['ECONNRESET.*healthcheck']            # never an incident
      context: [3, 5]                                 # lines before and after
      stderr: true                                    # every stderr line counts (default false)
```

`errors: false` turns it off for an app. Patterns are matched against the first 2000 characters of each line; a pattern
that repeats a repeat, like `(a+)+` or `(\w+\s*)*`, is refused when the manifest loads, because on a line that almost
matches it could run for minutes. Patterns that still take longer than 2 seconds on an app's log are stopped: that app
reports an error and keeps its place until they are fixed, the other apps are not held up.

## URLs

An app may declare `url`, the address you open in a browser; `init` drafts `http://localhost:<port>`
for every server it finds a port for. `ls`, `describe`, `monit --once`, `wait until: url-ok` and a `ready`
dependency on a url all check it the same way and report `ok` (2xx/3xx), `error` (4xx/5xx: up but refusing),
`down` (nothing answered) or `unchecked` (not requested, or `url_check: host` on a host with neither curl nor
wget). It is a liveness check, not a trust check: self-signed development certificates are accepted, and a
redirect is an answer (it is not followed, except by `wget` on a host without curl).
The interactive `monit` shows the URL but never requests it, so your dev servers' request logs stay yours.

Where it is requested from is set per app with `url_check`:

- `auto` (the default): on the app's host first (`curl`, or `wget` when there is no curl). An HTTP answer
  there is the result. When the host gets none, mcproc requests the url from this machine, where mcproc
  and usually your browser run, so a dev container whose name for the site points at itself, or whose
  `localhost` is not where the port is published, still reads `✓ 200 (here)`. When neither answers it is `down`.
- `host`: only on the app's host.
- `here`: only from this machine. `ls`, `wait` and `ready` never request it on the host; `doctor` may, to show
  where it answers.

On the `local` host this machine is the host: the url is requested once, whatever `url_check` says. A url the
host answers costs one request, on the host; the second request is made only for a url the host could not reach.
On the host each url's name lookup is bounded at 2 s, its request at 2 s (3 s with `wget`), and the host's
environment lookups at about 4 s (where it has `timeout`), so a host whose resolver drops packets makes `ls` and
each poll of `wait until: url-ok` that much slower. The probe's time budget grows with the number of urls it checks
to match (30 s, plus 4 s and 5 s per url), up to 120 s.

One catch of `auto`: a `localhost` (or loopback-address) url of an app on a remote host can read `✓ 200 (here)`
when this machine happens to serve the same port, even while that app is down. `wait` and a `ready` dependency
still require the app's process to be online; `url_check: host` rules the catch out.

`ls` marks an answer from this machine with `(here)`, and a `down` url with the short reason of the last place
tried: `refused`, `not resolved`, `timeout`, `tls`, `reset` or `no answer`. The JSON rows carry `url_from` (`host`,
`here`, or null when unchecked) and `url_reason` (why it is down, with both sides when neither answered, as in
`on box: refused; here: refused`, or why it was taken from this machine), which `describe` prints too.

When the url's name resolves on the host to the host itself (for instance through a hostname line in its
`/etc/hosts`), that is the reason only when the url answered from this machine:
`on box site.test resolves to 127.0.1.1, the host itself`, the dev container whose name for the site means another
machine. Otherwise the host's own failure stays the reason and the address follows as a note, so a box whose own
name resolves to itself and whose app is down reads `✗ down (refused)`, with the `url_reason`
`on box: refused (devbox resolves to 127.0.1.1, the host itself)`.

`doctor` shows each host's environment (container or not, hostname) and where each of its apps' urls answers, and
suggests `url_check: auto` for an app with `url_check: host` whose url answers only from here.

```yaml
apps:
  web:
    description: dev server in the container
    run: yarn dev
    port: 3000
    url: https://site.test/
    url_check: here   # checked only from this machine: ls, wait and ready never request it in the container
    host: box
```

## Process names

In pm2 the processes are named `<project>-<app>` (`demo-api`, `demo-api-build`) and grouped in the
`<project>` namespace; mcproc itself always takes and shows the short app name. The prefix is not
cosmetic: pm2 matches processes by name only, ignoring namespaces, so with bare names a second
project's `api` would restart the first project's `api` with its own settings. For the same reason
`start` and `restart` refuse with `NAME_COLLISION` when the name already belongs to another namespace
or to another checkout that declares the same `project`; give that checkout its own `project:`.

## How ports are found

`ls` runs one command on the host: `pm2 jlist`, `ps -eo pid,ppid` and `ss -ltnp` / `ss -lunp`
(falling back to `/proc/net/tcp` and `/proc/*/fd` when `ss` is missing or fails). pm2's pid plus its
descendants are matched to listening sockets, then compared with the declared ports:
`listening`, `declared-not-listening` (naming the process that holds the port, if any), `undeclared`.
Ports of processes owned by other users show without a pid, as the kernel reports them.
Ports published by Docker containers show the container name instead of a pid.

## What a host needs

`ps`, `ss` (or `/proc`) and `tar`. Following logs live uses only POSIX tools there (`sh`, `stat` or `wc`,
`tail`, `head`, `od`). pm2 comes from the host's login-shell PATH (Node 18 or newer)
or from `unpack`. mcproc itself is only installed where the agent runs; locally it ships its own
pm2. `doctor` tells you which pm2 a host would use and why, or why none is usable.
`curl` or `wget` for URL checks on the host (optional: without them a url is checked from this machine under `url_check: auto`, and reads `unchecked` under `url_check: host`), and `getent` to report where a url's name resolves there.

## Hosts without pm2: `unpack`

`unpack` makes a host self-sufficient without installing anything system-wide. mcproc does not
contain pm2 (pm2 is AGPL-3.0, mcproc is MIT): it ships pm2's lockfile and assembles the tree once on
your machine with `npm ci` (needs `npm`, `tar` and access to the npm registry the first time; cached
in `~/.cache/mcproc/pm2` afterwards), then copies it into `<cwd>/.mcproc/runtime` on that host (or
`--dir`, which must be a directory of its own: a `bin/` mcproc did not write is refused). When the
host has no Node 18 or newer it also brings an official Node build: downloaded once on your machine
from nodejs.org, checked against the release's `SHASUMS256.txt`, cached in `~/.cache/mcproc/node`,
then streamed to the host, which needs no internet access. It copies the manifest there too, but never
over a hand-written one unless `--force`. Running it again changes nothing while the versions match
(an unpacked Node stays at its version until you pass `--node-version` or `--force`); a newer pm2 or
Node lands next to the old one, and for a daemon that is already running mcproc prints the
`bin/pm2 update` command instead of running it.

```bash
mcproc unpack --host stand                    # pm2 only, when the host has Node >= 18
mcproc unpack --host box --with-node always   # bare images such as alpine
mcproc unpack --host stand --dir /opt/mcproc/runtime   # then add hosts.stand.runtime: /opt/mcproc/runtime
```
Hosts without bash (alpine, busybox) need `shell: /bin/sh -c` in their `hosts:` entry. The official
Node builds are linked against the C++ runtime library, so a bare alpine needs `apk add libstdc++`
first (glibc distributions already have it); `unpack` checks this before downloading anything.

## License

MIT
