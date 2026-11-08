# Agent guide

## Project and layout

`pi-relay-models` is an ESM TypeScript extension for Pi. It discovers relay model IDs, matches official metadata, and routes each model through OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages.

- `extensions/index.ts`: public entry, re-exporting the extension implementation. Keep `package.json`'s `pi.extensions` pointed here; `package-layout.test.ts` protects this layout because a nested entry changes Pi's displayed package label.
- `extensions/relay-models/index.ts`: provider registration, commands, `relay_models` tool, configuration, and runtime integration.
- `core.ts` in that directory: model discovery, matching, mapping validation, URL normalization, and protocol selection.
- `catalog.ts`: pi.dev metadata retrieval, validation, caching, and local/remote catalog merging.
- `state.ts`: persisted JSON provider-entry cleanup; preserve unrelated entries.
- `usage.ts`: read-only historical session usage aggregation and deduplication.
- `header-profiles.ts`: centralized Claude/Codex compatibility headers.
- Tests are colocated as `extensions/relay-models/*.test.ts`, including integration tests.
- `README.md` is Chinese; `README.en.md` is English. Both document the public commands and tool behavior. Release notes are in `CHANGELOG.md`.

## Development and verification

Requirements from `package.json`: Node.js >=22.6 and Pi peer packages >=0.82.1. CI uses Node.js 24. The latest remote catalog can declare a higher minimum Pi runtime version; this is reported in catalog status.

| Command | Purpose |
| --- | --- |
| `npm install` | Install development dependencies locally |
| `npm ci` | Install locked dependencies, as CI does |
| `npm run check` | Type-check with `tsc --noEmit` |
| `npm test` | Run all colocated tests with Node's test runner and experimental TypeScript stripping |
| `npm run validate` | Run type-checking followed by tests; CI's validation command |
| `npm pack --dry-run` | Inspect published package contents, as the publish workflow does |

There is no separate build, lint, or formatting script/configuration. The package distributes TypeScript source directly.

Run `npm run validate` for code changes. Tests use `node:test` and `node:assert/strict`; network behavior uses local HTTP servers or mocked fetch, without real relay credentials. Integration tests isolate agent state in temporary directories: set `PI_CODING_AGENT_DIR` before dynamically importing the extension, because agent paths are captured at module initialization.

## Code conventions

- `tsconfig.json` enables strict checking, NodeNext modules/resolution, `verbatimModuleSyntax`, and an ES2022 target, with no emitted output.
- Use explicit `.ts` extensions for relative imports and `import type` for type-only dependencies, following existing source.
- Existing TypeScript uses tabs, double quotes, and semicolons. `.idea/` contains no shared code-style or inspection profiles; it is ignored by Git and supplies no additional conventions.

## Behavioral constraints

These constraints come from the READMEs, `SECURITY.md`, and the corresponding implementation/tests:

- Authentication belongs to Pi's `/login <provider-id>` flow. The AI tool and relay configuration must not accept API keys. Never add Authorization, cookies, or API keys to header profiles.
- Runtime state belongs in Pi's agent directory, not the repository. Do not commit `auth.json`, `relay-providers.json`, `models-store.json`, `models.json`, `relay-official-models.json`, `.env` files, or credential-bearing URLs. Configuration writes use temporary-file replacement and mode `0600`.
- Only relay-returned IDs become selectable models; the official catalog supplies metadata. Remote official metadata wins over matching local entries, with cached/local fallback on failure. GPT `-fast` IDs without an exact entry can inherit metadata from the OpenAI base ID (then OpenAI Codex) while preserving the remote ID. Other suggestions for unmatched IDs are for human review, not automatic fuzzy mappings.
- Explicit per-model protocol overrides take priority over inferred official-model routing; unmatched models use the provider fallback. Anthropic URLs strip a trailing `/v1` to avoid duplicate API paths.
- Batch mappings validate all entries and official references before saving anything, then save and refresh once. Keep metadata mappings and protocol overrides independently removable.
- Preserve the tool instructions requiring explicit approval of proposed `map`, `unmap`, `protocol`, `clear`, `exclude`, and `remove` changes. Provider removal is limited to providers managed by this extension.
- Usage scanning reads local history without networking or rewriting sessions. Group by requested model ID, preserve fork/clone deduplication, and avoid double-counting reasoning/cache subsets. Do not use `SessionManager` to scan history: opening it can migrate and rewrite files.

## CI and release

`.github/workflows/ci.yml` runs `npm ci` and `npm run validate` on pushes and pull requests. `publish.yml` publishes on `v*` tags after validation, checking that the tag matches `package.json` and inspecting the package with `npm pack --dry-run`; publishing uses npm provenance.
