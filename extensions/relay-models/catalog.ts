import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

export const OFFICIAL_CATALOG_URL = "https://pi.dev/api/models";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Keep only chat models if the website adds other model types. */
export function parseOfficialCatalog(value: unknown): Model<Api>[] {
	if (!isRecord(value)) throw new Error("Invalid pi.dev model catalog");
	const models: Model<Api>[] = [];
	for (const [provider, entries] of Object.entries(value)) {
		if (!isRecord(entries)) throw new Error(`Invalid pi.dev provider: ${provider}`);
		for (const [id, entry] of Object.entries(entries)) {
			if (!isRecord(entry)) throw new Error(`Invalid pi.dev model: ${provider}/${id}`);
			if (entry.type !== undefined && entry.type !== "chat") continue;
			if (
				entry.id !== id || entry.provider !== provider ||
				typeof entry.name !== "string" || typeof entry.api !== "string" ||
				typeof entry.baseUrl !== "string" || typeof entry.reasoning !== "boolean" ||
				!Array.isArray(entry.input) || entry.input.length === 0 ||
				!entry.input.every((input) => input === "text" || input === "image") ||
				!isRecord(entry.cost) ||
				![entry.cost.input, entry.cost.output, entry.cost.cacheRead, entry.cost.cacheWrite].every(isNonNegativeNumber) ||
				typeof entry.contextWindow !== "number" || !Number.isFinite(entry.contextWindow) || entry.contextWindow <= 0 ||
				typeof entry.maxTokens !== "number" || !Number.isFinite(entry.maxTokens) || entry.maxTokens <= 0
			) throw new Error(`Invalid pi.dev chat model: ${provider}/${id}`);
			models.push(structuredClone(entry) as unknown as Model<Api>);
		}
	}
	if (models.length === 0) throw new Error("pi.dev returned no chat models");
	return models;
}

/** Remote entries win per provider/id; keep local-only models for existing manual mappings. */
export function mergeOfficialCatalog(local: readonly Model<Api>[], remote: readonly Model<Api>[]): Model<Api>[] {
	const models = new Map(local.map((model) => [`${model.provider}/${model.id}`, model]));
	for (const model of remote) models.set(`${model.provider}/${model.id}`, model);
	return [...models.values()];
}

// Catalog minimum versions are stable releases; prerelease runtimes precede the same stable version.
function belowMinimumVersion(runtime: string, minimum: string): boolean {
	const current = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.*)?$/.exec(runtime);
	const required = /^(\d+)\.(\d+)\.(\d+)$/.exec(minimum);
	if (!current || !required) return false;
	for (let i = 1; i <= 3; i++) {
		const difference = Number(current[i]) - Number(required[i]);
		if (difference !== 0) return difference < 0;
	}
	return Boolean(current[4]);
}

export interface OfficialCatalogStatus {
	url: string;
	source: "pi.dev" | "local";
	modelCount: number;
	minimumPiVersion?: string;
	runtimeVersion?: string;
	revision?: string;
	fetchedAt?: string;
	checkedAt?: string;
	warning?: string;
}

interface CatalogCache {
	version: 1;
	fetchedAt: number;
	checkedAt: number;
	etag?: string;
	minimumPiVersion?: string;
	revision?: string;
	catalog: Record<string, Record<string, Model<Api>>>;
}

export class OfficialCatalog {
	private models: Model<Api>[] = [];
	private cache?: CatalogCache;
	private warning?: string;
	private pending?: Promise<void>;
	private lastAttempt = -Infinity;

	private readonly cachePath: string;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly runtimeVersion?: string;

	constructor(cachePath: string, fetcher: typeof fetch = fetch, now: () => number = Date.now, runtimeVersion?: string) {
		this.cachePath = cachePath;
		this.fetcher = fetcher;
		this.now = now;
		this.runtimeVersion = runtimeVersion;
	}

	getModels(): readonly Model<Api>[] {
		return this.models;
	}

