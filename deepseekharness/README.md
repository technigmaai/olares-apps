# DeepSeek Harness

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — agentic
coding environment, packaged for Olares with the
[okxlin/release-factory](https://github.com/okxlin/release-factory) image
(`moelin/deepseek-harness`, workstation variant) which adds a Caddy
reverse-proxy with a browser login form (`caddy-security`) and brute-force
rate limiting in front of DSH.

## Image

This chart uses a thin Olares fork: `docker.io/technigmaai/deepseek-harness:0.1.2-alpha.4-olares`
(`Dockerfile` in this folder). The upstream image runs its entrypoint as root
and drops to the `node` user via `gosu`; Olares' OPA policy denies non-trusted
root images and `gosu` cannot switch users without root, so the fork:

1. replaces the entrypoint with a variant that runs DSH/Caddy as the current
   user when unprivileged (unchanged behavior when run as root), and
2. strips file capabilities from `/usr/bin/caddy` (`cap_net_bind_service`) and
   `/usr/bin/mtr-packet` (`cap_net_raw`) so the pod can run with an empty
   capability bounding set (execve of a file-cap binary fails with EPERM when
   its caps are outside the bounding set).

## Storage

| Container path | Olares area | Purpose |
|---|---|---|
| `/data` | `appData` | Caddy config/certs, auth DB, JWT signing key, DSH state |
| `/home/node` | `userData` (Home) | Persistent HOME — user-installed pnpm/pipx/Go tools |
| `/workspace` | `appData/workspaces` | Workspace parent — each DSH workspace is a subfolder (`Data/deepseekharness/workspaces/<name>`) |

## Variables

| Variable | Default | Notes |
|---|---|---|
| `AUTH_PASSWORD` | _(required)_ | Login password, ≥ 12 chars. Only used in `caddy-security` mode. |
| `AUTH_USERNAME` | `admin` | Login username. |
| `AUTH_MODE` | `caddy-security` | `caddy-security` = built-in login + rate limiting; `none` = delegate auth to the Olares gateway (single login). |
| `AUTH_TOKEN_LIFETIME` | `3600` | Token/cookie lifetime in seconds (300–2592000). |

`PUBLIC_URL` is wired automatically to the app's Olares entrance domain
(`https://<appid>.<zone>`); the entrance proxy terminates TLS, so Caddy runs
plain HTTP inside the pod.

## Notes

- The entrance is `authLevel: private` (Olares login required) and
  `options.apiTimeout: 0` (DSH uses long-lived WebSockets for terminals and
  LLM streams).
- The image requires `/data` to be a real mount (the entrypoint fails closed
  otherwise) — the chart mounts `appData` there.
- To switch to the lightweight runtime variant, change `values.yaml`
  `image.tag` to `0.1.2-alpha.4-olares-runtime` (build it with
  `FROM docker.io/moelin/deepseek-harness:0.1.2-alpha.4` + the same
  `Dockerfile` steps).
