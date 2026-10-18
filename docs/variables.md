# Variables and the per-checkout override

Ports, container names and paths that differ per checkout are variables, declared once under `vars:` with a default:

```yaml
vars:
  slot: 0                      # the main checkout; a worktree gets its own (see [worktrees](worktrees.md))
  web_port: '{{ 5181 + slot * 100 }}'   # a default may use the vars before it
apps:
  web:
    description: dev server
    run: npm run dev -- --port {{ web_port }}
    port: '{{ web_port }}'     # port and ports are templates only as quoted strings
  db:
    description: postgres for the stand
    run: docker run --rm --name {{ project }}-db -p {{ 5432 + slot }}:5432 postgres
    containers: [ '{{ project }}-db' ]
```

- `{{ expr }}` takes names, integers, `+ - * / %` and parentheses; division truncates. `\{{` writes a literal `{{`,
  which a docker `--format '{{.Names}}'` in a `run` line needs. Any other `{{` in a string under `apps`, `hosts`, `worktree` or `exec` is
  refused when the manifest loads (`BAD_TEMPLATE`, naming the field: `apps.ps.run: unexpected "." in ".Names"`). The syntax is `{{ }}` because bash, Caddy and compose own
  the other ones.
- The built-ins are `project` (the pm2 namespace of this checkout) and `root` (its project root).
- Templates work in every string field under `apps`, `hosts`, `worktree` and `exec.env`. They do not work in `project`, in
  the names of apps, profiles and hosts, or in the `vars` names.
- `.mcproc/mcproc.local.yaml` is the checkout's own override (it lives in the gitignored folder). It holds `project` (the
  slug this checkout runs under), `repo` (the main checkout, for a worktree) and `vars` (values that win over the
  defaults). A var the manifest does not declare is refused.
- `describe` without an app prints the resolved vars, where each value came from, and the override's path.

The slot idiom: the manifest says `slot: 0` and writes ports as `'{{ 5181 + slot * 100 }}'` and containers as
`{{ project }}-db`. The main checkout keeps 5181 and `demo-db`; a worktree at slot 2 gets 5381 and `demo-w2-db`.
