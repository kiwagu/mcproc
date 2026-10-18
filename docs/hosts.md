# Hosts

Apps run on the local machine by default. A host declared under `hosts:` is reached over ssh, `docker exec`, or both; the manifest is read where mcproc runs, and each app is driven where it is bound.

## Apps on several hosts

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

## What a host needs

`ps`, `ss` (or `/proc`) and `tar`. Following logs live uses only POSIX tools there (`sh`, `stat` or `wc`,
`tail`, `head`, `od`). pm2 comes from the host's login-shell PATH (Node 18 or newer)
or from `unpack`. mcproc itself is only installed where the agent runs; locally it ships its own
pm2. `doctor` tells you which pm2 a host would use and why, or why none is usable.
`curl` or `wget` for URL checks on the host (optional: without them a url is checked from this machine under `url_check: auto`, and reads `unchecked` under `url_check: host`), and `getent` to report where a url's name resolves there.

## How ports are found

`ls` runs one command on the host: `pm2 jlist`, `ps -eo pid,ppid` and `ss -ltnp` / `ss -lunp`
(falling back to `/proc/net/tcp` and `/proc/*/fd` when `ss` is missing or fails). pm2's pid plus its
descendants are matched to listening sockets, then compared with the declared ports:
`listening`, `declared-not-listening` (naming the process that holds the port, if any), `undeclared`.
Ports of processes owned by other users show without a pid, as the kernel reports them.
Ports published by Docker containers show the container name instead of a pid.

## Hosts without pm2: `unpack`

`unpack` makes a host self-sufficient without installing anything system-wide. mcproc does not
contain pm2: it ships pm2's lockfile and assembles the tree once on
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
