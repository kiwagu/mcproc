# Logs

`logs` reads pm2's log files: one app's tail, several apps merged by time, or a live follow. pm2 stamps every line to the millisecond (`2026-10-12T21:00:00.123: …`).

## Since a point in time

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

## Live logs

`monit` and `logs -f` show a line moments after the app writes it. On this machine mcproc reads the
pm2 log files itself and the system tells it when they change, so no command runs per read. On a host
reached over ssh or docker, one connection stays open while you watch: a small `sh` loop there checks
the followed files four times a second and sends only what was added. If that connection drops, mcproc
reconnects and meanwhile reads on its own clock (monit every 2 s, `logs -f` every second).

The flat view of `monit` orders the lines of one host by their stamps, then by arrival; with apps on several
hosts, whose clocks may differ, by arrival.

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
