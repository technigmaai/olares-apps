# Thin Olares fork of the upstream DeepSeek Harness image.
#
# Upstream (moelin/deepseek-harness) runs its entrypoint as root and uses
# `gosu` to drop to the `node` user. Olares' OPA policy denies non-trusted
# images running as root, and the entrypoint's `gosu` calls fail when the
# container is forced to uid 1000 (gosu needs CAP_SETUID). This fork keeps the
# upstream image byte-for-byte and only:
#   1. replaces the entrypoint with a variant that runs the DSH/Caddy
#      processes as the current user when unprivileged (still using gosu when
#      running as root, so upstream Docker behavior is unchanged), and
#   2. strips file capabilities from /usr/bin/caddy (cap_net_bind_service) and
#      /usr/bin/mtr-packet (cap_net_raw), so the container can run with an
#      empty capability bounding set (Olares securityContext drops ALL) —
#      execve of a file-cap binary fails with EPERM when its caps are outside
#      the bounding set. Caddy binds to 8080 (>1024) and needs no
#      cap_net_bind_service; mtr-packet works without cap_net_raw for
#      non-root users.
FROM docker.io/moelin/deepseek-harness:0.1.2-alpha.4-workstation

RUN setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet

COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh
