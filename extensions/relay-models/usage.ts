import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export interface UsageTotals {
	records: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface ModelUsage extends UsageTotals {
	provider: string;
	model: string;
}

export interface HistoricalUsage {
	models: ModelUsage[];
	unattributed: UsageTotals;
	total: UsageTotals;
	files: number;
	duplicates: number;
	invalidLines: number;
	unreadablePaths: number;
	missingUsage: number;
}

export interface UsageScanOptions {
	sessionDirs: readonly string[];
	sessionFiles?: readonly string[];
	currentEntries?: readonly unknown[];
}

function emptyTotals(): UsageTotals {
	return { records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): UsageTotals | undefined {
	const usage = object(value);
	if (!usage) return undefined;
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (!keys.some((key) => nonnegative(usage[key])) && !nonnegative(usage.totalTokens)) return undefined;
	if (keys.some((key) => usage[key] !== undefined && !nonnegative(usage[key]))) return undefined;
	const result = emptyTotals();
	result.records = 1;
	for (const key of keys) result[key] = nonnegative(usage[key]) ? usage[key] : 0;
	// Match pi: cache tokens are separate from input; reasoning is already part of output.
	result.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
	if (result.totalTokens === 0 && nonnegative(usage.totalTokens)) result.totalTokens = usage.totalTokens;
	const cost = object(usage.cost);
	if (nonnegative(cost?.total)) result.cost = cost.total;
	return result;
}

function add(target: UsageTotals, source: UsageTotals): void {
	for (const key of ["records", "input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
		target[key] += source[key];
	}
}

// Stable across JSON key ordering and the parentId rewrites performed by /fork.
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = object(value);
	if (record) return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/** Read history without opening SessionManager (which can migrate and rewrite old files). */
export async function scanHistoricalUsage(options: UsageScanOptions): Promise<HistoricalUsage> {
	const result: HistoricalUsage = {
		models: [], unattributed: emptyTotals(), total: emptyTotals(),
		files: 0, duplicates: 0, invalidLines: 0, unreadablePaths: 0, missingUsage: 0,
	};
	const models = new Map<string, ModelUsage>();
	const seenEntries = new Set<string>();
	const seenPaths = new Set<string>();
	const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

	const consume = (value: unknown, occurrences: Map<string, number>) => {
		const entry = object(value);
		if (!entry) return;
		const message = entry.type === "message" ? object(entry.message) : undefined;
		const assistant = message?.role === "assistant";
		const summary = entry.type === "compaction" || entry.type === "branch_summary";
		if (!assistant && !(message?.role === "toolResult" && message.usage !== undefined) && !summary) return;
		const identity = summary
			? { type: entry.type, id: entry.id, timestamp: entry.timestamp, summary: entry.summary,
				usage: entry.usage, fromHook: entry.fromHook, details: entry.details }
			: { type: entry.type, id: entry.id, timestamp: entry.timestamp, message };
		const fingerprint = createHash("sha256").update(stableJson(identity)).digest("hex");
		// Legacy entries have no ID: preserve repeated calls within a file while
		// counting copied histories once (maximum occurrence count across copies).
		let ordinal = 0;
		if (typeof entry.id !== "string" || !entry.id) {
			ordinal = (occurrences.get(fingerprint) ?? 0) + 1;
			occurrences.set(fingerprint, ordinal);
		}
		const entryKey = `${fingerprint}:${ordinal}`;
		if (seenEntries.has(entryKey)) { result.duplicates++; return; }
		seenEntries.add(entryKey);
		const usage = parseUsage(summary ? entry.usage : message?.usage);
		if (!usage) { result.missingUsage++; return; }
		add(result.total, usage);
		const provider = assistant && typeof message?.provider === "string" ? message.provider : undefined;
		const model = assistant && typeof message?.model === "string" ? message.model : undefined;
		if (!provider || !model) { add(result.unattributed, usage); return; }
		// Keep the requested model ID so aliases remain associated with the configured relay route.
		const key = JSON.stringify([provider, model]);
		let row = models.get(key);
		if (!row) { row = { provider, model, ...emptyTotals() }; models.set(key, row); }
		add(row, usage);
	};

	// Includes entries that have not yet been flushed to the current session file.
	const currentOccurrences = new Map<string, number>();
	for (const entry of options.currentEntries ?? []) consume(entry, currentOccurrences);

	const scanFile = async (path: string) => {
		const key = pathKey(path);
		if (seenPaths.has(key)) return;
		seenPaths.add(key);
		const stream = createReadStream(path, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			let header = false;
			const occurrences = new Map<string, number>();
			for await (const line of lines) {
				const text = line.replace(/^\uFEFF/, "").trim();
				if (!text) continue;
				let value: unknown;
				try { value = JSON.parse(text); } catch { result.invalidLines++; continue; }
				if (!header) {
					if (object(value)?.type !== "session") { result.invalidLines++; break; }
					header = true;
					result.files++;
					continue;
				}
				consume(value, occurrences);
			}
		} catch {
			result.unreadablePaths++;
		} finally {
			lines.close();
			stream.destroy();
		}
	};

	const scanDirectory = async (path: string) => {
		const key = pathKey(path);
		if (seenPaths.has(key)) return;
		seenPaths.add(key);
		let entries;
		try { entries = await readdir(path, { withFileTypes: true }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.unreadablePaths++;
			return;
		}
		for (const entry of entries) {
			const child = resolve(path, entry.name);
			if (entry.isDirectory()) await scanDirectory(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) await scanFile(child);
		}
	};
	for (const directory of options.sessionDirs) await scanDirectory(directory);
	for (const file of options.sessionFiles ?? []) await scanFile(file);
	result.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
	return result;
}

export function formatHistoricalUsage(
	report: HistoricalUsage,
	providerNames: ReadonlyMap<string, string> = new Map(),
	providerId?: string,
): string {
	const rows = report.models.filter((row) => !providerId || row.provider === providerId);
	const total = providerId ? emptyTotals() : report.total;
	if (providerId) for (const row of rows) add(total, row);
	const n = (value: number) => value.toLocaleString("en-US");
	const counts = (usage: UsageTotals) =>
		`Total ${n(usage.totalTokens)} | Input ${n(usage.input)} | Output ${n(usage.output)} | Cache read ${n(usage.cacheRead)} | Cache write ${n(usage.cacheWrite)} | Est. $${usage.cost.toFixed(6)} | ${n(usage.records)} usage records`;
	const lines = [
		`Historical token usage${providerId ? ` — ${providerId}` : " — all providers"}`,
		`${report.files} session files scanned (all projects); ${report.duplicates} copied usage records deduplicated.`,
		`TOTAL: ${counts(total)}`,
	];
	if (rows.length === 0) lines.push(providerId ? `No recorded usage for provider "${providerId}".` : "No attributable model usage found.");
	const providers = new Map<string, ModelUsage[]>();
	for (const row of rows) {
		const group = providers.get(row.provider) ?? [];
		group.push(row);
		providers.set(row.provider, group);
	}
	for (const [provider, models] of providers) {
		const subtotal = emptyTotals();
		for (const row of models) add(subtotal, row);
		const name = providerNames.get(provider);
		lines.push("", `${name && name !== provider ? `${name} (${provider})` : provider}: ${counts(subtotal)}`);
		for (const row of models) lines.push(`  ${row.model}: ${counts(row)}`);
	}
	if (report.unattributed.records > 0) {
		lines.push("", `Unattributed tools/summaries${providerId ? " (excluded from provider total)" : ""}: ${counts(report.unattributed)}`);
	}
	if (report.missingUsage) lines.push(`Warning: ${report.missingUsage} assistant/summary/tool records have no valid usage; their consumption cannot be recovered.`);
	if (report.invalidLines || report.unreadablePaths) lines.push(`Warning: skipped ${report.invalidLines} invalid lines and ${report.unreadablePaths} unreadable paths; totals may be incomplete.`);
	lines.push("", "Based on locally saved usage, including abandoned branches. Costs use recorded model prices, not relay billing.");
	return lines.join("\n");
}
