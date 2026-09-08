# DeepSeek Harness (DSH) — Olares Fork Image Update Guide

Self-contained runbook. A fresh agent session can execute this with no prior
context. Everything needed is here: where to check for newer upstream images,
what the fork must change (and why), exact build/verify/push commands, and the
pitfalls discovered while building it.

## Purpose

The Olares app `deepseekharness` does **not** run the upstream image directly.
It runs a thin fork published to the user's Docker Hub:

```
docker.io/technigmaai/deepseek-harness:<DSH_VERSION>-olares
```

built from:

```
docker.io/moelin/deepseek-harness:<DSH_VERSION>-workstation
```

This repo holds the fork recipe: `Dockerfile` (base + 2 fixes) and
`entrypoint-olares.sh` (patched entrypoint). Chart version tracking and app
state live in `OlaresManifest.yaml` / `values.yaml` (same folder).

Current state (verify freshness when you run this — dates drift fast):
- Fork image in use by the chart: see `values.yaml` → `image.tag`
- Upstream releases move ~daily during alpha; Docker Hub lags GitHub/npm.

## Part 1 — Search for newer images (the sources)

Use all three; **Docker Hub is the only source that can actually be built from**
(the fork is `FROM` a Docker Hub image). GitHub/npm tell you what's coming.

### 1. Docker Hub `moelin/deepseek-harness` (primary)

```bash
curl -s "https://hub.docker.com/v2/repositories/moelin/deepseek-harness/tags?page_size=50" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for t in d.get('results', []):
    print(t['name'], '| pushed:', (t.get('tag_last_pushed') or '')[:10])
"
```

Tag families: `<DSH_VERSION>` (runtime), `<DSH_VERSION>-workstation`
(workstation, the one we fork), `latest`, `workstation` (floating).

> ⚠️ **Do NOT build from `:latest` / `:workstation`.** The builder's scheduled
> builds use a checksum-pinned source release recorded in its
> `dsh-source.json`; that pin has lagged behind published releases, so the
> floating `latest` once pointed at an *older* DSH (0.1.2-alpha.1) while
> `0.1.2-alpha.5` tags also existed. Always pin the newest **versioned**
> `-workstation` tag.

### 2. Builder repo `okxlin/release-factory` (upstream of the image)

- Pinned source release:
  `https://raw.githubusercontent.com/okxlin/release-factory/main/deepseek-harness-builder/image/dsh-source.json`
  (`version`, `ref`, `commit`, `archiveSha256`) — tells you what the scheduled
  builds will produce next.
- The image's entrypoint (what the fork must patch):
  `https://raw.githubusercontent.com/okxlin/release-factory/main/deepseek-harness-builder/image/scripts/entrypoint.sh`
- Runtime docs / env vars / persistence contract:
  `https://github.com/okxlin/release-factory/tree/main/deepseek-harness-builder`
  (README there is the source of truth for `/data` + `/workspace` mounts,
  `PUBLIC_URL`, `AUTH_PASSWORD`, `AUTH_MODE`, `/healthz`, uid 1000).

### 3. Upstream `deepseek-ai/deepseek-harness` (leading edge)

```bash
# GitHub releases (tag pattern dsh-vX.Y.Z)
curl -s "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=5" \
  | python3 -c "import json,sys; [print(r['tag_name'], r.get('published_at','')[:10]) for r in json.load(sys.stdin)]"

# npm dist-tags (builder can build from published npm versions)
curl -s "https://registry.npmjs.org/@deepseek-ai/dsh" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('dist-tags'))"
```

If GitHub/npm has a newer version than Docker Hub's newest tag, it usually
means the image **hasn't been published yet** — wait for the Docker Hub tag or
tell the user the gap.

### Decision rule

Pick `MAX(newest versioned tag with a -workstation variant on Docker Hub)`
that is strictly newer than the fork's current base (see `Dockerfile` FROM
line). Example: current base `0.1.2-alpha.4-workstation`, Hub has
`0.1.2-alpha.5-workstation` → build the fork as `0.1.2-alpha.5-olares`.

## Part 2 — What the fork changes (2 mandatory fixes)

The upstream image cannot run on Olares as-is. Two problems, both verified:

### Fix 1 — entrypoint: root + gosu → run as uid 1000

