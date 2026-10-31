import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { formatHistoricalUsage, scanHistoricalUsage } from "./usage.ts";
import type { UsageTotals } from "./usage.ts";

const timestamp = "2026-10-30T10:00:00.000Z";
const usage = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const totals = (values: Partial<UsageTotals> = {}): UsageTotals => ({
	records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, ...values,
});
function assistant(id: string, recordedUsage: unknown = usage(10, 2), provider = "relay-a", model = "model-a") {
	return {
		type: "message", id, parentId: null as string | null, timestamp,
		message: {
			role: "assistant", provider, model, api: "openai-completions", timestamp: 1_793_347_200_000,
			content: [{ type: "text", text: "answer" }], stopReason: "stop", usage: recordedUsage,
		},
	};
}
async function temporaryDirectory(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "relay-usage-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function history(path: string, entries: readonly unknown[], version = 3) {
	await mkdir(dirname(path), { recursive: true });
	const header = { type: "session", version, id: "fixture-session", timestamp, cwd: "/fixture/project" };
	await writeFile(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

test("aggregates all project directories, providers, models and abandoned branches without consulting configuration", async (t) => {
	const root = await temporaryDirectory(t);
	const first = join(root, "sessions-one");
	const second = join(root, "sessions-two");
	const branch = { ...assistant("branch", usage(3, 4, 5, 6)), parentId: "root-answer" };
	const abandoned = { ...assistant("abandoned", usage(7, 8, 9, 10)), parentId: "root-answer" };
	await history(join(first, "project-one", "session.jsonl"), [
		assistant("root-answer", { ...usage(10, 20, 30, 40), reasoning: 15, cacheWrite1h: 25, totalTokens: 999, cost: { total: 0.25 } }),
		branch, abandoned,
	]);
	await history(join(second, "project-two", "session.jsonl"), [
		assistant("another-model", usage(1, 2, 3, 4), "relay-a", "requested-alias"),
		assistant("other-provider", usage(2, 3), "builtin-provider", "model-a"),
		assistant("deleted-provider", usage(4, 5), "relay-deleted", "retired-model"),
	]);
	await writeFile(join(first, "notes.txt"), JSON.stringify(assistant("ignored", usage(999))));
	const report = await scanHistoricalUsage({ sessionDirs: [first, second] });
	assert.equal(report.files, 2);
	assert.equal(report.models.length, 4);
	assert.deepEqual(report.models.find((row) => row.provider === "relay-a" && row.model === "model-a"), {
		provider: "relay-a", model: "model-a", records: 3, input: 20, output: 32, cacheRead: 44, cacheWrite: 56, totalTokens: 152, cost: 0.25,
	});
	assert.ok(report.models.some((row) => row.provider === "relay-deleted" && row.model === "retired-model"));
	assert.ok(report.models.some((row) => row.provider === "relay-a" && row.model === "requested-alias"));
	assert.deepEqual(report.total, totals({ records: 6, input: 27, output: 42, cacheRead: 47, cacheWrite: 60, totalTokens: 176, cost: 0.25 }));
	assert.deepEqual(report.unattributed, totals());
	assert.equal(report.missingUsage, 0);
});

test("supports totalTokens-only usage and keeps recorded usage from error and aborted assistants", async (t) => {
	const root = await temporaryDirectory(t);
	const failed = assistant("failed", usage(5, 2));
	failed.message.stopReason = "error";
	const aborted = assistant("aborted", usage(3, 1, 2));
	aborted.message.stopReason = "aborted";
	await history(join(root, "session.jsonl"), [assistant("total-only", { totalTokens: 77 }), failed, aborted]);
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.deepEqual(report.total, totals({ records: 3, input: 8, output: 3, cacheRead: 2, totalTokens: 90 }));
	assert.equal(report.missingUsage, 0);
});

test("keeps summary and tool consumption unattributed even when they contain provider-like fields", async (t) => {
	const root = await temporaryDirectory(t);
	await history(join(root, "session.jsonl"), [
		assistant("attributed", usage(1, 2)),
		{ type: "compaction", id: "compact", parentId: "attributed", timestamp, firstKeptEntryId: "attributed", summary: "compacted", tokensBefore: 9000, provider: "relay-a", model: "model-a", usage: usage(10, 3, 4, 5) },
		{ type: "branch_summary", id: "branch-summary", parentId: "compact", timestamp, fromId: "other-branch", summary: "branch", usage: usage(6, 7) },
		{ type: "message", id: "tool", timestamp, message: { role: "toolResult", toolCallId: "call", toolName: "search", content: [], provider: "relay-a", model: "model-a", usage: usage(8, 9, 1, 2) } },
		{ type: "message", id: "tool-without-usage", timestamp, message: { role: "toolResult", content: [] } },
		{ type: "message", id: "user", timestamp, message: { role: "user", content: "question", usage: usage(9999) } },
	]);
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.deepEqual(report.unattributed, totals({ records: 3, input: 24, output: 19, cacheRead: 5, cacheWrite: 7, totalTokens: 55 }));
	assert.deepEqual(report.total, totals({ records: 4, input: 25, output: 21, cacheRead: 5, cacheWrite: 7, totalTokens: 58 }));
	assert.equal(report.models.length, 1);
	assert.equal(report.models[0]!.records, 1);
	assert.equal(report.missingUsage, 0);
});

test("deduplicates modern fork copies despite changed parents, JSON key order and summary references", async (t) => {
	const root = await temporaryDirectory(t);
	const answer = assistant("answer", usage(10, 2));
	const compact = { type: "compaction", id: "compact", parentId: "answer", timestamp, firstKeptEntryId: "original-keep", summary: "same compaction", tokensBefore: 500, usage: usage(3, 1) };
	const summary = { type: "branch_summary", id: "summary", parentId: "compact", timestamp, fromId: "original-branch", summary: "same summary", usage: usage(4, 2) };
	await history(join(root, "original.jsonl"), [answer, compact, summary]);
	await history(join(root, "fork.jsonl"), [
		{ timestamp, parentId: "rewritten-parent", id: answer.id, type: answer.type, message: { usage: { cacheWrite: 0, output: 2, input: 10, cacheRead: 0 }, ...Object.fromEntries(Object.entries(answer.message).filter(([key]) => key !== "usage").reverse()) } },
		{ ...compact, parentId: "fork-answer", firstKeptEntryId: "rewritten-keep" },
		{ ...summary, parentId: "fork-compact", fromId: "rewritten-branch" },
	]);
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.equal(report.duplicates, 3);
	assert.deepEqual(report.total, totals({ records: 3, input: 17, output: 5, totalTokens: 22 }));
	assert.equal(report.unattributed.records, 2);
});

test("does not collapse colliding short IDs when payload or timestamp differs", async (t) => {
	const root = await temporaryDirectory(t);
	const first = assistant("deadbeef", usage(2, 1));
	const differentPayload = assistant("deadbeef", usage(4, 2));
	const differentTimestamp = { ...first, timestamp: "2026-10-30T10:00:01.000Z" };
	const differentText = { ...first, message: { ...first.message, content: [{ type: "text", text: "a different answer" }] } };
	await history(join(root, "one.jsonl"), [first]);
	await history(join(root, "two.jsonl"), [differentPayload, differentTimestamp, differentText]);
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.equal(report.duplicates, 0);
	assert.deepEqual(report.total, totals({ records: 4, input: 10, output: 5, totalTokens: 15 }));
});

test("merges current memory with explicit disk files and counts unsaved entries once", async (t) => {
	const root = await temporaryDirectory(t);
	const saved = assistant("saved", usage(10, 2));
	const unsaved = assistant("unsaved", usage(3, 4));
	const file = await history(join(root, "outside-session-roots", "current.jsonl"), [saved]);
	const memory: readonly unknown[] = Object.freeze([saved, unsaved]);
	const snapshot = structuredClone(memory);
	const report = await scanHistoricalUsage({ sessionDirs: [], sessionFiles: [file, file], currentEntries: memory });
	assert.deepEqual(report.total, totals({ records: 2, input: 13, output: 6, totalTokens: 19 }));
	assert.equal(report.files, 1);
	assert.equal(report.duplicates, 1);
	assert.deepEqual(memory, snapshot);
	const overlapping = await scanHistoricalUsage({ sessionDirs: [root, root], sessionFiles: [file] });
	assert.equal(overlapping.files, 1);
	assert.equal(overlapping.duplicates, 0);
	assert.equal(overlapping.total.records, 1);
});

test("preserves repeated no-ID legacy occurrences while deduplicating copied files and memory", async (t) => {
	const root = await temporaryDirectory(t);
	const { id: _id, parentId: _parentId, ...legacy } = assistant("discarded-id", usage(5, 1));
	await history(join(root, "original.jsonl"), [legacy, legacy], 1);
	await history(join(root, "copied.jsonl"), [legacy, legacy], 1);
	const disk = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.deepEqual(disk.total, totals({ records: 2, input: 10, output: 2, totalTokens: 12 }));
	assert.equal(disk.duplicates, 2);
	const withMemory = await scanHistoricalUsage({ sessionDirs: [root], currentEntries: [legacy, legacy, legacy] });
	assert.deepEqual(withMemory.total, totals({ records: 3, input: 15, output: 3, totalTokens: 18 }));
	assert.equal(withMemory.duplicates, 4);
});

test("continues after malformed lines and reports missing or invalid usage without counting it", async (t) => {
	const root = await temporaryDirectory(t);
	const file = await history(join(root, "damaged.jsonl"), [
		assistant("good", usage(7, 3)), assistant("missing"), assistant("null", null), assistant("empty", {}),
		assistant("negative", { input: -1, output: 2 }), assistant("string", { input: "5", output: 2 }),
	]);
	const content = (await readFile(file, "utf8")).split("\n");
	const missing = JSON.parse(content[2]!);
	delete missing.message.usage;
	content[2] = JSON.stringify(missing);
	await writeFile(file, "\uFEFF" + content[0] + "\r\n\n{bad json\r\n" + content.slice(1).join("\r\n") + "\r\n" + JSON.stringify(assistant("after-error", usage(1, 1))) + "\r\n");
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	assert.equal(report.files, 1);
	assert.equal(report.invalidLines, 1);
	assert.equal(report.missingUsage, 5);
	assert.deepEqual(report.total, totals({ records: 2, input: 8, output: 4, totalTokens: 12 }));
	const output = formatHistoricalUsage(report);
	assert.match(output, /Warning: 5 .*no valid usage/);
	assert.match(output, /1 invalid lines/);
	assert.match(output, /totals may be incomplete/);
});

test("ignores missing directories but reports an unreadable explicit session file", async (t) => {
	const root = await temporaryDirectory(t);
	const good = await history(join(root, "good.jsonl"), [assistant("good", usage(2, 3))]);
	const report = await scanHistoricalUsage({ sessionDirs: [join(root, "missing-directory")], sessionFiles: [join(root, "missing-explicit-file.jsonl"), good] });
	assert.equal(report.files, 1);
	assert.equal(report.unreadablePaths, 1);
	assert.equal(report.invalidLines, 0);
	assert.equal(report.total.totalTokens, 5);
	assert.match(formatHistoricalUsage(report), /1 unreadable paths/);
});

test("rejects non-session JSONL input and never rewrites history or current entries", async (t) => {
	const root = await temporaryDirectory(t);
	const legacyFile = await history(join(root, "legacy.jsonl"), [assistant("old", usage(1, 2))], 1);
	const foreignFile = join(root, "not-a-session.jsonl");
	await writeFile(foreignFile, JSON.stringify(assistant("foreign", usage(999))) + "\n");
	const files = [legacyFile, foreignFile];
	const before = await Promise.all(files.map(async (file) => ({ data: await readFile(file), modified: (await stat(file)).mtimeMs })));
	const current = [assistant("memory", usage(3, 4))];
	const snapshot = structuredClone(current);
	const report = await scanHistoricalUsage({ sessionDirs: [root], currentEntries: current });
	assert.equal(report.files, 1);
	assert.equal(report.invalidLines, 1);
	assert.equal(report.total.totalTokens, 10);
	assert.deepEqual(current, snapshot);
	for (const [index, file] of files.entries()) {
		assert.deepEqual(await readFile(file), before[index]!.data);
		assert.equal((await stat(file)).mtimeMs, before[index]!.modified);
	}
});

test("formats provider names, model rows, provider subtotals and a provider-only total", async (t) => {
	const root = await temporaryDirectory(t);
	await history(join(root, "session.jsonl"), [
		assistant("a", { ...usage(1000, 20, 30, 40), cost: { total: 0.5 } }, "relay-a", "alias-one"),
		assistant("b", usage(2, 3, 4, 5), "relay-a", "alias-two"),
		assistant("c", usage(7, 8), "relay-deleted", "retired-model"),
		{ type: "compaction", id: "summary", timestamp, summary: "summary", usage: usage(9, 1) },
	]);
	const report = await scanHistoricalUsage({ sessionDirs: [root] });
	const names: ReadonlyMap<string, string> = new Map([["relay-a", "Friendly Relay"]]);
	const all = formatHistoricalUsage(report, names);
	assert.match(all, /Historical token usage.*all providers/);
	assert.match(all, /^TOTAL: Total 1,129 \| Input 1,018 \| Output 32 \| Cache read 34 \| Cache write 45 \| Est\. \$0\.500000 \| 4 usage records$/m);
	assert.match(all, /^Friendly Relay \(relay-a\): Total 1,104 .*2 usage records$/m);
	assert.match(all, /^  alias-one: Total 1,090 /m);
	assert.match(all, /^  alias-two: Total 14 /m);
	assert.match(all, /^relay-deleted: Total 15 /m);
	assert.match(all, /^  retired-model: Total 15 /m);
	assert.match(all, /Unattributed tools\/summaries: Total 10 /);
	assert.match(all, /including abandoned branches/);
	assert.match(all, /not relay billing/);
	const filtered = formatHistoricalUsage(report, names, "relay-a");
	assert.match(filtered, /^TOTAL: Total 1,104 \| Input 1,002 \| Output 23 \| Cache read 34 \| Cache write 45 .*2 usage records$/m);
	assert.match(filtered, /Friendly Relay \(relay-a\)/);
	assert.doesNotMatch(filtered, /retired-model|relay-deleted/);
	assert.match(filtered, /Unattributed tools\/summaries \(excluded from provider total\): Total 10 /);
	const deleted = formatHistoricalUsage(report, names, "relay-deleted");
	assert.match(deleted, /^TOTAL: Total 15 /m);
	assert.match(deleted, /retired-model/);
	assert.doesNotMatch(deleted, /alias-one|Friendly Relay/);
});

test("formats empty history and an unknown provider as zero data without spurious warnings", async () => {
	const report = await scanHistoricalUsage({ sessionDirs: [] });
	assert.deepEqual(report.total, totals());
	assert.deepEqual(report.models, []);
	assert.equal(report.files, 0);
	const all = formatHistoricalUsage(report);
	assert.match(all, /^TOTAL: Total 0 \| Input 0 \| Output 0 \| Cache read 0 \| Cache write 0 .*0 usage records$/m);
	assert.match(all, /No attributable model usage found/);
	assert.doesNotMatch(all, /Warning:/);
	const filtered = formatHistoricalUsage(report, new Map(), "unknown-provider");
	assert.match(filtered, /No recorded usage for provider "unknown-provider"/);
	assert.match(filtered, /^TOTAL: Total 0 /m);
});
