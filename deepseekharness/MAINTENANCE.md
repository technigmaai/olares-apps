# DeepSeek Harness — Olares Maintenance Guide (pick-me-up-next-time)

This is the single document to read when you need to **(A) create a new
container image** (upstream DSH released a newer version) or **(B) upgrade the
Olares app package** (the chart). It is written for a fresh session with no
prior context: it states the current world, the *why* behind every patch, the
exact commands, the traps that actually bit us, and the verification checklist
that proves it works.

Companion runbooks (same folder):
- `DOCKER-IMAGE-UPDATE.md` — docker-image-only update (slim)
- `IMAGE-UPDATE.md` — image + chart full runbook (older; this file supersedes
  its "what the fork changes" section — read this first)

---

## 0. Current state (verify before you act)

| Item | Value |
|---|---|
| Olares app name | `deepseekharness` (folder/appid; **no hyphens allowed** — constraint `^[a-z0-9]{1,30}$`) |
| Chart | `deepseekharness-0.1.7` (apiVersion v2, appVersion `0.1.5-rc.2`) |
| OlaresManifest | `version 0.1.7`, `spec.versionName 0.1.5-rc.2` |
| Image repo | `docker.io/technigmaai/deepseek-harness` |
| Image tag (live) | `0.1.5-rc.2-olares-2` |
| Live image digest | `sha256:cc550379c3c250c09d6ebd8a3d277dba4ef639cc58891d50b5d7673d7ea9c38f` |
| pullPolicy | `Always` |
| DSH version in image | `0.1.5-rc.2` (from `moelin/deepseek-harness:0.1.5-rc.2-workstation`) |
| Auth mode | `caddy-security` (AUTH_USERNAME=`technigmaai`, AUTH_PASSWORD=user secret, AUTH_TOKEN_LIFETIME=`2592000`) |
| State (last checked) | `running` |

**Storage mapping** (deployment hostPath → container):
| Container path | Olares source | Notes |
|---|---|---|
| `/data` | `userspace.appData` | DSH state: `/data/auth` (caddy-security identity + JWT), `/data/caddy` (Caddy autosave), `/data/dsh` (profiles, plugins, sessions) |
| `/home/node` | `userspace.userData` | `$HOME` for the `node` user (uid 1000) |
| `/workspace` | `userspace.appData/workspaces` | DSH workspace root |

An `initContainer` (`beclab/aboveos-busybox`, root) runs
`chown 1000:1000 /data /home/node /workspace` before the main container (uid 1000,
`capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`).

**Installed plugins** (persisted in `/data/dsh/profiles/web/package.json`,
survive reinstalls because `/data` is on appData):
- `@linxin666/dsh-client-ui-skill-explorer` (Skill Center panel — **requires DSH >= 0.1.5-rc.1**)
- `dsh-at-mention` (@ file/session mentions)
- `dsh-session-recycle-bin` (github:technigmaai/...)
- `dshmarket`

**Commands you will use** (from the session host; `olares-cli` is on PATH):
```bash
# app state
olares-cli market status deepseekharness -s upload
# pod + live image digest
olares-cli cluster pod list -n deepseekharness-technigmaai
POD=<deepseekharness-pod>; olares-cli cluster pod yaml deepseekharness-technigmaai/$POD | grep imageID
# read a persisted file (e.g. Caddy autosave, plugin manifest)
olares-cli files cat drive/Data/deepseekharness/caddy/config/caddy/autosave.json
olares-cli files cat drive/Data/deepseekharness/dsh/profiles/web/package.json
# delete a stale persisted file
olares-cli files rm -f drive/Data/deepseekharness/caddy/config/caddy/autosave.json
```

---

## 1. The big picture — WHY the image has 4 patches (the 400 you must not regress)

The DSH plugin API routes (e.g. Skill Center's `/api/dsh-skill-explorer/*`)
used to return **"Failed to load: HTTP 400"**. Root-cause chain, in order:

1. **DSH's webserver accepts ONLY a loopback `Host` header for
   plugin-registered `/api` routes.** Any domain / pod-IP `Host` → empty `400`.
   (Core DSH routes accept any Host — that's why only plugins showed it.)
2. **The stock Caddyfiles forward the public authority**
   (`$DSH_UPSTREAM_HOST` = the entrance domain) as `Host` → every plugin API
   call 400s.
3. **The caddy-security Caddyfile's *main* route had NO `Host` line at all**,
   so the browser's public `Host` passed through verbatim → 400. (A patch that
   only fixed the `@settings_api` route is NOT enough.)
4. **Caddy persists a compiled config** at `/data/caddy/config/caddy/autosave.json`.
   If you change the Caddyfile in the image but a stale autosave is already in
   `/data`, Caddy keeps serving the OLD routing → your fix "doesn't work".

The DSH plugin trust fence (`isLoopbackRequest`) requires **all three**: socket
is loopback **AND** `Host` header is loopback **AND** `Origin` (if present) ==
`Host`. Caddy sits on container loopback and enforces the public-origin
boundary itself, so the correct shape to forward is:
`Host: 127.0.0.1:3080` + `Origin: http://127.0.0.1:3080`.

**Therefore the fork applies 4 patches over the upstream image:**
1. **Entrypoint non-root**: `gosu` can't switch users without root; run DSH/Caddy
   as the current user (uid 1000) when unprivileged. (`entrypoint-olares.sh`,
   `APP_RUNNER` + `run_as_app`.)
2. **Strip file capabilities**: `setcap -r /usr/bin/caddy -r /usr/bin/mtr-packet`
   (execve of a file-cap binary fails EPERM under an empty capability set).
3. **Caddyfile loopback Host/Origin on EVERY `reverse_proxy` block** in both
   `/etc/caddy/Caddyfile` and `/etc/caddy/Caddyfile.passthrough` (the
   `@settings_api` route *and* the main `route`). See `Dockerfile`.
4. **Entrypoint self-heal the Caddy autosave**: `rm -f
   "${CADDY_DATA_HOME}/config/caddy/autosave.json"` before `caddy run`, so the
   image's Caddyfile is always authoritative (patch 3 can't be masked by a
   stale persisted config).

> If you ever see a plugin route 400 again, the first thing to check is
> **which** of patches 3/4 regressed (stale autosave, or a Caddyfile route
> missing the loopback Host), per §5.

---

## 2. Workflow A — Create a new container image (upstream DSH updated)

Trigger: `moelin/deepseek-harness` published a newer version (or a newer
`-workstation`/runtime base you want).

### A1. Find the newest base
```bash
# Docker Hub (only source you can build from)
curl -s "https://hub.docker.com/v2/repositories/moelin/deepseek-harness/tags?page_size=50" \
  | python3 -c "import json,sys; [print(t['name'],'|',(t.get('tag_last_pushed') or '')[:10]) for t in json.load(sys.stdin).get('results',[])]"
# Upstream leading edge (Hub lags these): GitHub releases + npm dist-tags
curl -s "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=5" \
  | python3 -c "import json,sys; [print(r['tag_name']) for r in json.load(sys.stdin)]"
```
Rules: pin a **versioned** tag (never `:latest` — builder source pin lags);
prefer `-workstation`; if a release is runtime-only, say so (toolchain loss).
Check any installed plugin's required DSH engine (e.g. skill-explorer needs
`>= 0.1.5-rc.1`) and pick a base that satisfies it.

### A2. Pull + re-derive the entrypoint patch
```bash
NEW=<ver>; BASE=moelin/deepseek-harness:$NEW-workstation   # or :$NEW for runtime
docker pull $BASE
docker create --name dsh-extract $BASE
docker cp dsh-extract:/usr/local/bin/entrypoint.sh /tmp/entrypoint-new.sh
docker rm dsh-extract
grep -n 'gosu' /tmp/entrypoint-new.sh        # expect the 4 call sites
```
Re-run the **asserting patch script** from `DOCKER-IMAGE-UPDATE.md` §2.2
(replaces the 4 `gosu` call sites with `run_as_app`/`APP_RUNNER`). Then,
because the fork entrypoint also carries the **autosave self-heal** (patch 4),
make sure `entrypoint-olares.sh` still contains:
```sh
rm -f "${CADDY_DATA_HOME}/config/caddy/autosave.json"
```
immediately before the `caddy run` line (it is in the current
`entrypoint-olares.sh`; if you re-derived from a fresh upstream entrypoint you
must re-add it). Sanity: `diff entrypoint-olares.sh /tmp/entrypoint-new.sh`
should show only the gosu hunks + the autosave `rm`.

