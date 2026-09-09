# DSH Fork Image — Docker-Only Update Runbook

Reusable guide for updating **just the Docker image**
(`docker.io/technigmaai/deepseek-harness:<ver>-olares[-runtime]`) when a newer
upstream `moelin/deepseek-harness` release appears. **Image only** — it does
not touch the Olares chart or the running app. For the chart/app bump after
the image is pushed, see [IMAGE-UPDATE.md](./IMAGE-UPDATE.md) Part 4.

A fresh agent session can run this with no other context. Workdir: this
folder (holds the `Dockerfile` + `entrypoint-olares.sh` of the last known-good
build). Docker CLI is available and logged in as `technigmaai`; node arch is
amd64 (single-arch fork is fine).

## 0. What the fork is

A 2-layer wrapper over the upstream image:

1. **Patched entrypoint** (`COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh`) —
   upstream runs as root + `gosu`; Olares OPA denies non-trusted root images
   and gosu can't switch users under uid 1000. The patch makes the entrypoint
   run DSH/Caddy as the current user when unprivileged (gosu kept for root).
2. **File-capability strip** (`RUN setcap -r ...`) — `caddy`
   (cap_net_bind_service) / `mtr-packet` (cap_net_raw) fail `execve` with
   EPERM under Olares' `capabilities: drop: ["ALL"]` empty bounding set.

## 1. Check for a newer version

**Docker Hub (the only source you can build from):**

```bash
curl -s "https://hub.docker.com/v2/repositories/moelin/deepseek-harness/tags?page_size=50" | python3 -c "
import json, sys
for t in json.load(sys.stdin).get('results', []):
    print(t['name'], '| pushed:', (t.get('tag_last_pushed') or '')[:10])
"
```

**Builder repo (upstream of the image — what the next build will pin):**
- `https://raw.githubusercontent.com/okxlin/release-factory/main/deepseek-harness-builder/image/dsh-source.json` (checksum-pinned source release)
- `https://raw.githubusercontent.com/okxlin/release-factory/main/deepseek-harness-builder/image/scripts/entrypoint.sh`
- Docs/env/persistence contract: `https://github.com/okxlin/release-factory/tree/main/deepseek-harness-builder` (README)

**Upstream leading edge (Hub usually lags these):**

```bash
curl -s "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=5" \
  | python3 -c "import json,sys; [print(r['tag_name'], r.get('published_at','')[:10]) for r in json.load(sys.stdin)]"
curl -s "https://registry.npmjs.org/@deepseek-ai/dsh" | python3 -c "import json,sys; print(json.load(sys.stdin).get('dist-tags'))"
```

**Decision rule**
- Base = newest **versioned** Docker Hub tag strictly newer than the current
  `FROM` in `Dockerfile`.
- Prefer the `-workstation` variant (app needs the toolchain). If a release
  shipped **runtime-only** (no `-workstation` tag), tell the user (toolchain
  loss) — build the runtime fork only on their OK.
- ⚠️ **Never build from `:latest`/`:workstation` floating tags** — the
  builder's source pin has lagged and `latest` once pointed at an *older* DSH.

## 2. Build

Set `<NEW>` = chosen version, `<TAG>` = `<NEW>-olares` (workstation base) or
`<NEW>-olares-runtime` (runtime base).

### 2.1 Pull + extract entrypoint

```bash
docker pull moelin/deepseek-harness:<NEW>-workstation     # or <NEW> for runtime
docker create --name dsh-extract moelin/deepseek-harness:<NEW>-workstation
docker cp dsh-extract:/usr/local/bin/entrypoint.sh /tmp/entrypoint-new.sh
docker rm dsh-extract
grep -n 'gosu' /tmp/entrypoint-new.sh    # expect the 4 call sites
```

### 2.2 Re-derive the entrypoint patch

