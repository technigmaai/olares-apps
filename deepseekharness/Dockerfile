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
#   2. strips the file capability from /usr/bin/caddy (cap_net_bind_service=ep),
#      so the container can run with an empty capability bounding set (Olares
#      securityContext drops ALL) — execve of a file-cap binary fails with
#      EPERM when its caps are outside the bounding set. Caddy binds to 8080
#      (>1024) and needs no cap_net_bind_service.
#
# VARIANT NOTE (0.1.3-alpha.2): Docker Hub published only the lightweight
# RUNTIME variant for this release (no -workstation tag), so this fork is
# runtime-based — the DSH web + Caddy auth runtime WITHOUT the workstation
# toolchain (Python/Go/GCC/npm). Rebuild from `<ver>-workstation` (and add
# mtr-packet to the setcap list) when the workstation tag is published.
# The runtime base ships no setcap, so libcap2-bin is installed first.
FROM docker.io/moelin/deepseek-harness:0.1.3-alpha.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap -r /usr/bin/caddy \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh
