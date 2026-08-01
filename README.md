# olares-apps

A personal collection of Olares application charts (OAC) I've developed and
ported. Each app is a top-level folder containing the unpacked Helm chart
(`Chart.yaml`, `OlaresManifest.yaml`, `values.yaml`, `templates/`, …), laid out
the same way as the official [`beclab/apps`](https://github.com/beclab/apps)
repository.

The repo keeps the **unpacked source charts**; every packaged chart (`.tgz`) is
published as a **GitHub Release** (one per app/version). Icons are versioned in
[`assets/icons/`](assets/icons) and served via jsDelivr from this repo.

## Applications

| App | Title | Chart ver | App ver | Category | What it is |
|---|---|---|---|---|---|
| [elasticsearch](./elasticsearch) | Elasticsearch | 0.0.8 | 9.4.4 | Utilities | Distributed search & analytics engine (REST API, full-text search) |
| [nextaidrawio](./nextaidrawio) | Next AI Draw.io | 0.0.8 | 0.4.16 | Utilities | AI-powered diagramming — chat, draw, visualize |
| [outlineapp](./outlineapp) | Outline | 0.4.0 | 1.9.2 | Productivity | Fast, collaborative knowledge base / wiki for your team |
| [piagent](./piagent) | Pi Agent | 0.1.0 | 0.80.6 | Developer Tools | AI coding-agent CLI (read / bash / edit / write tools) |
| [postgresbackup](./postgresbackup) | Postgres Backup Local | 1.0.5 | 17 | Utilities | Periodic rotating PostgreSQL backups (`pg_dump`) |
| [visionbridge](./visionbridge) | VisionBridge | 0.4.1 | 0.2.0 | AI | Cross-vision OpenAI proxy: text-only LLMs get vision via a VLM |

## App notes

- **Elasticsearch** — the official Elasticsearch engine (single node) packaged
  as an Olares app. Security, SSL, license type, Java opts and disk watermarks
  are configurable in the app's Variables.
- **Next AI Draw.io** — AI-assisted diagram creation built around draw.io.
  Configure the AI provider/model and API keys in the app's Variables.
- **Outline** — a fast collaboration wiki/knowledge base with rich OIDC, Google
  and Slack sign-in options, plus SMTP, file-storage and rate-limiter settings.
- **Pi Agent** — the Pi coding-agent CLI. Ships its own `Dockerfile`; run it from
  the app terminal.
- **Postgres Backup Local** — rotating `pg_dump` backups of one or more
  PostgreSQL databases. Targets, schedule (`cron`), retention and optional
  webhook notifications are all configurable.
- **VisionBridge** — an OpenAI-compatible proxy that gives a text-only reasoning
  model vision by delegating image understanding to a separate vision (VLM)
  model. Every parameter (reasoning/vision endpoints + API keys, models, limits,
  `BRIDGE_API_KEYS` auth, advanced `EXTRA_MODELS`) is editable in the app's
  Variables.

## Releases

Each packaged chart is attached to a GitHub Release per app/version:

| Release | Asset |
|---|---|
| `elasticsearch-0.0.8` | `elasticsearch-0.0.8.tgz` |
| `nextaidrawio-0.0.8` | `nextaidrawio-0.0.8.tgz` |
| `outlineapp-0.4.0` | `outlineapp-0.4.0.tgz` |
| `piagent-0.1.0` | `piagent-0.1.0.tgz` |
| `postgresbackup-1.0.5` | `postgresbackup-1.0.5.tgz` |
| `visionbridge-0.4.1` | `visionbridge-0.4.1.tgz` |

## Layout

```
.
├── <app>/               # unpacked Olares application chart per app
│   ├── Chart.yaml
│   ├── OlaresManifest.yaml
│   ├── values.yaml
│   └── templates/
├── assets/icons/        # app icons (served via jsDelivr from this repo)
├── .gitignore           # ignores packaged *.tgz (they live on Releases)
└── README.md
```
