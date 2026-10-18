# `mcproc monit`

A terminal dashboard on the same data as `ls` and `logs`: a table of apps with real memory and CPU (summed over each
app's process tree, which is what `bun run dev` or `next dev` hide behind their launcher), the ports with ✓/✗, the
runtime command, a live log tail with history, and the selected app's details. `mcproc monit --once` prints one frame
as text, which is what an agent or a script reads.

## Keys

| key | what it does |
|---|---|
| `j` / `k`, Tab | select an app |
| `↑` / `↓`, PageUp / PageDown, the mouse wheel | scroll the log pane; End returns to the tail |
| `o` / `e` / `b` | show stdout, stderr or both |
| `r` / `s` / `x` | restart, start or stop the selected app |
| `c` twice | clear the logs of the running apps in view; the pane title then shows `cleared HH:MM`, and `incidents` starts over there |
| `R` twice | reload every app in view the way `mcproc start all --reload` does: in dependency order with their `depends_on` waits, running apps restart, stopped ones start, `kind: task` apps run again. A view with an app on a readonly host is refused whole; narrow it with `h` |
| `f` | the flat view: every app's logs merged into one labeled stream, `app \| line` and `app ! line` for stderr, one color per app, like `mcproc logs -f`; `f` again returns |
| `i` | the incidents of the apps in view: errors, crashes and restarts with their context, as the `incidents` tool shows them, from the last 15 minutes or the last clear, then new ones as they happen; `i` again returns |
| `h` | cycle hosts, from `all` to each host, narrowing the screen the way `--host` narrows a command |
| `q` | quit |

The incidents screen is for you: it reads from its own position and never takes anything, so the agent's next
`incidents` call returns exactly what it would have ([incidents](incidents.md)).

## Several hosts

With host-bound apps the screen opens on every app at its own host, with a HOST column, and reads each app's logs
where it runs. A host that does not answer keeps its last known rows, and the footer names it ([hosts](hosts.md)).

## What the screen shows

Memory is the sum of each process's resident set, so shared pages count once per process; pm2's own root-pid figure
is shown next to it in the details. CPU is per core over the refresh interval. Long log lines wrap with indented
continuations. The selected app's detail line counts its in-process reloads since its pm2 start
([reloads](reloads.md)). The screen shows an app's URL but never requests it, so your dev servers' request logs
stay yours ([urls](urls.md)). How lines reach the screen: [live logs](logs.md#live-logs).
