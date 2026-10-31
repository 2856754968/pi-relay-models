import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeOfficialCatalog, OfficialCatalog, OFFICIAL_CATALOG_URL, parseOfficialCatalog } from "./catalog.ts";
import { materializeRelayModels } from "./core.ts";

function fixture(contextWindow = 1_000_000) {
	return { anthropic: { "claude-new": {
		id: "claude-new", name: "Claude New", provider: "anthropic", api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow, maxTokens: 128_000, thinkingLevelMap: { off: null, max: "max" },
		compat: { forceAdaptiveThinking: true }, headers: { "x-official-only": "discard" },
	} } };
}

async function cachePath(t: { after(fn: () => Promise<void>): void }) {
	const directory = await mkdtemp(join(tmpdir(), "relay-catalog-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "catalog.json");
}

test("website metadata overrides stale local models and survives relay materialization", () => {
	const local = parseOfficialCatalog(fixture(200_000));
	const json = fixture();
	const remote = parseOfficialCatalog(json);
	const catalog = mergeOfficialCatalog([...local, { ...local[0]!, id: "local-only" }], remote);
	assert.equal(catalog.length, 2);
	const result = materializeRelayModels({
		id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", protocol: "openai-completions",
	}, ["claude-new", "unknown-model"], catalog);
	const model = result.models[0]!;
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 128_000);
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.baseUrl, "https://relay.example");
	assert.deepEqual(model.cost, json.anthropic["claude-new"].cost);
	assert.deepEqual(model.thinkingLevelMap, { off: null, max: "max" });
	assert.deepEqual(model.compat, { forceAdaptiveThinking: true });
	assert.equal(model.headers, undefined);
	assert.equal(result.matches.length, 1);
	assert.equal(result.models[1]!.id, "unknown-model");
	assert.equal(result.models[1]!.api, "openai-completions");
	json.anthropic["claude-new"].cost.input = 99;
	assert.equal(remote[0]!.cost.input, 3);
});

test("catalog requirements survive revalidation and restore and warn only for older runtimes", async (t) => {
	for (const [runtime, shouldWarn] of [["0.82.1", true], ["1.2.0", true], ["1.2.1-beta.1", true], ["1.2.1", false], ["1.3.0", false], ["1.10.0", false]] as const) {
		const path = await cachePath(t);
		let calls = 0;
		const catalog = new OfficialCatalog(path, async () => ++calls === 1
			? Response.json(fixture(), { headers: { "x-pi-model-catalog-minimum-version": "1.2.1", "x-pi-model-catalog-revision": "sha256-test" } })
			: new Response(null, { status: 304 }), Date.now, runtime);
		await catalog.refresh();
		await catalog.refresh({ force: true });
		const restored = new OfficialCatalog(path, async () => { throw new Error("offline"); }, Date.now, runtime);
		await restored.restore();
		assert.equal(restored.getStatus().minimumPiVersion, "1.2.1");
		assert.equal(restored.getStatus().runtimeVersion, runtime);
		assert.equal(restored.getStatus().revision, "sha256-test");
		assert.equal(Boolean(restored.getStatus().warning), shouldWarn);
		if (shouldWarn) assert.match(restored.getStatus().warning!, /requires pi >= 1\.2\.1/);
		await restored.refresh({ force: true });
		assert.match(restored.getStatus().warning!, /offline/);
		if (shouldWarn) assert.match(restored.getStatus().warning!, /requires pi >= 1\.2\.1/);
	}
});

test("catalog parser rejects incomplete data and excludes non-chat entries", () => {
	assert.throws(() => parseOfficialCatalog({}), /no chat models/);
	assert.throws(() => parseOfficialCatalog({ anthropic: { broken: { id: "broken" } } }), /Invalid pi.dev chat model/);
	const valid = fixture();
	assert.equal(parseOfficialCatalog({ ...valid, images: { image: { type: "image" } } }).length, 1);
	valid.anthropic["claude-new"].contextWindow = NaN;
	assert.throws(() => parseOfficialCatalog(valid), /Invalid pi.dev chat model/);
});