### A3. Scan file-capability binaries
Workstation base (has `getcap`):
```bash
docker run --rm --entrypoint sh $BASE -c 'for d in /usr/bin /usr/local/bin /usr/sbin /bin /opt/dsh/node_modules/.bin; do find "$d" -maxdepth 3 -type f -exec getcap {} + 2>/dev/null; done | grep -v "^$"'
```
Expect `caddy cap_net_bind_service=ep` + `mtr-packet cap_net_raw=ep`; add any
new ones to the `setcap -r` list (one `-r` per file). Runtime base has no
`getcap`/`setcap` — test empirically (caddy EPERM under `--cap-drop ALL`) and
install `libcap2-bin` in the Dockerfile.

### A4. Write the Dockerfile (all 4 patches)
Base it on the current `Dockerfile` in this folder. It must contain:
`FROM <BASE>` → `RUN setcap -r ...` → `COPY entrypoint-olares.sh ...` → the
**Caddyfile python patch** (replaces `$DSH_UPSTREAM_HOST` Host and injects
loopback Host+Origin into every `reverse_proxy` block lacking one) → verify
with `grep -c 'header_up Host 127.0.0.1'` (≥2 per file). Keep the file's
comment block accurate.

### A5. Build + verify
```bash
docker build -t docker.io/technigmaai/deepseek-harness:$NEW-olares .
```
Verify per `DOCKER-IMAGE-UPDATE.md` §3 (standard root run, sandboxed
uid-1000/drop-ALL run, and the **plugin `/list` probe** which must return 200).

### A6. Push
```bash
docker push docker.io/technigmaai/deepseek-harness:$NEW-olares
```
**Digest-cache trap:** if the node keeps serving a stale digest for a tag you
just re-pushed, push a **fresh tag** (e.g. `$NEW-olares-2`) and point the chart
at it. That is why the live tag is currently `-olares-2`.

### A7. Wire it into the chart
→ continue to **Workflow B** with `image.tag` set to the new tag.

---

## 3. Workflow B — Upgrade the Olares app package (the chart)

### B1. Bump the version in three places
```bash
cd olares-apps/deepseekharness
# values.yaml: image.tag -> new tag (if the image changed)
# Chart.yaml:   version: 0.1.x  -> 0.1.(x+1)
# OlaresManifest.yaml: metadata.version + spec.versionName (keep them equal to Chart.yaml / appVersion)
```

### B2. Lint / package / upload
```bash
olares-cli chart lint .
olares-cli chart package .            # -> deepseekharness-0.1.(x+1).tgz
olares-cli market upload ./deepseekharness-0.1.(x+1).tgz
```

### B3. Apply
```bash
olares-cli market upgrade deepseekharness -s upload --version 0.1.(x+1) --watch
```
If the app is **not in an upgradable state** (`running`/`stopped`/`upgradeFailed`
are OK; `installing`/`initializing`/`uninstalling` are not), you may need to let
the in-flight op finish or do `uninstall` then `install`:
```bash
olares-cli market uninstall deepseekharness
olares-cli market install deepseekharness -s upload --version 0.1.(x+1) \
  --env AUTH_USERNAME=technigmaai --env AUTH_PASSWORD=<user secret> --env AUTH_TOKEN_LIFETIME=2592000
```
> `install`/`upgrade`/`clone` take `-s upload`; `uninstall`/`upload` do **not**
> expose `-s`. If you re-created the app from scratch, re-supply the `--env`
> values (required vars are not remembered across uninstall).

### B4. Verify the pod is on the intended image
```bash
NS=deepseekharness-technigmaai
POD=$(olares-cli cluster pod list -n $NS | awk '/^deepseekharness-/{print $1}')
olares-cli cluster pod yaml $NS/$POD | grep imageID
```
**If the digest is stale** (node served an old digest for the tag): push a fresh
image tag, bump `values.yaml` to it, re-package/upload/upgrade — *and* delete the
pod once so it re-pulls. Confirm the new `imageID` matches the intended digest.

---

