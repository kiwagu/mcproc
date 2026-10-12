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
  api-build:
    description: tsc watch build of the API into dist/
    kind: build                # build | server | worker (default server)
    run: npx tsc -w -p apps/api
  api:
    description: HTTP API serving /health
    run: node dist/apps/api/main.js
    cwd: .                     # relative to the project root
    env: { PORT: 3310 }
    port: 3310                 # declared listening port (or ports: [3310, 9230])
    url: http://localhost:3310/   # optional: the address to open; ls/describe show it with the HTTP answer, monit shows it
    watch: [dist/apps/api]     # pm2 restarts the server when the build output changes
    depends_on: [api-build]    # start order
profiles:
  base: [api-build, api]       # "all" is built in
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

## Tools (MCP) and commands (CLI)

| tool | what it does |
|------|--------------|
| `describe [app]` | project summary with descriptions, URL, profiles, hosts and the notes file; or one app in detail |
| `ls [app]` | one row per app, each from the host it runs on: pm2 status, pid, uptime, restarts, memory and CPU of the whole process tree, ports with `✓`/`✗` against the declared ones, the URL with its HTTP answer, the real runtime command |
| `ports [port]` | every listening socket on the host with its pid and owning app, or who holds one port |
| `logs <app>` | tail of the pm2 out/err logs on the app's host, ANSI stripped (`lines`, `stream`) |
| `hosts`, `doctor` | hosts from the manifest with the apps bound to each; per-host readiness (reachable, Node, which pm2 and why, ps/ss/tar, daemon) |
| `init` | manifest draft from package.json scripts, workspaces, nx `project.json`, `turbo.json`, `ecosystem.json`, `Procfile` |
| `start <target>` | app or profile, dependencies first; online apps untouched unless `reload` |
| `restart`, `stop`, `delete <target>` | by app or profile |
| `flush [app]` | truncate pm2 log files |
| `unpack` | bring pm2 (assembled with npm from the lockfile mcproc ships), and Node when the host has none ≥ 18, into `<cwd>/.mcproc/runtime` on that host |

Every tool takes `project` and `host` (see *Apps on several hosts*: without `host`, each app is reached
where it runs). Read-only tools are annotated as such; mutating tools refuse `readonly` hosts and
unknown app names before touching any host.

## `mcproc monit`

A terminal dashboard on the same data: a table of apps with real memory and CPU (summed over each
app's process tree, which is what `bun run dev` or `next dev` hide behind their launcher), the ports
with ✓/✗, the runtime command, a live log tail with history, and the selected app's details.
`j`/`k` (or Tab) select an app, `↑`/`↓`, PageUp/PageDown and the mouse wheel scroll the log pane (End
returns to the tail), `r`/`s`/`x` restart/start/stop, `o`/`e`/`b` switch the log stream, `f` switches to the
flat view (every app's logs merged into one labeled stream, `app | line`, `app ! line` for stderr, one
color per app, like `mcproc logs -f`; `f` again returns), `h` cycles hosts, `q` quits. With host-bound
apps the screen opens on every app at its own host, with a HOST column, and reads each app's logs where
it runs. `h` then cycles from `all` to each host, narrowing the screen the way `--host` narrows a command. Long log lines
wrap with indented continuations. `mcproc monit --once` prints one frame as text, which is what an
agent or a script reads.

Memory is the sum of each process's resident set, so shared pages count once per process; pm2's own
root-pid figure is shown next to it in the details. CPU is per core over the refresh interval.

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

`ps`, `ss` (or `/proc`) and `tar`. pm2 comes from the host's login-shell PATH (Node 18 or newer)
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
