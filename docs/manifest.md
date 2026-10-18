# The manifest

`.mcproc/mcproc.yaml` describes every launch of a project: what each app is, how it starts, where it runs and what it listens on. `init` drafts it ([init](init.md)); everything else reads it.

```yaml
version: 1
project: demo                  # pm2 namespace and process-name prefix; default: directory name
vars:                          # per-checkout values, see [variables](variables.md)
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
    memory: 600M               # expected memory, see [memory](memory.md)
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
Other app fields: `host` ([hosts](hosts.md)), `url_check` ([urls](urls.md)), `watch_delay`, `ignore_watch`, `autorestart`, `pm2:` (raw pm2 fields merged last).
Other host fields: `ssh_args`, `shell` (default `/bin/bash -lc`), `pm2` (binary or command), `pm2_home`,
`runtime`, `env` (merged into every app on that host). Names match `^[a-z0-9][a-z0-9._-]*$`.

The folder is created with a `.gitignore` containing `*`: it never enters your repository, so each
checkout keeps its own. `.mcproc/README.md` holds free-form notes that `describe` returns.

## Kinds

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

## Process names

In pm2 the processes are named `<project>-<app>` (`demo-api`, `demo-api-build`) and grouped in the
`<project>` namespace; mcproc itself always takes and shows the short app name. The prefix is not
cosmetic: pm2 matches processes by name only, ignoring namespaces, so with bare names a second
project's `api` would restart the first project's `api` with its own settings. For the same reason
`start` and `restart` refuse with `NAME_COLLISION` when the name already belongs to another namespace
or to another checkout that declares the same `project`; give that checkout its own `project:`.
