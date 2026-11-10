import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, Api, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("command and AI sync fetch website metadata before relay discovery, retain it across session events and failures", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "relay-live-catalog-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = directory;
	await writeFile(join(directory, "relay-providers.json"), JSON.stringify({ version: 1, providers: [{
		id: "relay-test", name: "Relay Test", baseUrl: "https://relay.example/v1", protocol: "openai-completions",
	}] }));
	const stale: Model<Api> = {
		id: "claude-new-catalog-test", name: "New Model", provider: "anthropic", api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com", contextWindow: 100_000, maxTokens: 8192, reasoning: true,
		input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	};
	let contextWindow = 1_000_000;
	let offline = false;
	const calls: string[] = [];
	globalThis.fetch = async (url, options) => {
		if (String(url) === "https://pi.dev/api/models") {
			calls.push("official");
			assert.equal(new Headers(options?.headers).get("authorization"), null);
			if (offline) throw new Error("offline");
			return Response.json({ anthropic: { [stale.id]: { ...stale, contextWindow, maxTokens: 128_000 } } });
		}
		assert.equal(String(url), "https://relay.example/v1/models");
		assert.equal(new Headers(options?.headers).get("authorization"), "Bearer relay-secret");
		calls.push("relay");
		return Response.json({ data: [{ id: stale.id }, { id: "jev-1.14.0" }] });
	};
	const { default: extension } = await import("./index.ts");
	let provider!: Provider;
	let tool!: { execute(...args: unknown[]): Promise<{ details: unknown }> };
	let sessionStart!: (event: unknown, ctx: unknown) => void;
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	await extension({
		on(_event: string, handler: typeof sessionStart) { sessionStart = handler; },
		registerProvider(value: Provider) { provider = value; },
		registerTool(value: typeof tool) { tool = value; },
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, command); },
	} as unknown as ExtensionAPI);
	const notifications: string[] = [];
	const ctx = {
		ui: { setStatus() {}, notify(message: string) { notifications.push(message); } },
		modelRegistry: {
			getAll: () => [stale],
			async refresh() {
				// Support both the original store context and Pi 1.5.1's publication context.
				const refreshContext = {
					credential: { type: "api_key" as const, key: "relay-secret" }, allowNetwork: true,
					signal: new AbortController().signal,
					store: { async read() { return undefined; }, async write() {}, async delete() {} },
					async publish(publication: { update?: () => void }) {
						publication.update?.();
						return true;
					},
				};
				await provider.refreshModels!(refreshContext);
			},
		},
	};
	await commands.get("relay-sync")!.handler("", ctx);
	assert.deepEqual(calls, ["official", "relay"]);
	assert.equal(provider.getModels()[0]!.contextWindow, 1_000_000);
	assert.equal(provider.getModels()[0]!.maxTokens, 128_000);
	assert.equal(provider.getModels().length, 1);
	// SAFETY: optional method is absent on chat-only SDKs and present on classifier-capable SDKs.
	const allModels = (provider as unknown as { getAllModels?: () => Array<{ id: string; type?: string }> }).getAllModels?.();
	if (allModels) assert.ok(allModels.some((model) => model.id === "jev-1.14.0" && model.type === "classifier"));
	assert.match(provider.getModels()[0]!.headers!["anthropic-beta"]!, /context-1m/);
	sessionStart({}, ctx);
	await ctx.modelRegistry.refresh();
	assert.equal(provider.getModels()[0]!.contextWindow, 1_000_000);
	contextWindow = 2_000_000;
	await tool.execute("sync", { action: "sync" }, undefined, undefined, ctx);
	assert.equal(provider.getModels()[0]!.contextWindow, 2_000_000);
	assert.equal(calls.filter((call) => call === "official").length, 2);
	offline = true;
	await commands.get("relay-sync")!.handler("", ctx);
	assert.equal(provider.getModels()[0]!.contextWindow, 2_000_000);
	assert.ok(notifications.some((message) => message.includes("cached pi.dev") && message.includes("offline")));
});
