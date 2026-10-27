import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectIndexedEvidence } from "../src/closure/indexed-evidence.js";
import { runCommand } from "../src/commands/run.js";
import { parseConfig } from "../src/config/config.js";
import type { DecisionRequest, ModelClient, ModelRequest } from "../src/config/types.js";
import { readIndexes, writeIndex } from "../src/surface/index-file.js";
import { createModelClient } from "../src/model/providers.js";
import { readTests } from "../src/surface/surface.js";
import { tempDir } from "./helpers.js";

function fixture(flow = false) {
  const cwd = tempDir("tyxtest-exact-evidence-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/parent/child"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tyxtest/parent/surface.md"), "# Parent\n\nANCESTOR_SEMANTICS\n");
  const markdown = "# Child\n\nCHILD_SEMANTICS\n\n## Selected behavior works\n\nFULL_BODY prose.\n\n```ts\nconst specificationExample = 'FULL_BODY_CODE';\n```\n\nFinal FULL_BODY paragraph.\n";
  fs.writeFileSync(path.join(cwd, "tyxtest/parent/child/surface.md"), markdown);
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), "export function selected() { return 'SELECTED_FRESH'; }\nexport function omitted() { return 'SAME_FILE_SENTINEL'; }\n");
  fs.writeFileSync(path.join(cwd, "src/second.ts"), "export function second() { return 'SECOND_STEP'; }\n");
  fs.writeFileSync(path.join(cwd, "src/first-context.ts"), "export const firstLocal = 'FIRST_LOCAL_CONTEXT';\n");
  fs.writeFileSync(path.join(cwd, "src/second-context.ts"), "export const secondLocal = 'SECOND_LOCAL_CONTEXT';\n");
  fs.writeFileSync(path.join(cwd, "src/context.ts"), "export const explicit = 'EXPLICIT_FULL_CONTEXT';\nexport const extra = 'EXPLICIT_SECOND_LINE';\n");
  fs.writeFileSync(path.join(cwd, "src/other.ts"), "import { selected } from './selected.js';\nexport function caller() { return selected() + 'UNRELATED_FILE_SENTINEL'; }\n");
  const claim = readTests(markdown)[0]!;
  const chunks = [{ path: "src/selected.ts", symbol: "selected" }];
  writeIndex(path.join(cwd, "tyxtest/parent/child/.index.json"), {
    files: [{ path: "src/other.ts", hash: "old", symbols: ["caller"] }], notes: [], entry: ["src/other.ts"],
    closure: [{ path: "src/other.ts", hash: "old" }], closureHash: "old",
    tests: [{ testId: claim.id, chunks: flow ? [{ path: "src/other.ts", symbol: "notAFlowStep" }] : chunks, context: ["src/context.ts"] }],
    flows: flow ? [{ testId: claim.id, closure: [{ path: "src/other.ts", hash: "old" }], steps: [
      { id: "one", text: "First step", chunks, context: ["src/first-context.ts"] },
      { id: "two", text: "Second step", chunks: [{ path: "src/second.ts", symbol: "second" }], context: ["src/second-context.ts"] },
    ] }] : [],
  });
  const config = parseConfig({ indexModel: { provider: "ollama", model: "index" }, runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    reruns: 0, ignoreUnchanged: false, relocateCheck: false, escalate: false, fallback: true });
  return { cwd, config };
}