Run from this folder. The script **asserts its anchors** — if upstream
restructured the entrypoint it fails loudly; patch by hand then (4 call sites:
`web_help=` line, the DSH subshell line — must become
`"${APP_RUNNER[@]}" dsh "${DSH_ARGS[@]}" \` because it runs through `env` and
cannot call a shell function — and the two Caddy `env \` lines; plus the
helper block after `fatal()`):

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
    ('        gosu "${APP_USER}" dsh "${DSH_ARGS[@]}" \\',
     '        "${APP_RUNNER[@]}" dsh "${DSH_ARGS[@]}" \\'),
    ('gosu "${APP_USER}" env \\',
     'run_as_app env \\'),
]:
    assert old in src, f"call site not found: {old}"
    src = src.replace(old, new)

open('entrypoint-olares.sh', 'w').write(src)
print("patched entrypoint-olares.sh")
EOF
chmod 755 entrypoint-olares.sh
# sanity: diff vs upstream original must show ONLY the 5 patch hunks
diff entrypoint-olares.sh /tmp/entrypoint-new.sh
```

(If the diff shows only the helper block + 4 call-site lines, the upstream
entrypoint was unchanged and the existing file would have been reusable as-is.)

### 2.3 File-capability scan

Workstation base (ships `getcap`):

```bash
docker run --rm --entrypoint sh moelin/deepseek-harness:<NEW>-workstation \
  -c 'for d in /usr/bin /usr/local/bin /usr/sbin /bin /opt/dsh/node_modules/.bin; do find "$d" -maxdepth 3 -type f -exec getcap {} + 2>/dev/null; done | grep -v "^$"; echo scan-done'
```

Expected: `caddy cap_net_bind_service=ep` + `mtr-packet cap_net_raw=ep`.
Anything new → add to the `setcap -r` list (one `-r` **per file**).

Runtime base (no `getcap`/`setcap` — a scan returning nothing is meaningless):
test empirically — `docker run --rm --user 1000:1000 --cap-drop ALL
--entrypoint /usr/bin/caddy moelin/deepseek-harness:<NEW> version` returning
`operation not permitted` = caddy still carries the cap and must be stripped.

### 2.4 Dockerfile

Workstation base:

```dockerfile
FROM docker.io/moelin/deepseek-harness:<NEW>-workstation
RUN setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet
COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh
```

Runtime base (no `mtr-packet`, no `setcap` tool — install libcap2-bin):

```dockerfile
FROM docker.io/moelin/deepseek-harness:<NEW>
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap -r /usr/bin/caddy \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh
```

### 2.5 Build

```bash
docker build -t docker.io/technigmaai/deepseek-harness:<TAG> .
```

## 3. Verify (exact Olares security context)

The real pod runs `runAsUser/runAsGroup 1000`, `allowPrivilegeEscalation:
false`, `capabilities.drop: [ALL]` — the test must mirror that:

```bash
rm -rf /tmp/dsh-v && mkdir -p /tmp/dsh-v/data /tmp/dsh-v/ws && chown -R 1000:1000 /tmp/dsh-v
docker run -d --name dshv --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  -e PUBLIC_URL=https://dsh.example.com -e AUTH_PASSWORD=testpassword123 \
  -v /tmp/dsh-v/data:/data -v /tmp/dsh-v/ws:/workspace \
  docker.io/technigmaai/deepseek-harness:<TAG>
sleep 40   # DSH cold start ~20-45s
docker inspect dshv --format '{{.State.Status}}'      # expect: running
docker exec dshv curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz  # expect: 200
docker exec dshv cat /etc/deepseek-harness-version    # expect: DSH_VERSION=<NEW>
docker logs dshv 2>&1 | grep -E 'ERROR|Error'         # expect: nothing
# workstation only: toolchain spot-check
docker exec dshv sh -c 'gcc --version | head -1; python3 --version; go version'
docker rm -f dshv && rm -rf /tmp/dsh-v
```

Failure signatures:
| Symptom | Cause |
|---|---|
| exit 1, **no logs**, dirs created in /data | gosu still in entrypoint (silent `set -e` death) |
| `exec /usr/bin/caddy: operation not permitted` | uncapped file-cap binary (Fix 2) |
| `install: cannot change owner ... /data` | test harness: chown mount dirs to 1000 first (real pods use the chart's initContainer) |
| `PUBLIC_URL is required` / auth errors | missing test env vars |

## 4. Push + housekeeping

```bash
docker push docker.io/technigmaai/deepseek-harness:<TAG>
curl -s "https://hub.docker.com/v2/repositories/technigmaai/deepseek-harness/tags/<TAG>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name'), (d.get('tag_last_pushed') or '')[:10])"
```

Delete a stale/misnamed tag (PAT → JWT → DELETE, 204 = success):

```bash
PAT=$(python3 -c "import json,base64; print(base64.b64decode(json.load(open('/home/technigmaai/.docker/config.json'))['auths']['https://index.docker.io/v1/']['auth']).decode().partition(':')[2])")
JWT=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"technigmaai\",\"secret\":\"$PAT\"}" https://hub.docker.com/v2/auth/token \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token') or d.get('access_token') or '')")
curl -s -X DELETE -H "Authorization: Bearer $JWT" \
  -o /dev/null -w '%{http_code}\n' \
  https://hub.docker.com/v2/repositories/technigmaai/deepseek-harness/tags/<STALE-TAG>
```

(Basic auth and registry `auth.docker.io` tokens both 401/405 on the Hub v2
API; registry-1 DELETE is 404 — only the flow above works.)

Finish with: `git add Dockerfile entrypoint-olares.sh && git commit -m
"deepseekharness fork: <NEW> base" && git push origin main` (only if the
files changed).

## 5. Pitfalls (learned the hard way)

- **`:latest` untrustworthy** — builder source pins lag; pin versioned tags.
- **Releases may be runtime-only** — 0.1.3-alpha.2 first shipped without a
  `-workstation` tag. Check before assuming.
- **`setcap -r f1 f2` fails** — one `-r` per file.
- **docker cp/export lose xattrs** — scan caps *inside* the image.
- **gosu under uid 1000** fails EPERM and the entrypoint dies silently.
- **execve EPERM under `cap-drop ALL`** = file-capability signature
  (sh/node exec fine, caddy fails).
- **Tag naming encodes the base variant**: `-olares` = workstation,
  `-olares-runtime` = runtime. Keep it — it's the only thing telling a future
  reader what's inside.

## Build history

| Fork tag | Base | DSH | Digest |
|---|---|---|---|
| `0.1.2-alpha.4-olares` | 0.1.2-alpha.4-workstation | 0.1.2-alpha.4 | `a01e0243ca96…` |
| `0.1.2-alpha.5-olares` | 0.1.2-alpha.5-workstation | 0.1.2-alpha.5 | `f49153c08132…` |
| `0.1.3-alpha.2-olares-runtime` | 0.1.3-alpha.2 (runtime-only release) | 0.1.3-alpha.2 | `107ff066759a…` |
| `0.1.3-alpha.2-olares` | 0.1.3-alpha.2-workstation | 0.1.3-alpha.2 | `b90044ed97f2…` |