- Olares OPA **denies non-trusted images running as root**; the upstream image
  has no `USER` directive (runs root) and its entrypoint uses `gosu node` to
  drop privileges.
- When forced to uid 1000, `gosu` fails with `operation not permitted` and the
  entrypoint dies **silently** (exit 1, no log) because its `set -e` aborts on
  a captured command substitution.
- **Patch**: replace the 4 `gosu "${APP_USER}"` call sites with a helper that
  uses gosu only when root, and runs directly when already uid 1000:
  1. Add after the `fatal()` function definition:

     ```bash
     # Olares runs the container as uid 1000 (the image's node user); gosu cannot
     # switch users without root, so run directly when already unprivileged.
     APP_RUNNER=()
     if [ "$(id -u)" = "0" ]; then
       APP_RUNNER=(gosu "${APP_USER}")
     fi
     run_as_app() {
       if [ "$(id -u)" = "0" ]; then
         gosu "${APP_USER}" "$@"
       else
         "$@"
       fi
     }
     ```
  2. `web_help="$(gosu "${APP_USER}" dsh web --help 2>&1)"`
     → `web_help="$(run_as_app dsh web --help 2>&1)"`
  3. Inside the DSH subshell: `gosu "${APP_USER}" dsh "${DSH_ARGS[@]}" \`
     → `"${APP_RUNNER[@]}" dsh "${DSH_ARGS[@]}" \`
     (must be an **array expansion**, not `run_as_app` — that line runs
     through `env`, which cannot execute a shell function)
  4. Both Caddy lines: `gosu "${APP_USER}" env \` → `run_as_app env \`

  The checked-in result of this patch is `entrypoint-olares.sh` (same folder).

### Fix 2 — strip file capabilities (execve EPERM under drop-ALL)

- `/usr/bin/caddy` carries `cap_net_bind_service=ep`, `/usr/bin/mtr-packet`
  carries `cap_net_raw=ep`. With Olares' `capabilities: drop: ["ALL"]` the
  bounding set is empty → `execve` of a file-cap binary fails with
  **EPERM** (signature: plain `sh`/`node` exec fine, `caddy` alone fails).
- **Patch**: `RUN setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet`
  (⚠️ one `-r` **before each** file — `setcap -r f1 f2` errors). Caddy binds
  8080 (>1024) so it doesn't need the cap.
- The set of capped binaries can **change between upstream builds** — always
  re-scan the new base (command below) and extend the `setcap -r` line.

## Part 3 — Build procedure

All steps run on the user's machine (Docker is available and logged in as
`technigmaai`; node arch is **amd64** — the fork is single-arch, that's fine).
Workdir: the app folder in the `olares-apps` repo (where this file lives).

### 3.1 Check for a newer base (Part 1), then pull it

```bash
docker pull moelin/deepseek-harness:<NEW>-workstation
```

### 3.2 Extract the new image's entrypoint and re-derive the patch

The fork bakes in a patched copy of the entrypoint, so the new base's
entrypoint must be re-checked (do NOT assume the repo's `entrypoint-olares.sh`
still matches — upstream can change the entrypoint between DSH releases):

```bash
docker create --name dsh-extract moelin/deepseek-harness:<NEW>-workstation
docker cp dsh-extract:/usr/local/bin/entrypoint.sh /tmp/entrypoint-new.sh
docker rm dsh-extract
grep -n 'gosu' /tmp/entrypoint-new.sh   # expect the 4 call sites (Part 2 Fix 1)
```

Re-derive the patch with this script (run from the app folder — it
**asserts** its anchors, so it fails loudly if upstream restructured the
entrypoint; in that case patch by hand per Part 2 Fix 1):

```bash
python3 - <<'EOF'
src = open('/tmp/entrypoint-new.sh').read()

helper = '''# Olares runs the container as uid 1000 (the image's node user); gosu cannot
# switch users without root, so run directly when already unprivileged.
APP_RUNNER=()
if [ "$(id -u)" = "0" ]; then
  APP_RUNNER=(gosu "${APP_USER}")
fi
run_as_app() {
  if [ "$(id -u)" = "0" ]; then
    gosu "${APP_USER}" "$@"
  else
    "$@"
  fi
}
'''
anchor = '''fatal() {
    printf '[entrypoint] ERROR: %s\\n' "$*" >&2
    exit 1
}'''
assert anchor in src, "anchor not found — entrypoint changed, patch by hand"
src = src.replace(anchor, anchor + '\n' + helper, 1)

