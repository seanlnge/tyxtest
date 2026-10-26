import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient } from "../src/model/providers.js";

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
