# HANDOFF — Building the DeepSeek Harness Docker image

**Audience:** a fresh agent or engineer with *zero* prior context.
**Scope:** build, verify and publish the Olares-compatible fork of the upstream
DeepSeek Harness (DSH) container image. **Image only** — the Olares chart
(install/upgrade) is a separate job; see `MAINTENANCE.md`.
**Output:** `docker.io/technigmaai/deepseek-harness:<TAG>` on Docker Hub, built
from an upstream `moelin/deepseek-harness` release.

---

## 0. TL;DR — the whole job in eight commands

```bash
# set these
NEW=0.2.0-rc.2            # upstream release you are forking
BASE=moelin/deepseek-harness:$NEW-workstation
TAG=$NEW-olares           # workstation base; runtime base -> $NEW-olares-runtime
DIR=~/ai-tools/pi-agent/Olares/olares-apps/deepseekharness   # fork context (Dockerfile + entrypoint)

# 1 pull base, 2 re-derive entrypoint patch, 3 check file caps
docker pull $BASE
docker create --name x $BASE && docker cp x:/usr/local/bin/entrypoint.sh /tmp/ep-new.sh && docker rm x
#   -> run the patch script in §3 (it asserts anchors); writes entrypoint-olares.sh
docker run --rm --entrypoint sh $BASE -c 'for d in /usr/bin /usr/local/bin /usr/sbin /bin; do find "$d" -maxdepth 2 -type f -exec getcap {} + 2>/dev/null; done'

# 4 set FROM in Dockerfile, 5 build
cd $DIR && sed -i "s|^FROM .*|FROM docker.io/$BASE|" Dockerfile
docker build -t docker.io/technigmaai/deepseek-harness:$TAG .

# 6 verify (three runs, §5)   7 push   8 record
docker push docker.io/technigmaai/deepseek-harness:$TAG
# append a row to the Build history table in DOCKER-IMAGE-UPDATE.md
```

If any verification in §5 fails, **do not push** — the failure table in §8 maps
each symptom to its cause.

---

## 1. What the fork is, and why it exists

The upstream image runs as **root** and its entrypoint `gosu`s down to the
`node` user (uid 1000), keeps its whole state in `/data`, and fronts DSH with a
Caddy reverse proxy on port 8080 (DSH itself listens on container loopback
`127.0.0.1:3080`).

Olares runs application pods with a **restricted security context**:

* `runAsUser: 1000`, `runAsGroup: 1000`
* `allowPrivilegeEscalation: false`
* `capabilities.drop: ["ALL"]` — an **empty capability bounding set**
* OPA denies non-trusted images that run as root

Under those constraints the stock image breaks in three independent ways, and a
fourth problem is a persistence trap that hides Caddyfile changes. The fork is
upstream **byte-for-byte plus four patches**, all backwards-compatible (when run
as root it behaves exactly like upstream).

| # | Patch | Where | Why it is required |
|---|---|---|---|
| 1 | **Non-root entrypoint** — `APP_RUNNER` array + `run_as_app()` replace the 4 `gosu` calls | `entrypoint-olares.sh` | `gosu` needs `CAP_SETUID`; as uid 1000 it fails EPERM. Worse, one call sits inside a command substitution under `set -Eeuo pipefail`, so the container **dies with no logs at all**. Also makes the image portable: root runs still use gosu. |
| 2 | **Strip file capabilities** — `setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet` | Dockerfile `RUN` | `execve` of a binary carrying file caps fails with **EPERM** when those caps are outside the container's bounding set. Symptom: `exec /usr/bin/caddy: Operation not permitted`. Caddy binds 8080 (>1024) so it never needs `cap_net_bind_service`; `mtr-packet` works unprivileged. |
| 3 | **Loopback Host + Origin on every `reverse_proxy`** | both `/etc/caddy/Caddyfile` and `Caddyfile.passthrough` | DSH's webserver **only** accepts a loopback `Host` header for **plugin-registered `/api` routes** — a domain or pod-IP Host returns an empty **400**. Stock Caddy forwards the public authority (`$DSH_UPSTREAM_HOST`) as Host, and the caddy-security file's *main* route has no Host line at all. Result: plugin API calls fail (`"Failed to load: HTTP 400"`), while core DSH routes work — which makes it look like a plugin bug. |
| 4 | **Delete the persisted Caddy autosave at boot** — `rm -f "${CADDY_DATA_HOME}/config/caddy/autosave.json"` before `caddy run` | `entrypoint-olares.sh` | Caddy saves its *compiled* config under `/data`. A stale autosave from an older image silently keeps serving the OLD routing, so patch 3 appears not to work even though the new Caddyfile is in the image. The state that must persist (caddy-security identity store) lives in `/data/auth`, not in the autosave. |