## 4. Changing the app user / resetting auth (only if needed)

caddy-security keys its identity store on `AUTH_USERNAME` + a fixed internal
email, so **changing `AUTH_USERNAME` after install collides** ("email is
registered to a user, while username not found") and crash-loops the app.
To change the username (or after a botched auth change), reset the identity
store so it re-provisions cleanly:
```bash
olares-cli files rm -f drive/Data/deepseekharness/auth/users.json
```
then restart the app. (Password-only changes are fine — the hash is overwritten.)

---

## 5. Troubleshooting the traps (in the order to check)

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin route `400` (panel "Failed to load: HTTP 400") | Caddy forwarding a non-loopback `Host` to DSH | Confirm patch 3 is in the running Caddyfile/autosave; see below |
| Fix "doesn't work" after image update | **Stale Caddy autosave** in `/data` masking the new Caddyfile | `olares-cli files rm -f drive/Data/deepseekharness/caddy/config/caddy/autosave.json`, restart (patch 4 self-heals on boot) |
| Pod keeps an old digest after re-push | Node tag→digest cache | Push a **fresh tag** (`-2`), bump chart, delete pod |
| `market` op stuck (`uninstalling`/`upgrade`, "opID not found in response data") | Market backend wedged | `olares-cli cluster workload restart --kind deployment market-deployment -n os-framework --yes`; if still stuck, `olares-cli cluster workload restart --kind statefulset app-service -n os-framework --yes` (drives namespace teardown). Then `uninstall` → re-`upload` chart → `install` |
| Username change crash-loops | caddy-security identity-store collision | Delete `drive/Data/deepseekharness/auth/users.json`, restart (§4) |
| Plugin "does not provide an export / engine" error at boot | DSH version older than the plugin's required engine | Pick a base image whose DSH satisfies the plugin (§2 A1) |

**To inspect the live Caddy routing** (proves patch 3 is active):
```bash
olares-cli files cat drive/Data/deepseekharness/caddy/config/caddy/autosave.json \
 | python3 -c "
import json,sys
d=json.load(sys.stdin); out=[]
def walk(o):
    if isinstance(o,dict):
        if o.get('handler')=='reverse_proxy': out.append(o)
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d)
for i,rp in enumerate(out):
    s=rp.get('headers',{}).get('request',{}).get('set',{})
    print(f'rp#{i}: Host={s.get(\"Host\")} Origin={s.get(\"Origin\")}')
"
```
You want **every** `reverse_proxy` to show `Host=127.0.0.1:3080`
`Origin=http://127.0.0.1:3080`. If any shows a public domain or `None`, that
route is missing the loopback patch → the plugin routes behind it will 400.

---

## 6. Verification checklist (run after any A or B)

- [ ] `olares-cli market status deepseekharness -s upload` → `State: running`
- [ ] `cluster pod yaml ... | grep imageID` → matches the **intended** digest
- [ ] Caddy autosave probe (§5) → all `reverse_proxy` set loopback Host/Origin
- [ ] Plugin manifest intact: `files cat drive/Data/deepseekharness/dsh/profiles/web/package.json`
- [ ] DSH version sane: `files cat drive/Data/deepseekharness/dsh/profiles/web/...` or pod logs show `DSH_VERSION=<expected>`
- [ ] In the browser: Skill Center (and any other plugin panel) loads without "Failed to load: HTTP 400"

## 7. Repo layout (where things live)

```
olares-apps/
  deepseekharness/
    Chart.yaml  OlaresManifest.yaml  values.yaml
    templates/ (deployment, service, terminal, ...)
    Dockerfile            # the 4-patch fork build
    entrypoint-olares.sh  # gosu->APP_RUNNER patch + Caddy autosave self-heal
    MAINTENANCE.md        # <- this file
    DOCKER-IMAGE-UPDATE.md  # image-only runbook
    IMAGE-UPDATE.md         # image+chart runbook (pre-400-fix; superseded by this file for the fork)
    deepseekharness-0.1.x.tgz  (gitignored; published as GitHub Releases)
  assets/icons/deepseekharness.png
```
Packaged `.tgz` files are published as **GitHub Releases** (`technigmaai/olares-apps`),
one per app/version; the repo itself does not commit the `.tgz`.
