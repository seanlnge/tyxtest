import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient } from "../src/model/providers.js";
import type { DecisionRequest, DecisionScope } from "../src/config/types.js";

const SYSTEM_ONE = {
  model: "jev-1.13.0",
  answers: {
    answer: {
      type: "choice",
      choice: "pass",
      confidence: 0.8,
      probabilities: { pass: 0.92, fail: 0.08 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 2 },
};

test("typesafe decisions call System One and read choice probabilities", async () => {
  const original = globalThis.fetch;
  let url = "";
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, requestInit?: RequestInit) => {
    url = String(input);
    init = requestInit;
    return new Response(JSON.stringify(SYSTEM_ONE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const client = createModelClient(
      { provider: "typesafe", model: "jev", kind: "decision" },
      { TYPESAFE_API_KEY: "test-key" },
    );
    const answer = await client.decide?.({
      purpose: "verdict",
      state: "Claim: there is a submit button\n\nexport function Form() { return null }",
      options: ["pass", "fail"],
    });
    assert.deepEqual(answer?.probabilities, [0.92, 0.08]);
    assert.deepEqual(client.usage?.(), { inputTokens: 10, outputTokens: 2, available: true });
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer test-key");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      questions: { answer: { type: string; instructions: string; criteria: Record<string, string> } };
    };
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions.answer.type, "choice");
    assert.equal(body.questions.answer.instructions, "Does the code satisfy the claim?");
    assert.equal(body.questions.answer.criteria.pass, "The code does what the claim says.");
    assert.equal(body.questions.answer.criteria.fail, "The code leaves the claim unsatisfied.");
  } finally {
    globalThis.fetch = original;
  }
});

test("TYPESAFE_BASE_URL replaces the System One host", async () => {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    url = String(input);
    return new Response(
      JSON.stringify({
        ...SYSTEM_ONE,
        answers: { answer: { type: "choice", choice: "yes", probabilities: { yes: 0.2, no: 0.8 } } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const client = createModelClient(
      { provider: "typesafe", model: "jev-latest", kind: "decision", apiKeyEnv: "TYPESAFE_API_KEY" },
      { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: "https://example.test/root/" },
    );
    await client.decide?.({ purpose: "evidence", state: "chunk", options: ["yes", "no"] });
    assert.equal(url, "https://example.test/root/v1/systemone");
  } finally {
    globalThis.fetch = original;
  }
});

test("typesafe batches verdict and evidence into one System One request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let body = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          q0: { type: "choice", probabilities: { pass: 0.95, fail: 0.05 } },
          q1: { type: "choice", probabilities: { yes: 0.8, no: 0.2 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const client = createModelClient(
      { provider: "typesafe", model: "jev", kind: "decision" },
      { TYPESAFE_API_KEY: "test-key" },
    );
    const answers = await client.decideMany?.([
      { purpose: "verdict", state: "claim and code", options: ["pass", "fail"] },
      { purpose: "evidence", state: "one chunk", options: ["yes", "no"] },
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(client.usage?.(), { inputTokens: 1, outputTokens: 1, available: true });
    assert.deepEqual(answers?.map((answer) => answer.probabilities), [
      [0.95, 0.05],
      [0.8, 0.2],
    ]);
    const parsed = JSON.parse(body) as { questions: Record<string, { instructions: string }> };
    assert.equal(parsed.questions.q0?.instructions, "Does the code satisfy the claim? Use only `q0`.");
    assert.equal(parsed.questions.q1?.instructions, "Does this chunk implement the claim? Use only `q1`.");
  } finally {
    globalThis.fetch = original;
  }
});

test("TypeSafe serializes a shared test scope once and preserves question/option/probability order", async () => {
  const original = globalThis.fetch;
  let body: Record<string, any> = {};
  const scope: DecisionScope = { id: "test-one", state: "Claim: shared claim\nFULL_SPECIFICATION_SENTINEL\n===== src/code.ts:2-4 selected =====\nSELECTED_SOURCE_SENTINEL" };
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: {
      q0: { probabilities: { pass: 0.9, fail: 0.1 } },
      q1: { probabilities: { yes: 0.8, no: 0.2 } },
      q2: { probabilities: { changes: 0.7, unchanged: 0.3 } },
    } }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "test-key" });
    const requests: DecisionRequest[] = [
      { purpose: "verdict", state: scope.state, sharedState: { scope }, options: ["fail", "pass"] },
      { purpose: "evidence", state: scope.state, sharedState: { scope, chunk: { path: "src/code.ts", symbol: "selected", line: 2, endLine: 4 } }, options: ["no", "yes"] },
      { purpose: "triage", state: "LEGACY_UNSTRUCTURED_TRIAGE", options: ["unchanged", "changes"] },
    ];
    const answers = await client.decideMany!(requests);
    assert.deepEqual(answers.map((answer) => answer.probabilities), [[0.1, 0.9], [0.2, 0.8], [0.3, 0.7]]);
    assert.deepEqual(Object.keys(body.questions), ["q0", "q1", "q2"]);
    assert.deepEqual(Object.keys(body.questions.q0.criteria), ["fail", "pass"]);
    assert.deepEqual(Object.keys(body.questions.q1.criteria), ["no", "yes"]);
    assert.deepEqual(Object.keys(body.state), ["scope0", "q2"]);
    assert.deepEqual(body.state.scope0, scope);
    assert.equal(body.state.q2, "LEGACY_UNSTRUCTURED_TRIAGE");
    assert.match(body.questions.q0.instructions, /Use only `state\.scope0`/);
    assert.match(body.questions.q1.instructions, /Use only `state\.scope0`/);
    assert.match(body.questions.q1.instructions, /src\/code\.ts#selected.*source lines 2-4/);
    assert.match(body.questions.q1.instructions, /not substitutes for the targeted chunk/);
    assert.equal(body.questions.q2.instructions, "Could this diff change whether the claim is true? Use only `q2`.");
    for (const sentinel of ["FULL_SPECIFICATION_SENTINEL", "SELECTED_SOURCE_SENTINEL"]) assert.equal(JSON.stringify(body).split(sentinel).length - 1, 1);
  } finally { globalThis.fetch = original; }
});

test("TypeSafe scopes are grouped by explicit object identity, never conflated by a repeated label", async () => {
  const original = globalThis.fetch;
  let body: Record<string, any> = {};
  const first: DecisionScope = { id: "same-label", state: "FIRST_SCOPE_SOURCE" };
  const second: DecisionScope = { id: "same-label", state: "SECOND_SCOPE_SOURCE" };
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { probabilities: { pass: 1, fail: 0, yes: 1, no: 0 } }])) }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "test-key" });
    await client.decideMany!([first, second].flatMap((scope, index): DecisionRequest[] => [
      { purpose: "verdict", state: scope.state, options: ["pass", "fail"], sharedState: { scope } },
      { purpose: "evidence", state: scope.state, options: ["yes", "no"], sharedState: { scope, chunk: { path: `src/${index}.ts`, symbol: "selected", line: 1, endLine: 1 } } },
    ]));
    assert.deepEqual(Object.keys(body.state), ["scope0", "scope1"]);
    assert.equal(body.state.scope0.state, "FIRST_SCOPE_SOURCE");
    assert.equal(body.state.scope1.state, "SECOND_SCOPE_SOURCE");
    for (const [index, question] of Object.values(body.questions).entries()) {
      assert.match((question as any).instructions, new RegExp(`state\\.scope${Math.floor(index / 2)}`));
      assert.doesNotMatch((question as any).instructions, new RegExp(`state\\.scope${1 - Math.floor(index / 2)}`));
    }
  } finally { globalThis.fetch = original; }
});

