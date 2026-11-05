# Memory: budgets and the lease queue

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

## Exec: one-off work under a lease

```bash
mcproc exec --memory 4G --note "e2e run" -- npx vitest run     # --timeout <s> bounds the wait in the queue (default 600, max 3600)
```

`exec` runs a command from the project root with the manifest's `exec.env` (templates allowed, so it can point at this
checkout's ports) and `MCPROC_PROJECT` set. With `--memory` it is a lease like a start: it runs at once when the host has
room, else waits its turn, and frees the lease when the command exits. Without it, it runs at once. The MCP tool returns
the exit code and the last 200 lines of output, and is marked destructive: it runs any local argv. It reads that output
through pipes: a process the command leaves behind on them (a server sent to the background) loses them one second after
the command exits (its next write gets EPIPE), so such a process should detach its own stdio.

## Limits

- Leases are local: `exec` and the worktree commands run on this machine only (a `host` other than `local` is refused), and a `start` of an app bound to a remote host that
  declares `memory:` is refused (`LEASE_UNSUPPORTED_HOST`). That makes monit's `R` key (`start all --reload`) refuse such
  a manifest.
- Without `/proc/meminfo` (not Linux) there is no memory reading, so nothing is checked.
