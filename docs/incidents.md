# New errors at a glance: `incidents`

`incidents` (MCP tool, and `mcproc incidents` on the CLI) returns only the errors that are new since they were last
taken, each with lines of context before and after, a stack trace folded in, plus crashes and restarts pm2 saw. Nothing
new is one short line, so an agent can poll it during long work with whatever its client offers (a loop, a cron, a
monitor), and read `logs` only for an incident worth a closer look. `mcproc incidents -f` keeps watching in a terminal.

A call takes what it returns: the pick-up point, kept in `.mcproc/incidents.json`, moves past those incidents for every
session, agent and CLI call on this machine, so nobody gets the same incident twice. `peek` (`--peek`) looks without
taking. An agent takes once it has dealt with what it was shown: the incidents screen in `mcproc monit` then shows those
incidents muted ([monit](monit.md)). A first call looks back 15 minutes (`since`). One poll reads at most 1 MB of new log
per file (the most recent part) and says how much it skipped.

An answer carries about 20,000 characters of incidents, newest first. The older ones past that are counted in `more`
and, on a take, taken with the rest; `logs` shows them. An incident's own line keeps up to 2000 characters, its context
lines and stack frames up to 300.

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