for old, new in [
    ('web_help="$(gosu "${APP_USER}" dsh web --help 2>&1)"',
     'web_help="$(run_as_app dsh web --help 2>&1)"'),
    ('        gosu "${APP_USER}" dsh "${DSH_ARGS[@]}" \\\',
     '        "${APP_RUNNER[@]}" dsh "${DSH_ARGS[@]}" \\'),
    ('gosu "${APP_USER}" env \\\',
     'run_as_app env \\'),
]:
    assert old in src, f"call site not found: {old}"
    src = src.replace(old, new)

open('entrypoint-olares.sh', 'w').write(src)
print("patched entrypoint-olares.sh")
EOF
chmod 755 entrypoint-olares.sh
```

Sanity check afterwards: the result should differ from the upstream original
only by the helper block + the 4 call sites
(`diff /tmp/entrypoint-new.sh entrypoint-olares.sh`).

### 3.3 Scan the new image for file-capability binaries

```bash
docker run --rm --entrypoint sh moelin/deepseek-harness:<NEW>-workstation \
  -c 'for d in /usr/bin /usr/local/bin /usr/sbin /bin /opt/dsh/node_modules/.bin; do find "$d" -maxdepth 3 -type f -exec getcap {} + 2>/dev/null; done | grep -v "^$"; echo scan-done'
```

Expected (as of 0.1.2-alpha.5): exactly `caddy` + `mtr-packet`. Anything new
goes into the `setcap -r` list in the Dockerfile. (The image ships `getcap`;
scanning on the host after `docker export` does **not** work — export loses
xattrs.)

Runtime base (no `getcap`/`setcap` installed): the scan above is meaningless
(missing tool → empty result looks like "no caps"). Test empirically instead:

```bash
# EPERM = caddy still carries cap_net_bind_service → must be stripped
docker run --rm --user 1000:1000 --cap-drop ALL --entrypoint /usr/bin/caddy \
  moelin/deepseek-harness:<NEW> version
# sanity: sh must work in the same context
docker run --rm --user 1000:1000 --cap-drop ALL --entrypoint sh \
  moelin/deepseek-harness:<NEW> -c 'echo sh-ok'
```

Runtime-base Dockerfile delta (0.1.3-alpha.2 is the known case): no
`mtr-packet` (workstation-only) and no `setcap` tool — install `libcap2-bin`
in the build:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap -r /usr/bin/caddy \
    && rm -rf /var/lib/apt/lists/*
```

### 3.4 Update the Dockerfile

Change the `FROM` line to the new base; extend the `setcap -r` line if 3.3
found new binaries. Keep the existing `COPY entrypoint-olares.sh
/usr/local/bin/entrypoint.sh`.

### 3.5 Build

Tag naming — the suffix encodes the BASE VARIANT (so forks are unambiguous):

| Base image | Fork tag |
|---|---|
| `<NEW>-workstation` | `docker.io/technigmaai/deepseek-harness:<NEW>-olares` |
| `<NEW>` (runtime only) | `docker.io/technigmaai/deepseek-harness:<NEW>-olares-runtime` |

```bash
docker build -t docker.io/technigmaai/deepseek-harness:<NEW>-olares .   # workstation base
# docker build -t docker.io/technigmaai/deepseek-harness:<NEW>-olares-runtime .   # runtime base
```

### 3.6 Verify with the EXACT Olares security context

This is the gate — the real pod runs with `runAsUser/runAsGroup 1000`,
`allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`:

```bash
rm -rf /tmp/dsh-v && mkdir -p /tmp/dsh-v/data /tmp/dsh-v/ws && chown -R 1000:1000 /tmp/dsh-v
docker run -d --name dshv --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  -e PUBLIC_URL=https://dsh.example.com -e AUTH_PASSWORD=testpassword123 \
  -v /tmp/dsh-v/data:/data -v /tmp/dsh-v/ws:/workspace \
  docker.io/technigmaai/deepseek-harness:<NEW>-olares
sleep 40   # DSH cold start ~20-40s
docker inspect dshv --format '{{.State.Status}}'            # expect: running
docker exec dshv curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz   # expect: 200
docker exec dshv cat /etc/deepseek-harness-version          # expect: DSH_VERSION=<NEW>
docker logs dshv 2>&1 | grep -E 'ERROR|entrypoint'          # expect: clean entrypoint lines, no ERROR
docker rm -f dshv; rm -rf /tmp/dsh-v
```

