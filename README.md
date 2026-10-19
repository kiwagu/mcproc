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

## The manifest: `.mcproc/mcproc.yaml`

```yaml
version: 1
project: demo                  # pm2 namespace and process-name prefix; default: directory name
vars:                          # per-checkout values (docs/variables.md)
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
    url: http://localhost:3310/   # the address to open; ls/describe show it with the HTTP answer (docs/urls.md)
    memory: 600M               # expected memory (docs/memory.md)
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

The folder is created with a `.gitignore` containing `*`: it never enters your repository, so each
checkout keeps its own. `.mcproc/README.md` holds free-form notes that `describe` returns. The remaining
fields, the kinds and the process naming: [the manifest](docs/manifest.md).

## Tools (MCP) and commands (CLI)

| tool (CLI form when it differs) | what it does |
|------|--------------|
| `describe [app]` | the project summary (apps with descriptions, profiles, hosts, the notes file), or one app in detail |
| `ls [app]` | one row per app from the host it runs on: status, pid, uptime, restarts, memory and CPU of the process tree, ports with `✓`/`✗` against the declared ones, the URL's answer; `reloads` adds the in-process reloads since the pm2 start |
| `ports [port]` | every listening socket on the host with its pid and owning app, or who holds one port |
| `logs` | one app's tail, or several apps merged by time: the latest lines, `since` a span or a time, or `last` ([logs](docs/logs.md)) |
| `incidents [app]` | new errors with context since they were last taken, plus crashes and restarts; `peek` looks without taking ([incidents](docs/incidents.md)) |
| `wait <app>` with `until` (CLI `--until`) | block until listening, url-ok, exited, a log line matches, idle, or reloaded ([readiness](docs/readiness.md)) |
| `start`, `restart`, `stop`, `delete <target>` | by app or profile; `start` launches dependencies first and waits for their conditions, `reload` restarts the apps already online, and a stand the host cannot hold yet is `queued` ([memory](docs/memory.md)) |
| `flush [app]` | truncate the pm2 log files; incidents start over from there |
| `init` | a manifest draft from the repository's scripts and workspaces; `adopt_ports` writes the ports `ls` reports as undeclared into the existing manifest ([init](docs/init.md)) |
| `hosts`, `doctor` | the hosts and the apps bound to each; per-host readiness, which pm2 a host would use and why, where each url answers ([hosts](docs/hosts.md)) |
| `unpack` | bring pm2, and Node when the host has none, to a host ([hosts](docs/hosts.md#hosts-without-pm2-unpack)) |
| `leases`, `lease_cancel` (CLI `leases cancel <id>`) | this machine's memory lease queue; cancel a pending lease ([memory](docs/memory.md)) |
| `stacks` | every mcproc stack on this machine, not only this project: the checkouts any mcproc call has seen and those found in the local pm2, with their hosts, apps, memory and ports, plus pm2 processes no manifest knows; `all` adds the recorded ones with nothing running ([monit](docs/monit.md#every-stack-of-the-host)) |
| `exec -- <command>` | a one-off command from the project root with the manifest's `exec.env`, under a lease with `--memory` |
| `worktree_add`, `worktree_ls`, `worktree_remove` (CLI `worktree add \| ls \| remove`) | an isolated checkout per branch with its own slot, slug and ports ([worktrees](docs/worktrees.md)) |

Every tool takes `project`; the tools that act on apps take `host` too, and without it each app is reached where it
runs ([hosts](docs/hosts.md)). Leases, `exec` and worktrees are local to this machine. Read-only tools are annotated as such; mutating tools refuse `readonly` hosts and unknown app names before touching
any host. `mcproc monit` is the terminal dashboard on the same data; outside a project, or with `--all`, it lists every stack of the machine ([monit](docs/monit.md)). Text tables fit the terminal's width, wrapping long cells inside their column.

## Documentation

- [The manifest](docs/manifest.md): every field, the kinds, process names
- [`init`](docs/init.md): how the draft is made, turbo monorepos, adopting ports
- [Hosts](docs/hosts.md): apps on several hosts, what a host needs, how ports are found, `unpack`
- [Variables](docs/variables.md): per-checkout values and the override file
- [Worktrees](docs/worktrees.md): one checkout per branch, each with its own slot
- [Memory](docs/memory.md): budgets, the lease queue, `exec`
- [Readiness](docs/readiness.md): `wait` and `depends_on` conditions
- [Logs](docs/logs.md): since a point in time, live following, colors
- [Incidents](docs/incidents.md): new errors, what counts as one, per-app patterns
- [Reloads](docs/reloads.md): the in-process reloads of watchers, and where they show
- [URLs](docs/urls.md): where a url is checked from and what the answer means
- [monit](docs/monit.md): the dashboard and its keys

## License

MIT, see [LICENSE](LICENSE).