test("catalog caches ETags, honors freshness, forces revalidation, and restores offline", async (t) => {
	const path = await cachePath(t);
	let calls = 0;
	let now = 1_000;
	const catalog = new OfficialCatalog(path, async (url, options) => {
		assert.equal(url, OFFICIAL_CATALOG_URL);
		calls += 1;
		if (calls === 1) return Response.json(fixture(), { headers: { etag: "catalog-v1" } });
		assert.equal(new Headers(options?.headers).get("if-none-match"), "catalog-v1");
		return new Response(null, { status: 304 });
	}, () => now);
	await catalog.restore();
	await catalog.refresh();
	assert.equal(calls, 1);
	assert.equal(catalog.getStatus().source, "pi.dev");
	now += 1_000;
	await catalog.refresh();
	assert.equal(calls, 1);
	await catalog.refresh({ force: true });
	assert.equal(calls, 2);
	assert.equal(catalog.getStatus().fetchedAt, new Date(1_000).toISOString());
	assert.equal(catalog.getStatus().checkedAt, new Date(2_000).toISOString());
	const restored = new OfficialCatalog(path, async () => { throw new Error("offline"); }, () => now);
	await restored.restore();
	await restored.refresh({ force: true });
	assert.equal(restored.getModels()[0]!.contextWindow, 1_000_000);
	assert.match(restored.getStatus().warning!, /cached pi.dev.*offline/);
	assert.equal(JSON.parse(await readFile(path, "utf8")).etag, "catalog-v1");
});

test("failed and malformed updates preserve last known models and cached body", async (t) => {
	const path = await cachePath(t);
	let response = Response.json(fixture());
	const catalog = new OfficialCatalog(path, async () => response);
	await catalog.refresh();
	const before = await readFile(path, "utf8");
	for (response of [Response.json({}), new Response("down", { status: 503 })]) {
		await catalog.refresh({ force: true });
		assert.ok(catalog.getStatus().warning);
		assert.equal(catalog.getModels().length, 1);
		assert.equal(await readFile(path, "utf8"), before);
	}
});

test("cold failures fall back locally; explicit sync retries and concurrent refreshes share a fetch", async (t) => {
	const path = await cachePath(t);
	await writeFile(path, "corrupted cache");
	let calls = 0;
	const catalog = new OfficialCatalog(path, async () => {
		calls += 1;
		if (calls === 1) throw new Error("offline");
		return Response.json(fixture());
	});
	await catalog.restore();
	await catalog.refresh();
	assert.equal(catalog.getStatus().source, "local");
	assert.match(catalog.getStatus().warning!, /local pi/);
	await catalog.refresh();
	assert.equal(calls, 1);
	await Promise.all([catalog.refresh({ force: true }), catalog.refresh({ force: true })]);
	assert.equal(calls, 2);
	assert.equal(catalog.getStatus().warning, undefined);
});

test("user cancellation is propagated without being treated as a failed catalog update", async (t) => {
	const controller = new AbortController();
	let calls = 0;
	const catalog = new OfficialCatalog(await cachePath(t), async (_url, options) => {
		if (++calls === 1) controller.abort(new Error("cancelled"));
		options?.signal?.throwIfAborted();
		return Response.json(fixture());
	});
	await assert.rejects(catalog.refresh({ signal: controller.signal }), /cancelled/);
	assert.equal(catalog.getModels().length, 0);
	assert.equal(catalog.getStatus().warning, undefined);
	await catalog.refresh();
	assert.equal(calls, 2, "cancellation must not suppress the next automatic attempt for four hours");
	assert.equal(catalog.getModels().length, 1);
});

test("corrupt cache timestamps fall back locally without breaking status reporting", async (t) => {
	const path = await cachePath(t);
	await writeFile(path, JSON.stringify({ version: 1, fetchedAt: 1e100, checkedAt: 1e100, catalog: fixture() }));
	const catalog = new OfficialCatalog(path);
	await catalog.restore();
	assert.equal(catalog.getStatus().source, "local");
	assert.match(catalog.getStatus().warning!, /Could not restore/);
});