**Key invariant:** Caddy is the trusted loopback proxy and enforces the public
origin boundary itself, so forwarding `Host: 127.0.0.1:3080` +
`Origin: http://127.0.0.1:3080` is exactly the shape DSH's plugin trust fence
expects (loopback socket **and** loopback Host **and** Origin == Host).

---

## 2. Prerequisites

| Need | Check |
|---|---|
| Docker on the build host (amd64) | `docker version` |
| Docker Hub login as `technigmaai` | `docker login` — PAT lives in `~/.docker/config.json` |
| Upstream base pullable | `docker pull moelin/deepseek-harness:<NEW>-workstation` |
| The fork context directory | `olares-apps/deepseekharness/` (this folder: `Dockerfile`, `entrypoint-olares.sh`, docs) |
| Olares CLI **only** for the later chart step | `olares-cli profile login --olares-id technigmaai@olares.com` (refresh tokens expire; re-login if you see *"refresh token … became invalid"*) |

> The upstream image is multi-arch for some releases, but this fork is built
> **single-arch (amd64)** — that is intentional and matches the node.

---

## 3. Entrypoint patch — re-derive it, never hand-edit blind

The patched entrypoint is ~490 lines; only five regions differ from upstream.
Re-derive from the base image every time so upstream changes are caught:

```bash
docker create --name dsh-extract moelin/deepseek-harness:<NEW>-workstation
docker cp dsh-extract:/usr/local/bin/entrypoint.sh /tmp/entrypoint-new.sh
docker rm dsh-extract
grep -n 'gosu' /tmp/entrypoint-new.sh        # expect exactly 4 call sites
```

Expected sites (line numbers move between releases — the *patterns* do not):

```
web_help="$(gosu "${APP_USER}" dsh web --help 2>&1)"
        gosu "${APP_USER}" dsh "${DSH_ARGS[@]}" \
gosu "${APP_USER}" env \                     # caddy validate
gosu "${APP_USER}" env \                     # caddy run
```

Apply the patch with assertions (fails loudly if upstream restructured):

```bash
cd olares-apps/deepseekharness
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
assert anchor in src, "anchor not found — upstream restructured; patch by hand"
src = src.replace(anchor, anchor + '\n' + helper, 1)

for old, new in [
    ('web_help="$(gosu "${APP_USER}" dsh web --help 2>&1)"',
     'web_help="$(run_as_app dsh web --help 2>&1)"'),
    # NOTE: this line runs through `env`, which execs a binary — a shell
    # function cannot go there. It must use the ARRAY, not run_as_app.
    ('        gosu "${APP_USER}" dsh "${DSH_ARGS[@]}" \\',
     '        "${APP_RUNNER[@]}" dsh "${DSH_ARGS[@]}" \\'),
    ('gosu "${APP_USER}" env \\',
     'run_as_app env \\'),
]:
    assert old in src, f"call site not found: {old}"
    src = src.replace(old, new)

open('entrypoint-olares.sh', 'w').write(src)
print("patched:", len(src), "bytes")
EOF
chmod 755 entrypoint-olares.sh
```

Then add **patch 4** — the autosave self-heal — immediately before `caddy run`
(search for `caddy run --config`):

