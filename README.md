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
mcproc init          # writes .mcproc/ (gitignored) with a manifest DRAFT discovered from your scripts
$EDITOR .mcproc/mcproc.yaml   # uncomment the apps you need, write a description for each
mcproc start base    # or an app name, or "all"
mcproc ls            # status, pid, uptime and real vs declared ports
mcproc logs api -n 200
mcproc doctor        # why a host cannot be driven, and what to do
```

## The manifest: `.mcproc/mcproc.yaml`

```yaml
version: 1
project: demo                  # pm2 namespace and process-name prefix; default: directory name
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
Other app fields: `host` (see below), `watch_delay`, `ignore_watch`, `autorestart`, `pm2:` (raw pm2 fields merged last).
Other host fields: `ssh_args`, `shell` (default `/bin/bash -lc`), `pm2` (binary or command), `pm2_home`,
`runtime`, `env` (merged into every app on that host). Names match `^[a-z0-9][a-z0-9._-]*$`.

### Kinds

| kind | what it is | autorestart | `ls` shows after it exits |
|---|---|---|---|
| `server` | a process that listens (default) | on | `stopped`, `errored` |
| `worker` | a process without a port | on | `stopped`, `errored` |
| `build` | a long-running watch build | on | `stopped`, `errored` |
| `task` | runs once: a build, a migration, a seed | off | `done`, `failed (exit N)`, `stopped` |

A task's exit code is pm2's `exit_code`: 0 is `done`, any other code `failed (exit N)`. A manual stop reads
`stopped`: mcproc puts `trap 'exit 130' INT; trap 'exit 143' TERM;` in front of a one-shot app's command, because
pm2 itself records exit code 0 for a process killed by a signal. Two edges: a `run` that starts with `exec …`
replaces the shell and loses the trap, so a manual stop of it reads `done`; a task that ignores SIGINT until pm2's
kill timeout (SIGKILL) also reads `done`. The host shell must be POSIX (`bash`, `sh`): the default and the
documented `/bin/sh -c` both are. pm2 keeps no exit time, so UPTIME stays `-`. `start` on a done or failed task runs
it again; `autorestart: true` on a task is refused. `init` drafts `build`, `migrate`, `seed` and `once` scripts as
tasks and watch-style commands as `build`.

The folder is created with a `.gitignore` containing `*`: it never enters your repository, so each
checkout keeps its own. `.mcproc/README.md` holds free-form notes that `describe` returns.

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

## Readiness: `wait` and `depends_on` conditions

`wait` (MCP tool, `mcproc wait <app> --until <cond> [-t 60]` on the CLI) blocks until an app is usable or finished,
instead of sleeping and polling:

| `until` | met when |
|---|---|
| `listening` | every declared port is bound (needs `port`/`ports`) |
| `url-ok` | the `url` answers 2xx/3xx (requested from the host, as `ls` does; needs `curl` or `wget` there, without either it runs to the timeout and reports `unchecked`) |
| `exited` | the process left `online`; the answer carries `exit_code` and `done` / `failed (exit N)` / `stopped` |
| `log:<regex>` | a new line of its out or err log matches (ANSI stripped; history is not searched) |
| `idle:<seconds>` | no log output for that long — a watcher settled |

`log:` and `idle:` see only output written after the call begins; for "is it up" prefer `listening` or `url-ok`.
`wait --until exited` succeeds (exit code 0) once the process has exited, whatever its exit code; scripts read
`exit_code` in `--json` or the `(exit N)` in the line.

The answer is one line: `web: listening after 1.3 s (:3000 ✓)`, `libs: done after 12.4 s (exit 0)`. On timeout
(default 60 s, max 600) or when the process dies meanwhile it says what was last seen (`web: listening not reached
after 60.0 s (status online, :3000 ✗ nothing listens)`) and `ok` is false; it is a result, not an error, and the CLI
exits 1. Local apps are checked twice a second, remote ones once; `log:`/`idle:` read the log as it grows. Claude
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
url otherwise). `start` launches dependencies first, as before, and waits at each such edge — on the dependency's
host, also when the dependent runs elsewhere. A done task is run again, a running one is waited on. When a dependency
fails, times out or dies, the dependent is not started: its row reads `skipped` with the reason, and so do the apps
that depend on it; unrelated apps still start. The answer adds `waited 4.2 s for libs (completed)` and the CLI exits 1
when anything was skipped. With `--host X`, dependencies that run elsewhere are neither started nor waited for.

## Tools (MCP) and commands (CLI)

| tool | what it does |
|------|--------------|
| `describe [app]` | project summary with descriptions, URL, profiles, hosts and the notes file; or one app in detail |
| `ls [app]` | one row per app, each from the host it runs on: pm2 status, pid, uptime, restarts, memory and CPU of the whole process tree, ports with `✓`/`✗` against the declared ones, the URL with its HTTP answer, the real runtime command |
| `ports [port]` | every listening socket on the host with its pid and owning app, or who holds one port |
| `logs <app>` | tail of the pm2 out/err logs on the app's host, ANSI stripped (`lines`, `stream`) |
| `incidents [app]` | new errors with context since they were last taken, plus crashes and restarts (cheap to poll; `peek` looks without taking) |
| `wait <app> until=…` | block until listening / url-ok / exited / a log line matches / idle, with a timeout; ok false with what was last seen |
| `hosts`, `doctor` | hosts from the manifest with the apps bound to each; per-host readiness (reachable, Node, which pm2 and why, ps/ss/tar, daemon) |
| `init` | manifest draft from package.json scripts, workspaces, nx `project.json`, `turbo.json`, `ecosystem.json`, `Procfile` |
| `start <target>` | app or profile, dependencies first; online apps untouched unless `reload`. Dependencies declared with `condition: ready` or `completed` are waited for (with their timeout), and a dependent whose dependency failed or timed out is skipped with the reason |
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
(the log pane title then shows `cleared HH:MM`, and `incidents` starts over there), `o`/`e`/`b` switch the log stream, `f` switches to the
flat view (every app's logs merged into one labeled stream, `app | line`, `app ! line` for stderr, one
color per app, like `mcproc logs -f`; `f` again returns), `h` cycles hosts, `q` quits. With host-bound
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
for every server it finds a port for. `ls`, `describe` and `monit --once` request it from the host
(`curl`, or `wget` when there is no curl, which only tells answered from not) and report `ok` (2xx/3xx),
`error` (4xx/5xx: up but refusing), `down` (nothing answered) or `unchecked` (the host has neither tool).
It is a liveness check, not a trust check: self-signed development certificates are accepted.
The interactive `monit` shows the URL but never requests it, so your dev servers' request logs stay yours.
The request is made on the host, so on a remote host declare an address the host can reach itself.

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
`curl` or `wget` for URL checks (optional: without them `ls` reports `unchecked`).

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
