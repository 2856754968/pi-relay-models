import assert from "node:assert/strict";
import test from "node:test";
import { stream, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { materializeRelayModels } from "./core.ts";

const relay = {
	id: "relay-compat-test",
	name: "Compatibility Test Relay",
	baseUrl: "https://relay.example/v1",
	protocol: "anthropic-messages" as const,
};

function officialModel(compat?: Model<Api>["compat"]): Model<Api> {
	return {
		id: "claude-compat-test",
		name: "Claude Compatibility Test",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	};
}

test("an official Anthropic match does not enable message threads on an ordinary relay", async (t) => {
	const source = officialModel();
	const { models: [model] } = materializeRelayModels(relay, [source.id], [source]);
	assert.equal(model.provider, relay.id);
	assert.equal(model.baseUrl, "https://relay.example");
	const requests: Record<string, unknown>[] = [];
	const mockFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		// Stop after recording the actual SDK request; no network or credentials are used.
		return new Response(JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "Request captured by test" },
		}), { status: 400, headers: { "content-type": "application/json" } });
	};
	// Older Pi versions use global fetch rather than the per-request option.
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = mockFetch;
	const result = await stream(model, {
		messages: [{ role: "user", content: "Hello", timestamp: 0 }],
	}, {
		apiKey: "test-placeholder",
		sessionId: "relay-message-thread-boundary",
		cacheRetention: "short",
		maxRetries: 0,
		fetch: mockFetch,
	}).result();
	assert.equal(result.stopReason, "error");
	assert.equal(requests.length, 1, result.errorMessage ?? "Expected an SDK request");
	assert.equal(Object.hasOwn(requests[0], "thread"), false);
	assert.ok(Array.isArray(requests[0].messages));
	assert.equal(source.provider, "anthropic");
	assert.equal(source.baseUrl, "https://api.anthropic.com");
});

test("explicit catalog compatibility is preserved without sharing mutable state", () => {
	// Use a variable so newer compat fields also compile on the minimum supported Pi.
	const compat = { forceAdaptiveThinking: true, supportsMessageThreads: false };
	const source = officialModel(compat);
	const { models: [model] } = materializeRelayModels(relay, [source.id], [source]);
	assert.deepEqual(model.compat, compat);
	assert.notEqual(model.compat, source.compat);
	assert.ok(model.compat && "forceAdaptiveThinking" in model.compat);
	model.compat.forceAdaptiveThinking = false;
	assert.deepEqual(source.compat, { forceAdaptiveThinking: true, supportsMessageThreads: false });
});
