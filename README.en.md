# pi-relay-models

[中文](README.md)

A mixed-protocol relay extension for [pi](https://github.com/earendil-works/pi-mono). It discovers relay models, reuses metadata from pi's official catalog, and selects OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages per model within one provider.

## Features

- Discovers model IDs from a compatible `/models` endpoint.
- Reuses official names, reasoning capabilities, input modalities, pricing, context windows, output limits, thinking maps, and compatibility settings by exact model ID.
- Routes Claude models through Anthropic Messages, newer OpenAI models through Responses, and other models through Chat Completions by default.
- Adds unmatched models with conservative fallback metadata and suggests nearby official candidates for review.
- Persists user-approved metadata mappings, per-model protocol overrides, and model exclusions.
- Keeps API keys in pi's `/login` credential flow, outside AI context and extension configuration.
- Centralizes optional Claude/Codex request-header profiles.

## Requirements

- pi `0.82.1` or newer; the latest website catalog may require a newer runtime. Use a pi version that meets `minimumPiVersion` in catalog status (currently pi `1.2.1` or newer).
- Node.js `22.6` or newer
- An OpenAI- or Anthropic-compatible relay that exposes a model list

## Installation

Install from npm (recommended):

```bash
pi install npm:pi-relay-models
```

Then reload pi:

```text
/reload
```

Do not keep a manually installed `~/.pi/agent/extensions/relay-models/` copy at the same time, because the tools and commands would be registered twice.

To try the package without changing settings:

```bash
pi -e npm:pi-relay-models
```

## Usage

Start the interactive setup:

```text
/relay-add
```

The wizard creates a provider and prompts you to run:

```text
/login <provider-id>
```

Enter the API key only in `/login`'s secret prompt. Never send it in chat. After login, use:

```text
/relay-sync
/relay-list
```

`/relay-sync` and the AI tool's `sync` action first force a check of the [JSON catalog](https://pi.dev/api/models) behind [pi.dev/models](https://pi.dev/models), then fetch the relay's actual model IDs and match metadata. Normal model discovery checks the website every four hours, using ETags to avoid redundant downloads. Website metadata takes precedence over stale local entries, including pricing, context windows, output limits, thinking maps, and compatibility settings.

Successful downloads are cached in `relay-official-models.json` in the agent directory and restored on restart. If the website is unavailable or returns invalid data, discovery keeps the last successful cache, falling back to the local pi catalog when no cache exists. Sync results show a warning; the `officialCatalog` field in `status` / `sync` includes the source, model count, fetch/check times, catalog `revision`, `minimumPiVersion`, host `runtimeVersion`, and warning. Older runtimes receive an upgrade warning while retaining the latest website catalog. The website supplies metadata; selectable models still depend on the relay's returned list.

Remove a relay provider together with its credential and model cache:

```text
/relay-remove <provider-id>
```

In interactive mode, omit the provider ID to select one from a list. The command asks for confirmation before removal.

The extension also registers a `relay_models` AI tool with these actions:

| Action | Purpose |
| --- | --- |
| `add` | Add or update a relay provider |
| `remove` | Remove a relay, its runtime registration, credential, and model cache |
| `sync` | Refresh models and match official metadata |
| `status` | Inspect provider, matching, and routing status |
| `map` | Save a user-approved official metadata mapping |
| `unmap` | Remove one or more official metadata mappings |
| `protocol` | Override one model's protocol |
| `clear` | Clear one or more protocol overrides and restore automatic routing |
| `exclude` | Persistently exclude one or more models |
| `include` | Restore one or more excluded models |

`unmap`, `clear`, `exclude`, and `include` accept `remoteModelId` for one model or a `remoteModelIds` array for a batch. `unmap` removes only official metadata mappings, while `clear` removes only protocol overrides; each operation restores the corresponding automatic behavior. A batch saves the configuration and refreshes the model list only once.

`map` supports both the existing single-model fields and an atomic `mappings` batch. A top-level `protocol` acts as the batch default, while each mapping may override it:

```json
{
  "action": "map",
  "providerId": "relay-example",
  "protocol": "openai-completions",
  "mappings": [
    {
      "remoteModelId": "model-alias-a",
      "officialProvider": "openai",
      "officialModelId": "gpt-5.4"
    },
    {
      "remoteModelId": "model-alias-b",
      "officialProvider": "anthropic",
      "officialModelId": "claude-sonnet-4-6",
      "protocol": "anthropic-messages"
    }
  ]
}
```

The extension validates the entire batch and every official model reference before mutation. If any entry is invalid, nothing is saved; otherwise the configuration is saved and the model list is refreshed only once.

`map`, `unmap`, `protocol`, `clear`, `exclude`, and `remove` are persistent changes. The tool instructions require every proposed change to be shown and explicitly approved before invocation. `unmap` and `clear` require `providerId` plus at least one remote model ID; `remove` only removes relay providers managed by this extension.

Collapsed `status` and `sync` results show the provider summary and up to 12 models directly. Matched models include their official metadata source and effective protocol; unmatched models include their fallback protocol. Use pi's tool-output expansion shortcut (`Ctrl+O` by default) to see additional models and the complete structured result. Other actions still show an eight-line preview with an expansion hint.

Status reports return per-model details in `matchedModels` and `unmatchedModels` arrays instead of a match count alone. Each `matchedModels` entry includes the remote model ID, official metadata source, and effective protocol; `unmatchedModels` entries also include suggested official candidates. Tool content sent to the model follows Pi's 2,000-line/50KB limit; oversized results are saved as temporary JSON with the path included in the result, while explicit terminal expansion still renders the complete structure.

## Usage statistics

After updating the extension, run `/reload` in pi, then use:

```text
/relay-usage [provider-id]
```

Omit the provider ID to include all recorded providers: built-in providers, relays, and relays whose configuration has been removed. Supply an ID to filter to that provider. Relays in the current configuration show friendly names. `/session` covers only the current session.

The command recursively scans `getAgentDir()/sessions` across all projects, plus the active session directory, active file, and current in-memory entries. It only reads local JSONL, with no network requests or history rewrites. The default root is `~/.pi/agent/sessions`, honoring `PI_CODING_AGENT_DIR`. Other custom history locations are discovered only through the active directory or file; old arbitrary external directories are not found automatically.

Results group by provider and requested model ID (not `responseModel`), showing input, output, cache-read/write tokens, the sum of those four categories, recorded estimated USD cost, and record count. `reasoning` and `cacheWrite1h` are subsets and are not added twice.

Fork/clone copies are deduplicated without using `parentId` in their identity; all branches and history before compaction count. Tool/summary usage missing provider or model information appears in a separate unattributed bucket and is never assigned to the filtered provider. Deleted or missing usage cannot be recovered; estimates may differ from relay billing, and old migrated/copied identities cannot always be proven perfectly.

## Mixed-protocol routing

Each relay provider registers all three APIs:

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

When an official catalog match exists, the extension infers the protocol from that model. A manual protocol override has the highest priority. Unmatched models use the provider fallback protocol.

For Anthropic models, a trailing `/v1` is removed from the Base URL to prevent SDK requests to `/v1/v1/messages`.

## Configuration and credentials

The extension uses pi's agent directory and maintains:

- `relay-providers.json`: provider URLs, mappings, protocol overrides, and exclusions; mode `0600`
- `models-store.json`: model cache managed by pi
- `relay-official-models.json`: the extension's cached pi.dev metadata catalog
- `auth.json`: credentials managed by pi's `/login`

`relay-providers.json` never contains API keys. Do not commit these local files.

## Header profiles

Fixed request headers are centralized in:

```text
extensions/relay-models/header-profiles.ts
```

Default routing:

- Anthropic Messages uses `claude`, or `claudeLongContext` at a 1M context window
- OpenAI Chat Completions uses `claude`
- OpenAI Responses uses `codex`

These profiles are intended for relays that require client-specific compatibility headers. Verify your endpoint's terms and compatibility before use. Never add Authorization, cookies, or API keys to this file.

## Development

```bash
npm install
npm run validate
```

The tests only start a temporary local HTTP server and do not call a real relay.

## License

[MIT](LICENSE)
