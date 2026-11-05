# URLs

An app may declare `url`, the address you open in a browser; `init` drafts `http://localhost:<port>`
for every server it finds a port for. `ls`, `describe`, `monit --once`, `wait until: url-ok` and a `ready`
dependency on a url all check it the same way and report `ok` (2xx/3xx), `error` (4xx/5xx: up but refusing),
`down` (nothing answered) or `unchecked` (not requested, or `url_check: host` on a host with neither curl nor
wget). It is a liveness check, not a trust check: self-signed development certificates are accepted, and a
redirect is an answer (it is not followed, except by `wget` on a host without curl).
The interactive `monit` shows the URL but never requests it, so your dev servers' request logs stay yours.

Where it is requested from is set per app with `url_check`:

- `auto` (the default): on the app's host first (`curl`, or `wget` when there is no curl). An HTTP answer
  there is the result. When the host gets none, mcproc requests the url from this machine, where mcproc
  and usually your browser run, so a dev container whose name for the site points at itself, or whose
  `localhost` is not where the port is published, still reads `✓ 200 (here)`. When neither answers it is `down`.
- `host`: only on the app's host.
- `here`: only from this machine. `ls`, `wait` and `ready` never request it on the host; `doctor` may, to show
  where it answers.

On the `local` host this machine is the host: the url is requested once, whatever `url_check` says. A url the
host answers costs one request, on the host; the second request is made only for a url the host could not reach.
On the host each url's name lookup is bounded at 2 s, its request at 2 s (3 s with `wget`), and the host's
environment lookups at about 4 s (where it has `timeout`), so a host whose resolver drops packets makes `ls` and
each poll of `wait until: url-ok` that much slower. The probe's time budget grows with the number of urls it checks
to match (30 s, plus 4 s and 5 s per url), up to 120 s.

One catch of `auto`: a `localhost` (or loopback-address) url of an app on a remote host can read `✓ 200 (here)`
when this machine happens to serve the same port, even while that app is down. `wait` and a `ready` dependency
still require the app's process to be online; `url_check: host` rules the catch out.

`ls` marks an answer from this machine with `(here)`, and a `down` url with the short reason of the last place
tried: `refused`, `not resolved`, `timeout`, `tls`, `reset` or `no answer`. The JSON rows carry `url_from` (`host`,
`here`, or null when unchecked) and `url_reason` (why it is down, with both sides when neither answered, as in
`on box: refused; here: refused`, or why it was taken from this machine), which `describe` prints too.

When the url's name resolves on the host to the host itself (for instance through a hostname line in its
`/etc/hosts`), that is the reason only when the url answered from this machine:
`on box site.test resolves to 127.0.1.1, the host itself`, the dev container whose name for the site means another
machine. Otherwise the host's own failure stays the reason and the address follows as a note, so a box whose own
name resolves to itself and whose app is down reads `✗ down (refused)`, with the `url_reason`
`on box: refused (devbox resolves to 127.0.1.1, the host itself)`.

`doctor` shows each host's environment (container or not, hostname) and where each of its apps' urls answers, and
suggests `url_check: auto` for an app with `url_check: host` whose url answers only from here.

```yaml
apps:
  web:
    description: dev server in the container
    run: yarn dev
    port: 3000
    url: https://site.test/
    url_check: here   # checked only from this machine: ls, wait and ready never request it in the container
    host: box
```