test("Jev and LLM receive exact fresh chunks, full specification and explicit context; cache ignores unmapped edits", async () => {
  const { cwd, config } = fixture();
  const decisions: DecisionRequest[] = [];
  const completions: ModelRequest[] = [];
  const model: ModelClient = {
    async decide(request) { decisions.push(request); return { probabilities: [0.99, 0.01] }; },
    async complete(request) { completions.push(request); return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/selected.ts", line: 2 }] }); },
  };
  const run = (settings = config) => runCommand({ cwd, config: settings, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal((await run()).results[0]?.verdict, "pass");
  const state = decisions.find((request) => request.purpose === "verdict")!.state;
  for (const token of ["SELECTED_FRESH", "FULL_BODY_CODE", "Final FULL_BODY paragraph", "ANCESTOR_SEMANTICS", "CHILD_SEMANTICS", "EXPLICIT_SECOND_LINE"]) assert.ok(state.includes(token), token);
  assert.ok(decisions.every((request) => !/SAME_FILE_SENTINEL|UNRELATED_FILE_SENTINEL|SECOND_STEP/.test(request.state)));
  const calls = decisions.length;
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), fs.readFileSync(path.join(cwd, "src/selected.ts"), "utf8").replace("SAME_FILE_SENTINEL", "UNMAPPED_EDIT"));
  fs.appendFileSync(path.join(cwd, "src/other.ts"), "export const unrelated = true;\n");
  assert.equal((await run()).results[0]?.cached, true);
  assert.equal(decisions.length, calls);
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), "// Unmapped line-only edit\n" + fs.readFileSync(path.join(cwd, "src/selected.ts"), "utf8"));
  const shifted = await run();
  assert.equal(shifted.results[0]?.cached, true);
  assert.equal(shifted.results[0]?.evidence[0]?.line, 2);
  assert.equal(decisions.length, calls);
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), fs.readFileSync(path.join(cwd, "src/selected.ts"), "utf8").replace("SELECTED_FRESH", "SELECTED_EDIT"));
  assert.equal((await run()).results[0]?.cached, false);
  assert.match(decisions.at(-2)!.state, /SELECTED_EDIT/);
  const llmConfig = { ...config, runnerModel: { kind: "llm" as const, provider: "ollama", model: "llm" } };
  assert.equal((await run(llmConfig)).results[0]?.verdict, "pass");
  assert.match(completions[0]!.prompt, /SELECTED_EDIT/);
  assert.match(completions[0]!.prompt, /EXPLICIT_SECOND_LINE/);
  assert.doesNotMatch(completions[0]!.prompt, /UNMAPPED_EDIT|UNRELATED_FILE_SENTINEL|SECOND_STEP/);
  fs.appendFileSync(path.join(cwd, "src/context.ts"), "export const changed = true;\n");
  assert.equal((await run(llmConfig)).results[0]?.cached, false);
});

