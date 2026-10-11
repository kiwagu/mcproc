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
Other app fields: `watch_delay`, `ignore_watch`, `autorestart`, `pm2:` (raw pm2 fields merged last).
Other host fields: `ssh_args`, `shell` (default `/bin/bash -lc`), `pm2` (binary or command), `pm2_home`,
`runtime`, `env` (merged into every app on that host). Names match `^[a-z0-9][a-z0-9._-]*$`.

The folder is created with a `.gitignore` containing `*`: it never enters your repository, so each
checkout keeps its own. `.mcproc/README.md` holds free-form notes that `describe` returns.

## Tools (MCP) and commands (CLI)

| tool | what it does |
|------|--------------|
| `describe [app]` | project summary with descriptions, profiles, hosts and the notes file; or one app in detail |
| `ls [app]` | one row per app: pm2 status, pid, uptime, restarts, memory, ports with `✓`/`✗` against the declared ones |
| `ports [port]` | every listening socket on the host with its pid and owning app, or who holds one port |
| `logs <app>` | tail of the pm2 out/err logs, ANSI stripped (`lines`, `stream`) |
| `hosts`, `doctor` | hosts from the manifest; per-host readiness (reachable, Node, which pm2 and why, ps/ss/tar, daemon) |
| `init` | manifest draft from package.json scripts, workspaces, nx `project.json`, `turbo.json`, `ecosystem.json`, `Procfile` |
| `start <target>` | app or profile, dependencies first; online apps untouched unless `reload` |
| `restart`, `stop`, `delete <target>` | by app or profile |
| `flush [app]` | truncate pm2 log files |

Every tool takes `project` and `host`. Read-only tools are annotated as such; mutating tools refuse
`readonly` hosts and unknown app names before touching the host.

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

## What a host needs

`ps`, `ss` (or `/proc`), and pm2 on the login-shell PATH running on Node 18 or newer.
mcproc itself is only installed where the agent runs; locally it ships its own pm2.
`doctor` tells you which pm2 a host would use and why, or why none is usable.

## License

MIT