test("single shared TypeSafe decisions use a scope and evidence without an explicit target is rejected", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let body: Record<string, any> = {};
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(SYSTEM_ONE), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "test-key" });
    const scope = { id: "single", state: "COMPLETE_SINGLE_SCOPE" };
    await client.decide!({ purpose: "verdict", state: scope.state, options: ["pass", "fail"], sharedState: { scope } });
    assert.deepEqual(body.state, { scope0: scope });
    assert.match(body.questions.answer.instructions, /state\.scope0/);
    await assert.rejects(() => client.decide!({ purpose: "evidence", state: scope.state, options: ["yes", "no"], sharedState: { scope } }), /explicit source chunk target/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("OpenAI and Laya ignore optional shared wire metadata and retain complete logical states", async () => {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ answers: Object.fromEntries(["answer", "q0", "q1"].map((key) => [key, { probabilities: { pass: 0.9, fail: 0.1, yes: 0.8, no: 0.2 } }])) }), { status: 200 });
  }) as typeof fetch;
  try {
    const scope = { id: "ignored", state: "SHARED_METADATA_NOT_ON_OTHER_PROVIDERS_WIRE" };
    const requests: DecisionRequest[] = [
      { purpose: "verdict", state: "COMPLETE_LOGICAL_VERDICT", options: ["pass", "fail"], sharedState: { scope } },
      { purpose: "evidence", state: "COMPLETE_LOGICAL_EVIDENCE", options: ["yes", "no"], sharedState: { scope, chunk: { path: "src/code.ts", symbol: "selected", line: 1, endLine: 1 } } },
    ];
    for (const config of [{ provider: "openai", model: "decision" }, { provider: "laya", model: "laya" }, { provider: "typesafe", model: "laya" }]) {
      bodies.length = 0;
      const client = createModelClient({ ...config, kind: "decision", apiKeyEnv: "TEST_KEY" }, { TEST_KEY: "test-key" });
      const answers = await client.decideMany!(requests);
      assert.deepEqual(answers.map((answer) => answer.probabilities), [[0.9, 0.1], [0.8, 0.2]]);
      assert.ok(bodies.every((body) => !JSON.stringify(body).includes(scope.state)));
      if (config.provider === "openai") {
        assert.deepEqual(bodies.map((body) => body.input), requests.map((request) => request.state));
      } else assert.deepEqual(bodies[0]!.state, { q0: requests[0]!.state, q1: requests[1]!.state });
    }
  } finally { globalThis.fetch = original; }
});

