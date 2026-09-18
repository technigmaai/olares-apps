# Thin Olares fork of the upstream DeepSeek Harness image.
#
# Upstream (moelin/deepseek-harness) runs its entrypoint as root and uses
# `gosu` to drop to the `node` user. Olares' OPA policy denies non-trusted
# images running as root, and the entrypoint's `gosu` calls fail when the
# container is forced to uid 1000 (gosu needs CAP_SETUID). This fork keeps the
# upstream image byte-for-byte and only:
#   1. replaces the entrypoint with a variant that runs the DSH/Caddy
#      processes as the current user when unprivileged (still using gosu when
#      running as root, so upstream Docker behavior is unchanged),
#   2. strips file capabilities (execve of a file-cap binary fails with EPERM
#      when the runtime drops ALL capabilities — Olares' securityContext),
#   3. patches the Caddyfiles to forward loopback Host+Origin to DSH (DSH's
#      webserver 400s plugin-registered /api routes for any non-loopback
#      Host; the stock files forward the public authority), and
#   4. (in entrypoint-olares.sh) removes the persisted Caddy autosave at boot
#      so the image's Caddyfile is always authoritative.
#
# CURRENT BASE: runtime variant — upstream 0.1.6-alpha.2 shipped runtime-only
# (no -workstation tag). Runtime bases lack getcap/setcap and python3, so:
# libcap2-bin is installed for setcap, only /usr/bin/caddy is stripped
# (no mtr-packet on runtime bases), and the Caddyfile patch runs on node
# (present in every DSH image; python3 is workstation-only).
#
# TAG NAMING: workstation base -> `<ver>-olares`; runtime base ->
# `<ver>-olares-runtime` (this file). See DOCKER-IMAGE-UPDATE.md /
# MAINTENANCE.md for the full update workflow.
FROM docker.io/moelin/deepseek-harness:0.1.6-alpha.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap -r /usr/bin/caddy \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh

RUN node - <<'JS'
const fs = require('fs')
const OPEN = 'reverse_proxy 127.0.0.1:{$DSH_INTERNAL_PORT} {'
const LB = 'header_up Host 127.0.0.1:{$DSH_INTERNAL_PORT}\n\t\t\theader_up Origin http://127.0.0.1:{$DSH_INTERNAL_PORT}'
for (const f of ['/etc/caddy/Caddyfile', '/etc/caddy/Caddyfile.passthrough']) {
  let s = fs.readFileSync(f, 'utf8')
  // (a) stock files: swap the public-authority Host for loopback Host+Origin
  s = s.split('header_up Host {$DSH_UPSTREAM_HOST}').join(LB)
  // (b) reverse_proxy blocks with NO Host line (main route): inject after open
  const count = s.split(OPEN).length - 1
  let out = '', i = 0
  for (let n = 0; n < count; n++) {
    const start = s.indexOf(OPEN, i)
    const end = s.indexOf('\n\t\t}', start)
    let block = s.slice(start, end)
    if (!block.includes('header_up Host')) block = OPEN + '\n' + LB + '\n' + block.slice(OPEN.length)
    out += s.slice(i, start) + block
    i = end
  }
  fs.writeFileSync(f, out + s.slice(i))
}
JS
# verify: every reverse_proxy block in both files forwards the loopback Host
RUN [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile)" -ge 2 ] \
    && [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile.passthrough)" -ge 2 ]
