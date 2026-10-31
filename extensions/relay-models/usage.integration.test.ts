import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Exercise the registered command, including default history, a custom directory,
// an active file elsewhere, in-memory entries, provider filtering, and no network.
test("relay-usage reports all history through the extension command without changing files or fetching", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "relay-usage-command-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
	await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	await writeFile(join(process.env.PI_CODING_AGENT_DIR, "relay-providers.json"), JSON.stringify({
		version: 1, providers: [{ id: "relay-test", name: "Relay Test", baseUrl: "https://relay.example/v1", protocol: "openai-completions" }],
	}));
	let fetches = 0;
	globalThis.fetch = async () => { fetches++; throw new Error("Usage reporting must be offline"); };
	const makeEntry = (id: string, provider = "relay-test") => ({
		type: "message", id, parentId: null, timestamp: "2026-10-31T00:00:00.000Z",
		message: { role: "assistant", provider, model: "model-a", content: [], timestamp: 1,
			usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16, cost: { total: 0.01 } } },
	});
	const defaultDir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "project-a");
	const customDir = join(directory, "custom");
	await mkdir(defaultDir, { recursive: true });
	await mkdir(customDir);
	const defaultFile = join(defaultDir, "history.jsonl");
	const customFile = join(customDir, "history.jsonl");
	const activeFile = join(directory, "active.jsonl");
	const writeSession = async (path: string, entries: unknown[]) => {
		const text = [JSON.stringify({ type: "session", version: 1, id: path }), ...entries.map((entry) => JSON.stringify(entry))].join("\n");
		await writeFile(path, text);
		return text;
	};
	const saved = await writeSession(defaultFile, [makeEntry("default"), makeEntry("old", "removed-relay")]);
	await writeSession(customFile, [makeEntry("custom")]);
	const activeEntry = makeEntry("active");
	await writeSession(activeFile, [activeEntry]);
	const { default: extension } = await import("./index.ts");
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	await extension({
		on() {}, registerProvider() {}, registerTool() {},
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, command); },
	} as unknown as ExtensionAPI);
	const notifications: Array<{ text: string; type: string }> = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		ui: { setStatus(_key: string, text?: string) { statuses.push(text); }, notify(text: string, type: string) { notifications.push({ text, type }); } },
		sessionManager: { getSessionDir: () => customDir, getSessionFile: () => activeFile,
			getEntries: () => [activeEntry, makeEntry("memory")] },
	};
	const command = commands.get("relay-usage");
	assert.ok(command);
	await command.handler("", ctx);
	assert.equal(notifications.at(-1)?.type, "info");
	const all = notifications.at(-1)!.text;
	assert.match(all, /TOTAL: Total 80/);
	assert.match(all, /Relay Test \(relay-test\): Total 64/);
	assert.match(all, /removed-relay: Total 16/);
	assert.match(all, /3 session files/);
	assert.equal(statuses.at(-1), undefined);
	await command.handler("relay-test", ctx);
	assert.match(notifications.at(-1)!.text, /TOTAL: Total 64/);
	assert.doesNotMatch(notifications.at(-1)!.text, /removed-relay: /);
	await command.handler("removed-relay", ctx);
	assert.match(notifications.at(-1)!.text, /TOTAL: Total 16/);
	await command.handler("bad argument", ctx);
	assert.equal(notifications.at(-1)?.type, "error");
	assert.match(notifications.at(-1)!.text, /Usage: \/relay-usage/);
	ctx.sessionManager.getEntries = () => { throw new Error("session unavailable"); };
	await command.handler("", ctx);
	assert.equal(notifications.at(-1)?.type, "error");
	assert.match(notifications.at(-1)!.text, /session unavailable/);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(fetches, 0);
	assert.equal(await readFile(defaultFile, "utf8"), saved);
});