```bash
python3 - <<'EOF'
p = 'entrypoint-olares.sh'
s = open(p).read()
anchor = 'log "starting Caddy on 0.0.0.0:${PORT} with AUTH_MODE=${AUTH_MODE}"\n'
inject = ('# Caddy persists a compiled config; a stale autosave would mask the\n'
          '# image Caddyfile (fork patch 3). Identity state lives in /data/auth.\n'
          'rm -f "${CADDY_DATA_HOME}/config/caddy/autosave.json"\n')
assert anchor in s, "caddy start anchor missing"
assert 'autosave.json' not in s, "autosave rm already present"
s = s.replace(anchor, anchor + inject, 1)
open(p, 'w').write(s)
print("autosave self-heal added")
EOF
```

**Sanity check** — the diff against the pristine upstream file must contain
*only* these regions (helper block, 4 call sites, autosave `rm`):

```bash
diff entrypoint-olares.sh /tmp/entrypoint-new.sh | grep -E '^[0-9]'
```
Expect ~5 hunk headers. Anything else means upstream drifted → reconcile manually.

> The `web_help` call and both Caddy calls invoke a command directly, so
> `run_as_app <cmd>` is fine. The DSH launch line is `... exec env -u … dsh …`,
> so it needs `"${APP_RUNNER[@]}"`. Replacing it with `run_as_app` produces
> `env: 'run_as_app': No such file or directory`.

---

## 4. Dockerfile

`olares-apps/deepseekharness/Dockerfile` — the canonical content:

```dockerfile
FROM docker.io/moelin/deepseek-harness:<NEW>-workstation

RUN setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet

COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh

# Patch 3: every reverse_proxy block in both Caddyfiles must forward a loopback
# Host + matching Origin. Node is used (not python3) because runtime-base
# images ship no python3.
RUN node - <<'JS'
const fs = require('fs')
const OPEN = 'reverse_proxy 127.0.0.1:{$DSH_INTERNAL_PORT} {'
const LB = 'header_up Host 127.0.0.1:{$DSH_INTERNAL_PORT}\n\t\t\theader_up Origin http://127.0.0.1:{$DSH_INTERNAL_PORT}'
for (const f of ['/etc/caddy/Caddyfile', '/etc/caddy/Caddyfile.passthrough']) {
  let s = fs.readFileSync(f, 'utf8')
  s = s.split('header_up Host {$DSH_UPSTREAM_HOST}').join(LB)   // stock line, if present
  const count = s.split(OPEN).length - 1
  let out = '', i = 0
  for (let n = 0; n < count; n++) {                            // blocks with NO Host line
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

# Fail the build if either file lost its loopback Host (expect 2 per file)
RUN [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile)" -ge 2 ] \
    && [ "$(grep -c 'header_up Host 127.0.0.1' /etc/caddy/Caddyfile.passthrough)" -ge 2 ]
```

### Runtime-base variant (only when upstream ships no `-workstation` tag)

Runtime bases have **no `getcap`, no `setcap`, no `python3`, no `mtr-packet`**.
Change exactly three things:

```dockerfile
FROM docker.io/moelin/deepseek-harness:<NEW>          # runtime tag
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap -r /usr/bin/caddy \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint-olares.sh /usr/local/bin/entrypoint.sh
# ...same node patch + verify...
```
and name the tag `<NEW>-olares-runtime`. Tell the user the **workstation
toolchain (gcc / Go / Python) is absent** — the web app, plugins and `dsh` CLI
still work.

### Tag naming (keep it)

| Base | Tag | Meaning |
|---|---|---|
| `-workstation` | `<NEW>-olares` | full dev toolchain |
| runtime | `<NEW>-olares-runtime` | lean runtime |

The suffix is the only signal a future reader has about what is inside.

---

## 5. Verification — three runs, all mandatory

Mirror the real pod security context. Use throwaway dirs chowned to 1000.

