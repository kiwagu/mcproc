# `init`: drafting the manifest

`mcproc init` writes `.mcproc/` with a manifest draft read from `package.json` scripts and workspaces, nx `project.json`, `turbo.json`, `ecosystem.json` and a `Procfile`. Every candidate comes with a `# source:` trailer saying where it was found. On a plain repository every candidate is commented out; a turbo repository with a persistent `dev` task gets its dev stack live.

## Turbo monorepos

On a turbo repo whose `turbo.json` has a persistent `dev` task, `init` drafts the dev stack live: each workspace package
with a `dev` script becomes an uncommented app named after the package, and together they form the `dev` profile, so
`start dev` runs them. Their placeholder description, `TODO: what this app does`, lets the manifest load as is until you
replace it. The root `dev` script, other persistent tasks (under a commented profile) and every other script stay commented.

- Libraries consumed from `dist/` (a `build` script plus `main`, `module`, `types` or an `exports` target under `dist/`)
  share two apps instead of a `<pkg>-build` each: `libs`, one `turbo run build` over them (`kind: task`), and `libs-watch`,
  `turbo watch build` once `libs` has completed (turbo 1 has no `turbo watch`, so there `libs` comes alone). A live app
  that depends on such a library, directly or through other packages, gets
  `depends_on: [{ app: libs, condition: completed, timeout: 600 }]`: the longest wait the manifest allows, since a cold
  build of many libraries can outlast the default 60 s.
- A library live through its own `dev` watch is drafted as a `build` app and left out of `libs`, so its first build is not
  awaited: the draft leaves a note on each app that uses it saying how to wait for it.
- Ports are also guessed for Next (3000), Vite (`server.port` in `vite.config.*`, or `preview.port` for `vite preview`,
  as a literal or an env read's fallback, `process.env` or loadEnv's `env`, directly or through a constant of the config;
  5173 or 4173 when the section sets no port, no guess when it sets one `init` cannot read) and, in `src/`, `PORT = N`,
  `DEFAULT_PORT = N`, `PORT ?? N`, `PORT || N` or `.listen(N)`. The guess shows as `port?` in each candidate's
  `# source:` trailer; a live app also declares it as `port:` (and `url:`), so check it with `ls` (a wrong guess shows
  ✗) and correct it by hand: `--adopt-ports` adds the real port but leaves the guess in place.
- `init --adopt-ports` (MCP: `adopt_ports`) drafts nothing and ignores `--force`: it needs an existing manifest and writes
  the ports `ls` reports as undeclared for the running apps into it, comments and layout kept, then prints the diff. Ports
  from 32768 up (the ephemeral range, almost always transient) and ports another app declares are reported, not adopted.
  It refuses a manifest that marks the local host readonly, and a file that changed while the hosts were probed
  (`ALREADY_EXISTS`: run it again).
