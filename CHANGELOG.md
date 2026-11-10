# Changelog

All notable changes to this project are documented here.

## Unreleased

- Discover relay-returned Jev models as native Pi classifiers under the existing provider and credentials, supporting codemode choice probabilities, boolean probabilities, and scores with confidence through System One.
- Keep Jev out of chat selection, report classifiers separately, respect exclusions, and retain chat support with an upgrade warning on SDKs without classifier support.

- Pin development dependencies to Pi 1.5.1 and validate both 0.82.1 and 1.5.1 in CI without raising the minimum supported version.
- Define tool enums with TypeBox literal unions to preserve parameter inference across Pi versions, and adapt the catalog integration fixture to the newer refresh publication context.
- Test that ordinary relay requests do not inherit Anthropic's default message-thread enablement, while preserving explicit catalog compatibility settings without mutating the source model.
- Document Pi 1.5.1 authentication commands, message-thread requirements, disabled-tool compatibility, and the built-in Responses affinity-header fix in both READMEs.

- Match relay GPT `-fast` variants to OpenAI base-model metadata when no exact entry exists, preserving remote IDs, explicit mappings, protocol overrides, and exclusions.

- Add `/relay-usage [provider-id]` to summarize local usage across projects and providers by requested model, including token totals, recorded estimated costs, copy deduplication, and unattributed usage, without network requests or history rewrites.
- Update Claude Code and Codex user-agent profiles to verified releases 2.1.316 and 0.166.0; keep protocol beta identifiers and the fixed Codex platform/terminal persona.
- Refresh relay metadata from the JSON catalog behind pi.dev/models before discovery, with forced checks for command/tool sync and a four-hour interval otherwise.
- Persist and revalidate the official catalog using ETags, preserve cached/local models when updates fail, and report catalog freshness and fallback warnings.
- Preserve catalog revision and minimum pi version headers across caching, and warn when the host runtime is too old for the latest website catalog.

## 0.5.0 - 2026-08-10

- Replace count-only relay match reports with `matchedModels` and `unmatchedModels` entries that expose every model ID, metadata source, effective protocol, and unmatched candidates.
- Render `status` and `sync` as a compact model-oriented preview so up to 12 model routes are visible without expanding the full JSON result.
- Enforce Pi's standard 2,000-line/50KB tool-content limit, persist oversized full results to a temporary JSON file, and keep complete details available through explicit terminal expansion.

## 0.4.0 - 2026-08-07

- Add `relay_models action=unmap` for removing selected metadata mappings and `action=clear` for removing selected protocol overrides, with single-model and batch support.
- Collapse `relay_models` terminal results to an eight-line preview with a `Ctrl+O` expansion hint; the full structured result remains available when expanded.

## 0.3.0 - 2026-08-02

- Add `relay_models action=remove` and `/relay-remove` to unregister a managed relay and clean up its persisted credential and model cache.
- Support atomic batch `map` operations through the `mappings` tool parameter, with one validation, configuration save, and model refresh per batch.
- Allow a top-level mapping protocol default with optional per-entry overrides while preserving the existing single-model API.

## 0.2.0 - 2026-07-28

- Support batch `exclude` and `include` operations through the `remoteModelIds` tool parameter.
- Use a root package extension entry so Pi displays the clean `pi-relay-models` label.

## 0.1.1 - 2026-07-26

- Recommend npm as the installation source in the user documentation.
- Publish npm releases automatically from matching Git version tags through GitHub Actions and trusted publishing.

## 0.1.0 - 2026-07-26

- Discover model IDs from OpenAI- and Anthropic-compatible relay endpoints.
- Reuse model metadata from pi's official catalog.
- Route models through Chat Completions, Responses, or Messages within one provider.
- Store API keys exclusively through pi's `/login` credential flow.
- Persist user-approved metadata mappings, protocol overrides, and exclusions.
- Apply configurable Claude and Codex request-header profiles.