### 5a. Standard run (proves the fork did not break the normal path)

```bash
rm -rf /tmp/v3a && mkdir -p /tmp/v3a/data /tmp/v3a/ws
docker run -d --name v3a -e PUBLIC_URL=https://dsh.example.com \
  -e AUTH_PASSWORD=testpassword123 \
  -v /tmp/v3a/data:/data -v /tmp/v3a/ws:/workspace \
  docker.io/technigmaai/deepseek-harness:<TAG>
sleep 42
docker inspect v3a --format '{{.State.Status}}'                                   # running
docker exec v3a curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz   # 200
docker exec v3a cat /etc/deepseek-harness-version                                 # DSH_VERSION=<NEW>
docker logs v3a 2>&1 | grep -cE 'ERROR|Error'                                     # 0
```

### 5b. Sandboxed run (patches 1 + 2 under test)

```bash
rm -rf /tmp/v3b && mkdir -p /tmp/v3b/data /tmp/v3b/ws && chown -R 1000:1000 /tmp/v3b
docker run -d --name v3b --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges \
  -e PUBLIC_URL=https://dsh.example.com -e AUTH_MODE=none -e AUTH_PASSWORD=testpassword123 \
  -v /tmp/v3b/data:/data -v /tmp/v3b/ws:/workspace \
  docker.io/technigmaai/deepseek-harness:<TAG>
sleep 42
docker inspect v3b --format '{{.State.Status}}'        # running (not exited:1)
docker exec v3b curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz
docker exec v3b sh -c 'gcc --version | head -1; go version; python3 --version'   # workstation only
```

### 5c. Plugin API probe (patch 3 + 4 under test) — the decisive check

```bash
docker exec v3b dsh plugin --profile web add @linxin666/dsh-client-ui-skill-explorer@latest
docker restart v3b && sleep 50
docker exec v3b curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8080/api/dsh-skill-explorer/list \
  -H 'Host: dsh.example.com' -H 'Origin: https://dsh.example.com'
```

* `AUTH_MODE=none` is required here so no login redirect masks the result.
* **200 = pass.** `400` = patch 3 missing/ineffective (or a stale autosave).
* Also assert **zero** plugin-tree errors:
  `docker logs v3b 2>&1 | grep -icE 'plugin tree failed|Cannot find package|does not provide'` → `0`.
* A `302` means you forgot `AUTH_MODE=none` (that is the auth wall, not a fault).

Clean up: `docker rm -f v3a v3b; rm -rf /tmp/v3a /tmp/v3b`.

---

## 6. Push and record

```bash
docker push docker.io/technigmaai/deepseek-harness:<TAG>
```

Confirm the digest that Docker Hub now serves, then record it:

```bash
curl -s "https://hub.docker.com/v2/repositories/technigmaai/deepseek-harness/tags/<TAG>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['name'], d['digest'])"
```

Append a row to the **Build history** table in `DOCKER-IMAGE-UPDATE.md`
(tag | base | DSH | digest + one-line note), and commit:

```bash
git add Dockerfile entrypoint-olares.sh DOCKER-IMAGE-UPDATE.md
git commit -m "deepseekharness fork: <NEW> base (<TAG>)"
git push origin main
```

The Docker Hub tag is immutable in practice — if you need to republish the same
version, use a suffix (`-2`) rather than overwriting (see next section).

---

## 7. Two traps that waste hours

**Node digest cache.** Nodes can keep serving an older digest for a tag you
just re-pushed, even with `pullPolicy: Always`, so the app appears not to
change. If the running pod's `imageID` does not match the Hub digest: push a
**fresh tag** (`<ver>-olares-2`), point the chart at it, bump the chart, and
delete the pod once. Do not keep deleting pods against a cached tag.

**`:latest` is a lie.** The builder's source pin has lagged before; `latest`
has pointed at an *older* DSH than a versioned tag. Fork **only versioned** tags.

---

## 8. Failure table

