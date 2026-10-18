# Reloads

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

`reloads: false` turns it off for an app. Own patterns follow the rules of `errors` patterns ([incidents](incidents.md)): matched against the first
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
