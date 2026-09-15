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
#   2. strips the file capabilities from /usr/bin/caddy
#      (cap_net_bind_service=ep) and /usr/bin/mtr-packet (cap_net_raw=ep), so
#      the container can run with an empty capability bounding set (Olares
#      securityContext drops ALL) — execve of a file-cap binary fails with
#      EPERM when its caps are outside the bounding set. Caddy binds to 8080
#      (>1024) and needs no cap_net_bind_service; mtr-packet works without
#      cap_net_raw for non-root users, and
#   3. patches both Caddyfiles to forward a loopback Host header (plus a
#      matching Origin) to DSH. DSH's webserver accepts ONLY loopback Host
#      headers for plugin-registered /api routes (any domain/pod-IP Host
#      -> empty 400), while the stock Caddyfiles forward the public
#      authority ($DSH_UPSTREAM_HOST) — so stock images 400 on every plugin
#      API call (e.g. the skill-explorer panel). Caddy itself is the trusted
#      loopback proxy and enforces the public origin boundary, and the
#      plugin's trust fence requires socket loopback AND Host loopback AND
#      Origin==Host — so forwarding loopback Host+Origin is the shape the
#      fence expects. Core DSH routes are unaffected (they accept any Host).
#
# TAG NAMING: workstation base -> `<ver>-olares` (this file). A runtime-base
# fork (when upstream ships no -workstation tag) -> `<ver>-olares-runtime`;
# see IMAGE-UPDATE.md (Part 3.3/3.5) for the runtime delta (no mtr-packet,
# install libcap2-bin for setcap).
FROM docker.io/moelin/deepseek-harness:0.1.5-rc.2-workstation

RUN setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet

COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh

RUN python3 - <<'PY'
import sys
# DSH's webserver accepts ONLY a loopback Host header for plugin-registered
# /api routes (any domain/pod-IP Host -> empty 400). Make sure EVERY
# reverse_proxy block in both Caddyfiles forwards a loopback Host + matching
# Origin (the plugins' trust fence requires socket loopback AND Host loopback
# AND Origin==Host; Caddy is the trusted loopback proxy and enforces the
# public origin boundary itself). Core DSH routes are unaffected.
OPEN = 'reverse_proxy 127.0.0.1:{$DSH_INTERNAL_PORT} {'
INJECT = ('header_up Host 127.0.0.1:{$DSH_INTERNAL_PORT}\n'
          '\t\t\theader_up Origin http://127.0.0.1:{$DSH_INTERNAL_PORT}\n')
for f in ('/etc/caddy/Caddyfile', '/etc/caddy/Caddyfile.passthrough'):
    s = open(f).read()
    # (a) stock files: replace the public-authority Host where present
    s = s.replace('header_up Host {$DSH_UPSTREAM_HOST}',
                  'header_up Host 127.0.0.1:{$DSH_INTERNAL_PORT}\n'
                  '\t\t\theader_up Origin http://127.0.0.1:{$DSH_INTERNAL_PORT}')
    # (b) main route blocks that have NO Host line at all (caddy-security
    #     Caddyfile): inject Host+Origin right after the block opens
    out, i = [], 0
    for _ in range(s.count(OPEN)):
        start = s.index(OPEN, i)
        end = s.index('\n\t\t}', start)
        block = s[start:end]
        if 'header_up Host' not in block:
            block = OPEN + '\n' + INJECT + block[len(OPEN):]
        out.append(s[i:start] + block)
        i = end
    out.append(s[i:])
    open(f, 'w').write(''.join(out))
    assert s.count(OPEN) >= 1
PY
# verify: every reverse_proxy block in both files now sets the loopback Host
RUN grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile /etc/caddy/Caddyfile.passthrough | grep -v ':0' \
    && [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile)" -ge 2 ] \
    && [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile.passthrough)" -ge 2 ]
