import type { SpoofHeaderProfiles } from "./core.ts";

/**
 * Single edit point for relay request-header impersonation.
 *
 * These headers are applied as follows:
 * - anthropic-messages: claude (or claudeLongContext at 1M+ context)
 * - openai-completions: claude
 * - openai-responses: codex
 *
 * CLI releases verified on 2026-10-31:
 * - https://github.com/anthropics/claude-code/releases/tag/v2.1.316
 * - https://github.com/openai/codex/releases/tag/rust-v0.166.0
 * Claude UA components and beta identifiers also checked in the 2.1.316 native npm package:
 * https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.316.tgz
 * Beta identifiers are protocol feature names, not CLI release dates; keep their published dates.
 *
 * Never add credentials (Authorization, Cookie, API keys) here.
 */
export const SPOOF_HEADER_PROFILES = {
	claude: {
		"user-agent": "claude-cli/2.1.316 (external, sdk-cli)",
		"x-app": "cli",
		"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
	},
	claudeLongContext: {
		"user-agent": "claude-cli/2.1.316 (external, sdk-cli)",
		"x-app": "cli",
		"anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
	},
	codex: {
		// Keep the fixed platform/terminal persona; upstream derives these from the runtime environment.
		// https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/login/src/auth/default_client.rs
		// https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/terminal-detection/src/lib.rs
		"user-agent": "codex_cli_rs/0.166.0 (Mac OS 15.7.7; arm64) ghostty/1.3.1",
	},
} satisfies SpoofHeaderProfiles;
