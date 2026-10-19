# `mcproc monit`

A terminal dashboard on the same data as `ls` and `logs`: a table of apps with real memory and CPU (summed over each
app's process tree, which is what `bun run dev` or `next dev` hide behind their launcher), the ports with ✓/✗, the
runtime command, a live log tail with history, and the selected app's details. `mcproc monit --once` prints one frame
as text, which is what an agent or a script reads.

## Keys

| key | what it does |
|---|---|
| `j` / `k`, Tab | select an app (off in the incidents view) |
| `↑` / `↓`, PageUp / PageDown, the mouse wheel | scroll the log pane; End returns to the tail |
| `o` / `e` / `b` | show stdout, stderr or both |
| `r` / `s` / `x` | restart, start or stop the selected app (dashboard only) |
| `c` twice | clear the logs of the running apps in view; the pane title then shows `cleared HH:MM`, and `incidents` starts over there |
| `R` twice | reload every app in view the way `mcproc start all --reload` does: in dependency order with their `depends_on` waits, running apps restart, stopped ones start, `kind: task` apps run again. A view with an app on a readonly host is refused whole; narrow it with `h` |
| `f` | the flat view: every app's logs merged into one labeled stream, `app \| line` and `app ! line` for stderr, one color per app, like `mcproc logs -f`; `f` again returns |
| `i` | the incidents of the apps in view: errors, crashes and restarts with their context, as the `incidents` tool shows them, from the last 15 minutes or the last clear, then new ones as they happen; `i` again returns |
| `t` | on the incidents screen, hide or show the incidents an agent has taken |
| `h` | cycle hosts, from `all` to each host, narrowing the screen the way `--host` narrows a command |
| `q` | quit |

The incidents screen is for you: it reads from its own position and never takes anything, so the agent's next
`incidents` call returns exactly what it would have ([incidents](incidents.md)). What an agent has taken is shown in
muted colors and marked `taken`, and the title counts it. An incident counts as taken when its time stamp is at or
before the last line a take read in that file.

## Several hosts

With host-bound apps the screen opens on every app at its own host, with a HOST column, and reads each app's logs
where it runs. A host that does not answer keeps its last known rows, and the footer names it ([hosts](hosts.md)).

## What the screen shows

Memory is the sum of each process's resident set, so shared pages count once per process; pm2's own root-pid figure
is shown next to it in the details. CPU is per core over the refresh interval. Long log lines wrap with indented
continuations. The selected app's detail line counts its in-process reloads since its pm2 start
([reloads](reloads.md)). The screen shows an app's URL but never requests it, so your dev servers' request logs
stay yours ([urls](urls.md)). How lines reach the screen: [live logs](logs.md#live-logs).

## Every stack of the host

`mcproc monit` run where no manifest is found (from your home directory, say), or `mcproc monit --all` from
anywhere, opens the list of every stack on this machine. A stack is a checkout with its manifest. mcproc remembers
every checkout any of its commands has read, in its state directory (`~/.local/state/mcproc/projects`), and it also
looks at the namespaces of the local pm2 daemon, finding the checkout of an unknown one from its processes' working
directory. So a stack left running after the editor was closed is listed too. A pm2 namespace that no manifest
claims is shown at the bottom as `pm2 · <namespace>` and is read-only.

Each row shows the hosts the stack runs on, its apps online out of all, errors, the memory and CPU of its process
trees, and its listening ports. A worktree is listed under its main checkout as `w<slot> <branch>`. The lower pane
shows the selected stack's apps. The local pm2 daemons (the default one and each own `pm2_home`) are read on every
refresh; hosts reached over ssh or docker at most every 10 seconds, and a host that does not answer is marked on its
stacks and tried again after 30 seconds. Warnings about the host (an unreadable state directory, a local pm2 that
does not answer) stay in the header.

| key | does |
|---|---|
| `j` `k` `↑` `↓` | select a stack |
| `Enter` | open the stack's monit; `esc` there comes back to the list, `q` quits |
| `x` `x` | stop every app of the stack (the second `x` within 3 seconds); apps on readonly hosts are left alone |
| `a` | also list the remembered stacks with nothing running |
| `q` | quit |

`mcproc stacks` (MCP `stacks`) prints the same list; `--json` gives every field. `monit --all --once` prints one frame
of the list as text.