Failure signatures → causes:
- exit 1, no logs, dirs created in /data → gosu still in the entrypoint (Fix 1)
- `exec /usr/bin/caddy: operation not permitted` → uncapped binary (Fix 2)
- `install: cannot change owner ... /data` → test harness issue (chown the
  mount dirs to 1000 first); in real pods the chart's initContainer handles it

### 3.7 Push

```bash
docker push docker.io/technigmaai/deepseek-harness:<NEW>-olares   # or -olares-runtime for runtime base
# verify:
curl -s "https://hub.docker.com/v2/repositories/technigmaai/deepseek-harness/tags/<NEW>-olares" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name'), (d.get('tag_last_pushed') or '')[:10])"
```

(Note: deleting a Docker Hub tag programmatically is not available with the
refresh-token docker credentials — 401 on the Hub v2 API. Stale/renamed tags
are harmless if unreferenced; remove them via the Docker Hub web UI if wanted.)

## Part 4 — Chart update (optional follow-up)

To move the live app to the new image (bumps the chart; restarts the app):

1. `values.yaml`: `image.tag: <NEW>-olares`
2. `OlaresManifest.yaml`: `spec.versionName: "<NEW>"`, bump `metadata.version`
3. `Chart.yaml`: `appVersion: "<NEW>"`, `version:` = new `metadata.version`
   (they MUST be equal)
4. ```bash
   olares-cli chart lint ./deepseekharness
   olares-cli chart package ./deepseekharness
   olares-cli market upload ./deepseekharness-<CHART_VER>.tgz
   olares-cli market upgrade deepseekharness -s upload --version <CHART_VER> --watch --watch-timeout 5m
   ```
   If the app state is stuck (`initializing`/in-flight op), the upgrade is
   rejected — wait for it to settle or coordinate with the user.
5. Update the repo `README.md` (Applications table + Releases table + app
   note), `git add/commit/push`, and
   `gh release create deepseekharness-<CHART_VER> ./deepseekharness-<CHART_VER>.tgz`.

App data (identity store, plugins under `/data/dsh/profiles/web`, workspaces
under `Data/deepseekharness/workspaces`) survives image upgrades — it lives in
Olares userspace, not the image. Re-check installed plugins' peerDependency
ranges against the new DSH version before upgrading (a plugin built against an
unreleased DSH API breaks boot with a `plugin tree failed to load` error; the
known-bad plugin `dsh-at-file` imports `settingsNamespace` which no published
DSH exports — the compatible alternative is `dsh-at-mention`).

## Pitfalls (learned the hard way)

- **`:latest` is untrustworthy** — builder pins lag; pin versioned tags.
- **Releases may be runtime-only** — 0.1.3-alpha.2 shipped without a
  `-workstation` tag. Check the `-workstation` variant exists before building
  a workstation fork; if only runtime exists, flag the toolchain loss to the
  user and use the runtime-base Dockerfile delta (Part 3.3).
- **`setcap -r f1 f2` fails** — needs `-r` per file.
- **docker cp/export lose xattrs** — scan file caps *inside* the image
  (it ships `getcap`).
- **gosu under uid 1000** fails EPERM and the entrypoint dies silently
  (`set -e` + captured stderr) — check `install -d` logs and `docker logs`
  for `[entrypoint]` lines.
- **execve EPERM under `cap-drop ALL`** is a file-capability signature, not a
  permissions problem.
- **Olares app names**: `^[a-z0-9]{1,30}$` — no hyphens (`deepseekharness`,
  not `deepseek-harness`).
- **`cluster exec` needs Olares ≥ 1.12.7**; on 1.12.6 run in-container commands
  through the app's web terminal sidecar (DeepSeek Harness CLI entrance) or a
  local `docker run` test instead.
- **Workspace**: DSH `@`-mention file search is scoped to the session cwd
  (empty folders yield nothing).
- User preference: local `docker` testing first is fine, but confirm on the
  real Olares app afterwards (pod 2/2, `market status` = running).
