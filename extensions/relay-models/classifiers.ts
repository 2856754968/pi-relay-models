import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { RelayConfig } from "./core.ts";

/** Structural shape keeps chat-only Pi 0.82.1 type checking supported. */
export interface RelayClassifierModel {
	type: "classifier";
	id: string;
	name: string;
	provider: string;
	api: "typesafe-system-one";
	baseUrl: string;
	input: ["text"];
	contextWindow: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function isJevModelId(id: string): boolean {
	return /^(?:typesafe\/)?jev-(?:latest|\d+\.\d+(?:\.\d+)?(?:-free)?)$/u.test(id);
}

export function materializeRelayClassifiers(config: RelayConfig, ids: readonly string[]): RelayClassifierModel[] {
	const excluded = new Set(config.excludedModels ?? []);
	return [...new Set(ids.map((id) => id.trim()))]
		.filter((id) => isJevModelId(id) && !excluded.has(id))
		.map((id) => ({
			type: "classifier",
			id,
			name: id,
			provider: config.id,
			api: "typesafe-system-one",
			baseUrl: config.baseUrl,
			input: ["text"],
			// Conservative text-only relay capabilities; zero cost means unknown pricing.
			contextWindow: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export async function loadClassifierApis() {
	// providers/all is exposed by desktop Pi's extension loader as well as the npm SDK.
	// Direct api/* imports may exist on disk without being available in bundled Pi.
	const modulePath = "@earendil-works/pi-ai/providers/all";
	try {
		const { builtinProviders } = await import(modulePath);
		const provider = builtinProviders().find((value: { id: string }) => value.id === "typesafe");
		if (typeof provider?.classify !== "function") return undefined;
		return { "typesafe-system-one": { classify: provider.classify.bind(provider) } };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error &&
			(error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) return undefined;
		throw error;
	}
}

export function publishRelayModels(chat: Model<Api>[], classifiers: RelayClassifierModel[]): Model<Api>[] {
	// SAFETY: createProvider in classifier-capable Pi accepts mixed model types at runtime.
	// The chat-only SDK types predate AnyModel; the cast changes no objects or runtime discriminants.
	return [...chat, ...classifiers] as unknown as Model<Api>[];
}
