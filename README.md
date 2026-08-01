# olares-apps

Olares application charts (OAC) for apps I've developed / ported, in the
[`beclab/apps`](https://github.com/beclab/apps) layout — one top-level folder per
application containing the unpacked Helm chart (`Chart.yaml`,
`OlaresManifest.yaml`, `values.yaml`, `templates/`, …).

## Applications

| App | Chart version | Notes |
| --- | --- | --- |
| elasticsearch | 0.0.8 | |
| nextaidrawio | 0.0.8 | |
| outlineapp | 0.4.0 | |
| piagent | 0.1.0 | includes `Dockerfile` |
| postgresbackup | 1.0.5 | |
| visionbridge | 0.1.4 | |

## Releases

Each packaged chart (`.tgz`) is published as a **GitHub Release** per
application/version — e.g. `outlineapp-0.4.0`. The repository tree itself only
contains the unpacked source charts.