test("TypeSafe surfaces context-limit failures without a long-context retry", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    return calls.length === 1
      ? new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), { status: 400 })
      : new Response(JSON.stringify(SYSTEM_ONE), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "test-key" });
    await assert.rejects(() => client.decide!({ purpose: "verdict", state: "context", options: ["pass", "fail"] }), /max_tokens_exceeded/);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.headers as Record<string, string>)["TypeSafe-Danger-Zone-Long-Context"], undefined);
  } finally { globalThis.fetch = original; }
});

test("TypeSafe does not retry unrelated errors or repeated context-limit errors", async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, detail, expected] of [[401, { error_type: "unauthorized" }, 1], [400, { error_type: "max_tokens_exceeded" }, 1]] as const) {
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ detail }), { status }); }) as typeof fetch;
      const client = createModelClient({ provider: "typesafe", model: "jev", kind: "decision" }, { TYPESAFE_API_KEY: "test-key" });
      await assert.rejects(() => client.decide!({ purpose: "verdict", state: "context", options: ["pass", "fail"] }), new RegExp(`\\(${status}\\)`));
      assert.equal(calls, expected);
    }
  } finally { globalThis.fetch = original; }
});

test("Ollama usage reads actual evaluation counters and leaves missing usage unavailable", async () => {
  const original = globalThis.fetch;
  let withUsage = true;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    message: { content: "response" },
    ...(withUsage ? { prompt_eval_count: 17, eval_count: 6 } : {}),
  }), { status: 200 })) as typeof fetch;
  try {
    const client = createModelClient({ provider: "ollama", model: "test", kind: "llm" }, {});
    await client.complete({ purpose: "run", system: "", prompt: "claim" });
    assert.deepEqual(client.usage?.(), { inputTokens: 17, outputTokens: 6, available: true });
    withUsage = false;
    await client.complete({ purpose: "run", system: "", prompt: "claim" });
    assert.equal(client.usage?.(), undefined);
    const noUsage = createModelClient({ provider: "ollama", model: "test", kind: "llm" }, {});
    await noUsage.complete({ purpose: "run", system: "", prompt: "claim" });
    assert.equal(noUsage.usage?.(), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI and Anthropic clients accumulate provider token counts", async () => {
  const original = globalThis.fetch;
  let provider: "openai" | "anthropic" = "openai";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "response" } }],
    content: [{ text: "response" }],
    usage: provider === "openai" ? { prompt_tokens: 4, completion_tokens: 2 } : { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 },
  }), { status: 200 })) as typeof fetch;
  try {
    const openai = createModelClient({ provider: "openai", model: "test", apiKeyEnv: "OPENAI_API_KEY", kind: "llm" }, { OPENAI_API_KEY: "test" });
    await openai.complete({ purpose: "run", system: "", prompt: "claim" });
    assert.deepEqual(openai.usage?.(), { inputTokens: 4, outputTokens: 2, available: true });
    provider = "anthropic";
    const anthropic = createModelClient({ provider, model: "test", apiKeyEnv: "ANTHROPIC_API_KEY", kind: "llm" }, { ANTHROPIC_API_KEY: "test" });
    await anthropic.complete({ purpose: "run", system: "", prompt: "claim" });
    assert.deepEqual(anthropic.usage?.(), { inputTokens: 23, outputTokens: 3, available: true });
  } finally {
    globalThis.fetch = original;
  }
});