	getStatus(): OfficialCatalogStatus {
		const minimum = this.cache?.minimumPiVersion;
		const versionWarning = minimum && this.runtimeVersion && belowMinimumVersion(this.runtimeVersion, minimum)
			? `Latest pi.dev catalog requires pi >= ${minimum}; current pi is ${this.runtimeVersion}. Update pi for full model compatibility.`
			: undefined;
		return {
			url: OFFICIAL_CATALOG_URL,
			source: this.models.length ? "pi.dev" : "local",
			modelCount: this.models.length,
			minimumPiVersion: minimum,
			runtimeVersion: this.runtimeVersion,
			revision: this.cache?.revision,
			fetchedAt: this.cache ? new Date(this.cache.fetchedAt).toISOString() : undefined,
			checkedAt: this.cache ? new Date(this.cache.checkedAt).toISOString() : undefined,
			warning: [this.warning, versionWarning].filter(Boolean).join("\n") || undefined,
		};
	}

	/** Restore without network access so cached models are available during provider registration. */
	async restore(): Promise<void> {
		try {
			const value: unknown = JSON.parse(await readFile(this.cachePath, "utf8"));
			if (!isRecord(value) || value.version !== 1 ||
				typeof value.fetchedAt !== "number" || !Number.isFinite(new Date(value.fetchedAt).getTime()) ||
				typeof value.checkedAt !== "number" || !Number.isFinite(new Date(value.checkedAt).getTime()) ||
				(value.etag !== undefined && typeof value.etag !== "string") ||
				(value.minimumPiVersion !== undefined && typeof value.minimumPiVersion !== "string") ||
				(value.revision !== undefined && typeof value.revision !== "string")) {
				throw new Error("Invalid cached pi.dev catalog");
			}
			this.models = parseOfficialCatalog(value.catalog);
			this.cache = value as unknown as CatalogCache;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warning = `Could not restore pi.dev catalog: ${String(error)}`;
		}
	}

	async refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		options.signal?.throwIfAborted();
		if (this.pending) {
			await this.pending;
			options.signal?.throwIfAborted();
			return;
		}
		// Avoid retry storms during simultaneous relay discovery or a network outage. Explicit sync always retries.
		if (!options.force && this.now() - Math.max(this.cache?.checkedAt ?? -Infinity, this.lastAttempt) < REFRESH_INTERVAL_MS) return;
		this.pending = this.fetchCatalog(options.signal);
		try {
			await this.pending;
		} finally {
			this.pending = undefined;
		}
	}

	private async fetchCatalog(signal?: AbortSignal): Promise<void> {
		this.lastAttempt = this.now();
		try {
			const response = await this.fetcher(OFFICIAL_CATALOG_URL, {
				headers: { accept: "application/json", ...(this.cache?.etag ? { "if-none-match": this.cache.etag } : {}) },
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
			});
			if (response.status === 304 && this.cache) {
				this.cache = { ...this.cache, checkedAt: this.now() };
			} else {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const catalog: unknown = await response.json();
				const models = parseOfficialCatalog(catalog);
				signal?.throwIfAborted();
				this.models = models;
				this.cache = {
					version: 1, fetchedAt: this.now(), checkedAt: this.now(),
					etag: response.headers.get("etag") ?? undefined,
					catalog: catalog as CatalogCache["catalog"],
				};
			}
			this.cache = {
				...this.cache!,
				minimumPiVersion: response.headers.get("x-pi-model-catalog-minimum-version") ?? this.cache?.minimumPiVersion,
				revision: response.headers.get("x-pi-model-catalog-revision") ?? this.cache?.revision,
			};
			signal?.throwIfAborted();
			this.warning = undefined;
			await mkdir(dirname(this.cachePath), { recursive: true });
			const temporary = `${this.cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(this.cache), "utf8");
				await rename(temporary, this.cachePath);
			} finally {
				await rm(temporary, { force: true });
			}
		} catch (error) {
			if (signal?.aborted) {
				this.lastAttempt = -Infinity;
				signal.throwIfAborted();
			}
			this.warning = `pi.dev catalog refresh failed; using ${this.models.length ? "cached pi.dev" : "local pi"} models: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
