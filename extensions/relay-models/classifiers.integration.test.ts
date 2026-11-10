import assert from "node:assert/strict";
import test from "node:test";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { isJevModelId, loadClassifierApis, materializeRelayClassifiers, publishRelayModels } from "./classifiers.ts";

const relay = { id: "relay-test", name: "Relay Test", baseUrl: "https://relay.example/v1", protocol: "openai-completions" as const };

test("recognizes only Jev IDs and respects deduplication and exclusions", () => {
	for (const id of ["jev-1.14.0", "jev-1.14", "jev-latest", "typesafe/jev-1.14.0", "jev-1.13-free"]) assert.ok(isJevModelId(id));
	for (const id of ["jev-chat", "my-jev-1.14.0", "gpt-6", "jev-1.14.0-extra"]) assert.equal(isJevModelId(id), false);
	const models = materializeRelayClassifiers({ ...relay, excludedModels: ["jev-latest"] }, ["jev-1.14.0", " jev-1.14.0 ", "jev-latest", "gpt-6"]);
	assert.equal(models.length, 1);
	assert.equal(models[0].type, "classifier");
	assert.equal(models[0].provider, relay.id);
	assert.equal(models[0].baseUrl, relay.baseUrl);
	assert.deepEqual(models[0].input, ["text"]);
});

test("mixed provider discovers Jev only as classifier and delegates typed answers to Pi", async (t) => {
	const classifiers = await loadClassifierApis();
	if (!classifiers) {
		t.skip("This Pi SDK has no classifier API; chat support remains available");
		return;
	}
	const models = materializeRelayClassifiers(relay, ["jev-1.14.0"]);
	const provider = createProvider({ id: relay.id, auth: {}, api: openAICompletionsApi(), models: publishRelayModels([], models), ...{ classifiers } });
	// SAFETY: this branch runs only when Pi's classifier module exists; old SDKs lack these methods in their types.
	const runtime = provider as unknown as {
		getAllModels(): typeof models;
		classify(model: typeof models[number], context: unknown, options: unknown): Promise<{ stopReason: string; answers: unknown }>;
	};
	assert.equal(provider.getModels().length, 0);
	assert.equal(runtime.getAllModels()[0].id, "jev-1.14.0");
	let requests = 0;
	const result = await runtime.classify(models[0], {
		state: { message: "Service unavailable" },
		questions: {
			category: { type: "choice", instructions: "Classify", criteria: { incident: "Outage", praise: "Positive" } },
			urgent: { type: "bool", instructions: "Urgent?", criteria: { true: "Immediate", false: "Can wait" } },
			severity: { type: "score", instructions: "Severity", criteria: ["None", "Minor", "Outage"] },
		},
	}, {
		apiKey: "test-placeholder",
		fetch: async (input: string | URL | Request, init?: RequestInit) => {
			requests++;
			assert.equal(String(input), "https://relay.example/v1/systemone");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "jev-1.14.0");
			assert.equal(body.questions.urgent.type, "noul");
			return Response.json({ answers: {
				category: { type: "choice", choice: "incident", probabilities: { incident: 0.9, praise: 0.1 }, confidence: 0.9 },
				urgent: { type: "noul", noul: 0.95 },
				severity: { type: "score", score: 2, confidence: 0.85 },
			} });
		},
	});
	assert.equal(requests, 1);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.answers, {
		category: { type: "choice", choice: "incident", probabilities: { incident: 0.9, praise: 0.1 }, confidence: 0.9 },
		urgent: { type: "bool", probability: 0.95 },
		severity: { type: "score", score: 2, confidence: 0.85 },
	});
});
