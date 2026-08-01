# Pi Agent

The [Pi coding agent](https://github.com/earendil-works/pi) CLI (`pi`), installed
on Olares as an app. It is an **idle terminal app**: the container sits ready,
and you open the app's terminal to run `pi`.

> **Prebuilt image:** the deployment uses `docker.io/technigmaai/pi-agent:0.80.6`.
> A `Dockerfile` is included if you prefer to build your own image.

## First run — create the folder structure

1. Open the **Pi Agent** app (terminal entrance).
2. At the prompt run:
   ```sh
   pi
   ```
   On first run `pi` creates its data folder inside the app's Olares data
   directory:
   ```
   Data/piagent/.pi/agent/
   ├── bin/          # installed extension bins
   ├── sessions/     # your saved sessions
   ├── auth.json     # auth state
   ├── models.json   # LLM providers & models
   └── settings.json # defaults (provider / model)
   ```
   > `Data/piagent` is the Pi Agent app data on your Olares **Drive → Data**.

## Configure your LLM

`pi` needs at least one provider and a default model. Two files in
`Data/piagent/.pi/agent/` control this:

### 1. `models.json` — define providers & models

Create (or edit) `Data/piagent/.pi/agent/models.json` listing your OpenAI
compatible endpoints. Example (from a working Olares setup — two local LLM
servers):

```json
{
  "providers": {
    "local-llm-2": {
      "baseUrl": "http://<your-llm-host>:8000/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "compat": {
        "supportsUsageInStreaming": false
      },
      "models": [
        {
          "id": "gx10",
          "contextWindow": 524288,
          "maxTokens": 65536,
          "reasoning": true
        }
      ]
    },
    "local-llm": {
      "baseUrl": "http://<your-other-llm-host>:8000/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "compat": {
        "supportsUsageInStreaming": false
      },
      "models": [
        {
          "id": "rtx",
          "contextWindow": 256000,
          "maxTokens": 65536,
          "input": ["text", "image"],
          "reasoning": true
        }
      ]
    }
  }
}
```

- **`baseUrl`** — the OpenAI-compatible `/v1` endpoint of your LLM server.
- **`api`** — use `openai-completions` for standard OpenAI-compatible servers.
- **`apiKey`** — `"not-needed"` for local servers without auth.
- **`models[].id`** — the model name your server exposes.
- **`models[].input`** — set `["text", "image"]` on a vision-capable model.
- **`models[].reasoning`** — `true` (with a big `contextWindow`) for reasoning
  models.
- Follow the [Pi documentation](https://github.com/earendil-works/pi) for the
  full set of fields (thinking limits, tool filtering, etc.).

### 2. `settings.json` — pick a default provider & model

Edit `Data/piagent/.pi/agent/settings.json` so `pi` uses the right model by
default:

```json
{
  "lastChangelogVersion": "0.80.6",
  "defaultProvider": "local-llm-2",
  "defaultModel": "gx10"
}
```

- `defaultProvider` must be one of the provider keys you defined in
  `models.json`.
- `defaultModel` must be a model `id` under that provider.

After saving both files, run `pi` again (or restart the terminal session) — the
changes take effect on a fresh session. You can also switch interactively
(`~` in the Pi TUI or the model picker).