test("omitted same-file lines cannot support LLM citations", async () => {
  const { cwd, config } = fixture();
  const result = await runCommand({ cwd, config: { ...config, runnerModel: { kind: "llm", provider: "ollama", model: "llm" } }, env: {}, stdout: () => {},
    model: { async complete() { return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/selected.ts", line: 2 }] }); } } });
  assert.equal(result.results[0]?.verdict, "unsure");
  assert.deepEqual(result.results[0]?.evidence, []);
  const explicit = await runCommand({ cwd, config: { ...config, runnerModel: { kind: "llm", provider: "ollama", model: "llm" } }, all: true, env: {}, stdout: () => {},
    model: { async complete() { return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/context.ts", line: 2 }] }); } } });
  assert.equal(explicit.results[0]?.verdict, "pass");
});

test("triage sees fresh selected evidence and full semantic specification, never omitted source or diff hunks", async () => {
  const { cwd, config } = fixture();
  const requests: DecisionRequest[] = [];
  const model: ModelClient = {
    async complete() { throw new Error("Unexpected LLM"); },
    async decide(request) { requests.push(request); return { probabilities: [0.99, 0.01] }; },
  };
  const run = () => runCommand({ cwd, config: { ...config, triage: true }, model, env: {}, stdout: () => {}, stderr: () => {} });
  await run();
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), fs.readFileSync(path.join(cwd, "src/selected.ts"), "utf8").replace("SELECTED_FRESH", "SELECTED_TRIAGE_EDIT"));
  await run();
  const triage = requests.find((request) => request.purpose === "triage")!.state;
  assert.match(triage, /SELECTED_TRIAGE_EDIT/);
  assert.match(triage, /EXPLICIT_SECOND_LINE/);
  assert.match(triage, /ANCESTOR_SEMANTICS/);
  assert.match(triage, /FULL_BODY_CODE/);
  assert.doesNotMatch(triage, /SAME_FILE_SENTINEL|UNRELATED_FILE_SENTINEL|SECOND_STEP/);
});

test("flow verdict, evidence, escalation, fallback and LLM steps remain isolated with test-wide context", async () => {
  for (const mode of ["decision", "escalation", "fallback", "llm"] as const) {
    const { cwd, config } = fixture(true);
    const states: string[] = [];
    const prompts: string[] = [];
    const model: ModelClient = {
      async decideMany(requests) {
        states.push(...requests.map((request) => request.state));
        if (mode === "fallback") throw new Error("transport failure");
        return requests.map(() => ({ probabilities: mode === "escalation" ? [0.5, 0.5] : [0.99, 0.01] }));
      },
      async complete(request) {
        prompts.push(request.prompt);
        const file = request.prompt.includes("SECOND_STEP") ? "src/second.ts" : "src/selected.ts";
        return JSON.stringify({ verdict: "pass", evidence: [{ file, line: 1 }] });
      },
    };
    const settings = { ...config, escalate: mode === "escalation", ...(mode === "llm" ? { runnerModel: { kind: "llm" as const, provider: "ollama", model: "llm" } } : {}) };
    const run = () => runCommand({ cwd, config: settings, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal((await run()).results[0]?.verdict, "pass", mode);
    for (const input of [...states, ...prompts]) {
      assert.notEqual(input.includes("SELECTED_FRESH"), input.includes("SECOND_STEP"), mode);
      assert.doesNotMatch(input, /SAME_FILE_SENTINEL|UNRELATED_FILE_SENTINEL/);
      assert.match(input, /FULL_BODY_CODE|Final FULL_BODY paragraph/);
      assert.match(input, /ANCESTOR_SEMANTICS/);
    }
    for (const input of [...states.filter((state) => !state.includes("Chunk src/")), ...prompts]) {
      assert.match(input, /EXPLICIT_FULL_CONTEXT/);
      assert.equal(input.includes("FIRST_LOCAL_CONTEXT"), input.includes("SELECTED_FRESH"));
      assert.equal(input.includes("SECOND_LOCAL_CONTEXT"), input.includes("SECOND_STEP"));
    }
    if (mode === "fallback") {
      assert.equal((await run()).results[0]?.cached, false);
      assert.equal(prompts.length, 4);
    }
  }
});

test("missing mapped symbols never fall back to file chunks; split chunks retain faithful source spans", () => {
  const { cwd } = fixture();
  const missing = collectIndexedEvidence({ cwd, chunks: [{ path: "src/selected.ts", symbol: "disappeared" }] });
  assert.equal(missing.missing, true);
  assert.equal(missing.bundle, "");
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), "export function selected() {\n if (true) return 'GUARD';\n return 'TAIL';\n}\nexport function omitted() { return 'SAME_FILE_SENTINEL'; }\n");
  const split = collectIndexedEvidence({ cwd, chunks: [{ path: "src/selected.ts", symbol: "selected#1" }], maxTokens: 1 });
  assert.equal(split.missing, false);
  assert.match(split.bundle, /GUARD/);
  assert.match(split.bundle, /TAIL/);
  assert.doesNotMatch(split.bundle, /SAME_FILE_SENTINEL/);
  assert.deepEqual(split.ranges.map(({ id, ...range }) => range), [{ path: "src/selected.ts", line: 1, endLine: 4 }]);
});

test("failed flow fallbacks retain their diagnostic and never cache or invoke relocation", async () => {
  const { cwd, config } = fixture(true);
  let completions = 0;
  const model: ModelClient = {
    async decideMany() { throw new Error('Model request failed (400): {"error_type":"max_tokens_exceeded","secret":"PRIVATE"}'); },
    async complete(request) {
      assert.equal(request.purpose, "run");
      completions += 1;
      return JSON.stringify({ verdict: "fail", evidence: [], explanation: "Not implemented" });
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runCommand({ cwd, config: { ...config, relocateCheck: true }, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal(result.results[0]?.verdict, "fail");
    assert.equal(result.results[0]?.cached, false);
    assert.ok(result.results[0]?.fallback);
    assert.match(result.results[0]?.fallbackReason ?? "", /provider context limit/);
    assert.doesNotMatch(result.results[0]?.fallbackReason ?? "", /PRIVATE/);
  }
  assert.equal(completions, 4);
});

test("cached LLM citations follow line-only shifts without another completion", async () => {
  const { cwd, config } = fixture();
  let completions = 0;
  const model: ModelClient = { async complete() { completions += 1; return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/selected.ts", line: 1 }] }); } };
  const run = () => runCommand({ cwd, config: { ...config, runnerModel: { kind: "llm", provider: "ollama", model: "llm" } }, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal((await run()).results[0]?.verdict, "pass");
  fs.writeFileSync(path.join(cwd, "src/selected.ts"), "// Unmapped shift\n\n" + fs.readFileSync(path.join(cwd, "src/selected.ts"), "utf8"));
  const shifted = await run();
  assert.equal(shifted.results[0]?.cached, true);
  assert.equal(shifted.results[0]?.evidence[0]?.line, 3);
  assert.equal(completions, 1);
});

test("actual TypeSafe fetch payload sends selected source and full body once despite multiple evidence questions", async () => {
  const { cwd, config } = fixture();
  const index = readIndexes(cwd).get("parent/child")!;
  index.tests![0]!.chunks.push({ path: "src/second.ts", symbol: "second" });
  writeIndex(path.join(cwd, "tyxtest/parent/child/.index.json"), index);
  const original = globalThis.fetch;
  let body: Record<string, any> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      { probabilities: Object.fromEntries(Object.keys((question as any).criteria).map((option, position) => [option, position === 0 ? 1 : 0])) },
    ])) }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = createModelClient(config.runnerModel!, { TYPESAFE_API_KEY: "offline-test-key" });
    const result = await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal(result.results[0]?.verdict, "pass");
    assert.deepEqual(Object.keys(body.state), ["scope0"]);
    assert.deepEqual(Object.keys(body.questions), ["q0", "q1", "q2"]);
    for (const sentinel of ["SELECTED_FRESH", "SECOND_STEP", "FULL_BODY_CODE", "Final FULL_BODY paragraph.", "ANCESTOR_SEMANTICS", "EXPLICIT_SECOND_LINE"]) {
      assert.equal(JSON.stringify(body).split(sentinel).length - 1, 1, sentinel);
    }
    assert.doesNotMatch(JSON.stringify(body), /SAME_FILE_SENTINEL|UNRELATED_FILE_SENTINEL|FIRST_LOCAL_CONTEXT|SECOND_LOCAL_CONTEXT/);
    for (const question of Object.values(body.questions)) assert.match((question as any).instructions, /Use only `state\.scope0`/);
    assert.match(body.questions.q1.instructions, /src\/second\.ts#second.*lines 1-1/);
    assert.match(body.questions.q2.instructions, /src\/selected\.ts#selected.*lines 1-1/);
    assert.deepEqual(Object.keys(body.questions.q0.criteria), ["pass", "fail"]);
    assert.deepEqual(Object.keys(body.questions.q1.criteria), ["yes", "no"]);
  } finally { globalThis.fetch = original; }
});

test("actual TypeSafe flow payload shares each step once without promoting other steps' context", async () => {
  const { cwd, config } = fixture(true);
  const original = globalThis.fetch;
  let body: Record<string, any> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      { probabilities: Object.fromEntries(Object.keys((question as any).criteria).map((option, position) => [option, position === 0 ? 1 : 0])) },
    ])) }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = createModelClient(config.runnerModel!, { TYPESAFE_API_KEY: "offline-test-key" });
    const result = await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal(result.results[0]?.verdict, "pass");
    assert.deepEqual(Object.keys(body.state), ["scope0", "scope1"]);
    assert.match(body.state.scope0.id, /\/step\/one$/);
    assert.match(body.state.scope1.id, /\/step\/two$/);
    assert.match(body.state.scope0.state, /SELECTED_FRESH/);
    assert.match(body.state.scope0.state, /FIRST_LOCAL_CONTEXT/);
    assert.doesNotMatch(body.state.scope0.state, /SECOND_STEP|SECOND_LOCAL_CONTEXT/);
    assert.match(body.state.scope1.state, /SECOND_STEP/);
    assert.match(body.state.scope1.state, /SECOND_LOCAL_CONTEXT/);
    assert.doesNotMatch(body.state.scope1.state, /SELECTED_FRESH|FIRST_LOCAL_CONTEXT/);
    for (const scope of Object.values(body.state)) {
      for (const sentinel of ["FULL_BODY_CODE", "EXPLICIT_FULL_CONTEXT"]) assert.equal(JSON.stringify(scope).split(sentinel).length - 1, 1);
    }
    assert.equal(JSON.stringify(body).split("SELECTED_FRESH").length - 1, 1);
    assert.equal(JSON.stringify(body).split("SECOND_STEP").length - 1, 1);
    assert.doesNotMatch(JSON.stringify(body), /SAME_FILE_SENTINEL|UNRELATED_FILE_SENTINEL/);
    for (let index = 0; index < 4; index += 1) assert.match(body.questions[`q${index}`].instructions, new RegExp(`state\\.scope${Math.floor(index / 2)}`));
    assert.match(body.questions.q1.instructions, /src\/selected\.ts#selected/);
    assert.match(body.questions.q3.instructions, /src\/second\.ts#second/);
  } finally { globalThis.fetch = original; }
});

test("shared TypeSafe scopes do not leak across concurrent test jobs using the same client", async () => {
  const { cwd, config } = fixture();
  const markdownFile = path.join(cwd, "tyxtest/parent/child/surface.md");
  fs.appendFileSync(markdownFile, "\n## Another independent claim\n\nSECOND_JOB_SPEC\n");
  const second = readTests(fs.readFileSync(markdownFile, "utf8"))[1]!;
  const index = readIndexes(cwd).get("parent/child")!;
  index.tests!.push({ testId: second.id, chunks: [{ path: "src/second.ts", symbol: "second" }], context: [] });
  writeIndex(path.join(cwd, "tyxtest/parent/child/.index.json"), index);
  const original = globalThis.fetch;
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      { probabilities: Object.fromEntries(Object.keys((question as any).criteria).map((option, position) => [option, position === 0 ? 1 : 0])) },
    ])) }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = createModelClient(config.runnerModel!, { TYPESAFE_API_KEY: "offline-test-key" });
    const result = await runCommand({ cwd, config: { ...config, concurrency: 2 }, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.ok(result.results.every((test) => test.verdict === "pass"));
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => Object.keys(body.state).join() === "scope0"));
    const firstWire = bodies.find((body) => body.state.scope0.state.includes("SELECTED_FRESH"))!;
    const secondWire = bodies.find((body) => body.state.scope0.state.includes("SECOND_JOB_SPEC"))!;
    assert.notEqual(firstWire.state.scope0.id, secondWire.state.scope0.id);
    assert.doesNotMatch(JSON.stringify(firstWire), /SECOND_JOB_SPEC|SECOND_STEP/);
    assert.doesNotMatch(JSON.stringify(secondWire), /SELECTED_FRESH|FULL_BODY_CODE|EXPLICIT_FULL_CONTEXT/);
  } finally { globalThis.fetch = original; }
});