| Symptom | Cause | Fix |
|---|---|---|
| Container exits `1` with **no logs**, `/data` subdirs created | `gosu` still present → silent `set -e` death inside a command substitution | Re-apply patch 1 |
| `env: 'run_as_app': No such file or directory` | `run_as_app` (a shell function) placed after `env` | Use `"${APP_RUNNER[@]}" dsh …` on the launch line |
| `exec /usr/bin/caddy: Operation not permitted` (esp. under `--cap-drop ALL`) | File cap not stripped (patch 2) | `setcap -r /usr/bin/caddy`; runtime base needs `libcap2-bin` installed first |
| `install: cannot change owner … /data` | test harness only: mount dirs not owned by 1000 | `chown -R 1000:1000` the test dirs (in Olares the chart's initContainer does this) |
| Plugin route returns **400** (empty body) | Caddy forwarding a non-loopback Host, or stale autosave | Verify every block sets `header_up Host 127.0.0.1:{$DSH_INTERNAL_PORT}`; confirm the autosave `rm` exists and `/data/…/autosave.json` is regenerated |
| Plugin install rejected: *"is incompatible with dsh <ver>"* | DSH ≥ 0.2 plugin-manager compat gate; plugin peer ranges too old | Not an image fault — update the plugin, or `dsh plugin allow-version <pkg>@<ver>` |
| `Cannot find package '@deepseek-ai/…' imported from /data/dsh/profiles/web/` | A plugin install pruned a profile-local package that `cordis.patch.yml` references | Profile repair — see `MAINTENANCE.md` §5 (files-ops only) |
| Build fails on `setcap` with `Invalid argument` | `setcap -r f1 f2` needs `-r` **per file** | `setcap -r f1 -r f2` |
| Cap scan finds nothing on a runtime base | runtime images have no `getcap` | Scan workstation bases; on runtime bases test empirically (`--cap-drop ALL --entrypoint /usr/bin/caddy … version`) |
| `docker cp`/`export` shows no file caps | those preserve no xattrs | Scan **inside** a running image, never from an exported filesystem |

---

## 9. Current known-good reference

| Item | Value |
|---|---|
| Fork context | `olares-apps/deepseekharness/` (`Dockerfile`, `entrypoint-olares.sh`) |
| Live image tag | `0.2.0-rc.2-olares` |
| Live digest | `sha256:1b5f7331ea7cda8f2e4cebbec7ab8b1288aabf56bf420f6a5dc71f53302f6ac4` |
| Base used | `moelin/deepseek-harness:0.2.0-rc.2-workstation` |
| Drift at that release | none — the same 4 `gosu` sites and stock Caddyfiles; the existing patches applied unchanged |
| Consumed by chart | `deepseekharness-0.1.10` (`appVersion 0.2.0-rc.2`) |

Full published history (tag → base → digest) is the **Build history** table in
`DOCKER-IMAGE-UPDATE.md`; read it before assuming a build is missing.

---

## 10. Definition of done

- [ ] `FROM` points at a **versioned** upstream tag (not `latest`)
- [ ] `entrypoint-olares.sh` re-derived with asserts; diff shows only the 5 expected regions; autosave `rm` present
- [ ] File caps stripped for **every** binary the scan found (caddy always; mtr-packet on workstation)
- [ ] Build's final `RUN` verification passed (≥2 loopback `header_up Host` per Caddyfile)
- [ ] 5a root run: running, healthz 200, `DSH_VERSION` correct, 0 error lines
- [ ] 5b sandboxed run (`uid 1000` + `--cap-drop ALL` + `no-new-privileges`): running, healthz 200
- [ ] 5c plugin probe: **HTTP 200** on `/api/dsh-skill-explorer/list`, 0 plugin-tree errors
- [ ] Pushed to Docker Hub; digest confirmed from the API
- [ ] Build-history row added; files committed and pushed
- [ ] If the app was updated: chart bumped and applied via **uninstall + install** (in-place `upgrade` does **not** apply a changed `image.tag`)
