# Readiness: `wait` and `depends_on` conditions

`wait` (MCP tool, `mcproc wait <app> --until <cond> [-t 60]` on the CLI) blocks until an app is usable or finished,
instead of sleeping and polling:

| `until` | met when |
|---|---|
| `listening` | every declared port is bound (needs `port`/`ports`) |
| `url-ok` | the `url` answers 2xx/3xx, checked as `ls` checks it (on the host, and from this machine when the host gets no answer; see [urls](urls.md)) |
| `exited` | the process left `online`; with autorestart off the answer carries `exit_code` and `done` / `failed (exit N)` / `stopped`, otherwise pm2's `stopped` or `errored` |
| `log:<regex>` | a new line of its out or err log matches (ANSI stripped, matched against the line without pm2's time stamp; the answer keeps the stamp; history is not searched) |
| `idle:<seconds>` | no log output for that long: a watcher settled |
| `reloaded` | the app's next in-process reload (see [reloads](reloads.md)) has been quiet for 2 s; the answer carries its time, its line count and its first restart or rebuild line, else its first line |

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
url otherwise). `start` launches dependencies first and waits at each such edge, on the dependency's
host, also when the dependent runs elsewhere. A done task is run again, a running one is waited on. When a dependency
fails, times out or dies, the dependent is not started: its row reads `skipped` with the reason, and so do the apps
that depend on it; unrelated apps still start. The answer adds `waited 4.2 s for libs (completed)` for each wait that was met (a failed
wait shows in the rows), `start`'s JSON carries the waits as `waits[]`, and the CLI exits 1 when anything was skipped. With `--host X`, dependencies that run elsewhere are neither started nor waited for.
`restart` does not order apps by their dependencies or wait for conditions; `start` does, and `start --reload`
restarts the apps that are already online the same way.
