import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withRateLimitBackoff } from "../src/backoff.js";
import { chunkSource, evidenceForChunks, evidenceIdentity } from "../src/chunk.js";
import { computeSurfaceClosure, hashClosure } from "../src/closure.js";
import { parseConfig } from "../src/config.js";
import { generateCommand } from "../src/generate.js";
import { hashContent } from "../src/hash.js";
import { indexCommand } from "../src/index-command.js";
import { readIndex, writeIndex, type FlowRecord } from "../src/index-file.js";
import { mapPool } from "../src/pool.js";
import { readPending } from "../src/pending.js";
import { formatReport, type ReportedTest } from "../src/reporter.js";
import { runCommand } from "../src/run.js";
import type { DecisionRequest, ModelClient, ModelRequest, TyxtestConfig } from "../src/types.js";
import { scriptedPrompter, tempDir } from "./helpers.js";

function config(overrides: Record<string, unknown> = {}): TyxtestConfig {
  return parseConfig({
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    ignoreUnchanged: false,
    reruns: 0,
    ...overrides,
  });
}

function reported(overrides: Partial<ReportedTest> = {}): ReportedTest {
  return {
    surface: "login",
    id: "submit-exists",
    text: "There is a submit button",
    verdict: "pass",
    cached: false,
    runs: ["pass"],
    evidence: [{ file: "src/login.ts", line: 4, symbol: "SubmitButton", hash: "abcd1234", id: "login.ts#SubmitButton@abcd1234" }],
    explanation: "the button is in the form",
    ...overrides,
  };
}

test("chunks split above the token cap and a class stays a class", () => {
  const source = `export class Cart {\n  add() {\n    return 1;\n  }\n  remove() {\n    return 2;\n  }\n}\n`;
  const whole = chunkSource("src/cart.ts", source, 4000);
  assert.equal(whole.length, 1);
  assert.equal(whole[0]?.kind, "class");
  assert.equal(whole[0]?.symbol, "Cart");
  const split = chunkSource("src/cart.ts", source, 1);
  assert.ok(split.length >= 2);
  assert.ok(split.every((chunk) => chunk.symbol === "Cart"));
  assert.ok(split.some((chunk) => chunk.name === "add"));
  assert.ok(split.some((chunk) => chunk.name === "remove"));
});

test("evidence identity is symbol plus content hash, with file:line only for display", () => {
  const text = "export function handleSubmit() {\n  return true;\n}\n";
  const identity = evidenceIdentity("src/LoginForm.tsx", "handleSubmit", text);
  assert.equal(identity.hash, hashContent(text).slice(0, 8));
  assert.equal(identity.id, `LoginForm.tsx#handleSubmit@${identity.hash}`);
  const chunks = chunkSource("src/LoginForm.tsx", text);
  const evidence = evidenceForChunks(chunks, [1]);
  assert.equal(evidence[0]?.file, "src/LoginForm.tsx");
  assert.equal(evidence[0]?.line, 1);
  assert.equal(evidence[0]?.symbol, "handleSubmit");
  assert.equal(evidence[0]?.id, evidenceIdentity("src/LoginForm.tsx", "handleSubmit", chunks[0]?.text ?? "").id);
});

test("the reporter prints evidence for fail and unsure, and for pass only with --verbose", () => {
  const pass = formatReport([reported()], false, false);
  assert.match(pass, /pass  \[submit-exists\]/);
  assert.doesNotMatch(pass, /src\/login\.ts:4/);
  assert.doesNotMatch(pass, /the button is in the form/);
  const verbose = formatReport([reported()], false, true);
  assert.match(verbose, /src\/login\.ts:4/);
  assert.match(verbose, /the button is in the form/);
  const fail = formatReport([reported({ verdict: "fail", runs: ["fail"] })], false, false);
  assert.match(fail, /src\/login\.ts:4/);
  const unsure = formatReport([reported({ verdict: "unsure", runs: ["unsure"] })], false, false);
  assert.match(unsure, /src\/login\.ts:4/);
});

test("mapPool never runs more than the concurrency limit", async () => {
  let inflight = 0;
  let max = 0;
  await mapPool([1, 2, 3, 4], 2, async () => {
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return 0;
  });
  assert.equal(max, 2);
});

test("a run keeps at most `concurrency` verdict calls in flight", async () => {
  const cwd = tempDir("tyxtest-pool-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function SubmitButton() {\n  return \"submit\";\n}\n");
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    "---\nsurface: Login\nentry: src/login.ts\n---\n- [a] claim a\n- [b] claim b\n- [c] claim c\n- [d] claim d\n",
  );
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["SubmitButton"] })),
    notes: [],
  });
  let inflight = 0;
  let max = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let verdicts = 0;
  const model: ModelClient = {
    async decide(request: DecisionRequest) {
      if (request.purpose !== "verdict") return { probabilities: [1, 0] };
      inflight += 1;
      max = Math.max(max, inflight);
      verdicts += 1;
      if (verdicts === 2) release();
      await gate;
      inflight -= 1;
      return { probabilities: [0.99, 0.01] };
    },
    async complete() {
      throw new Error("LLM should not be called");
    },
  };
  await runCommand({ cwd, model, config: config({ concurrency: 2 }), interactive: true, env: {} });
  assert.equal(max, 2);
});

test("rate-limit errors back off and then succeed", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const value = await withRateLimitBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("Model request failed (429): rate limit");
      return "ok";
    },
    {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [50, 100]);
  const quiet: number[] = [];
  await assert.rejects(
    () =>
      withRateLimitBackoff(
        async () => {
          throw new Error("nope");
        },
        {
          sleep: async (ms: number) => {
            quiet.push(ms);
          },
        },
      ),
    /nope/,
  );
  assert.deepEqual(quiet, []);
});

function writeFlowRepo(text: string): { cwd: string; indexPath: string } {
  const cwd = tempDir("tyxtest-flow-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "landing"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/landing.ts"), "export function Landing() {\n  return \"cta\";\n}\n");
  fs.writeFileSync(path.join(cwd, "src/pricing.ts"), "export function Pricing() {\n  return \"plan\";\n}\n");
  fs.writeFileSync(path.join(cwd, "src/checkout.ts"), "export function Checkout() {\n  return \"stripe\";\n}\n");
  fs.writeFileSync(
    path.join(cwd, "tyxtest/landing/surface.md"),
    `---\nsurface: Landing\nentry: src/landing.ts\n---\n- [checkout-path] ${text}\n`,
  );
  return { cwd, indexPath: path.join(cwd, "tyxtest/landing/.index.json") };
}

function flowRecord(cwd: string, steps: FlowRecord["steps"]): FlowRecord {
  const parts = steps.map((step) => computeSurfaceClosure({ cwd, entry: step.entry, depth: null, parentClosure: null }));
  const byPath = new Map<string, { hash: string; path: string }>();
  for (const part of parts) {
    for (const file of part.files) byPath.set(file.path, file);
  }
  return {
    testId: "checkout-path",
    steps,
    closure: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

const FLOW_STEPS: FlowRecord["steps"] = [
  { id: "cta", text: "landing has a CTA to pricing", entry: "src/landing.ts" },
  { id: "plan", text: "pricing has a plan button", entry: "src/pricing.ts" },
  { id: "pay", text: "checkout redirects to Stripe", entry: "src/checkout.ts" },
];

test("index stores flow steps and the union of their closures", async () => {
  const { cwd, indexPath } = writeFlowRepo("from landing the user reaches Stripe checkout in at most 5 clicks");
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      assert.equal(request.purpose, "index");
      return JSON.stringify({
        files: [{ path: "src/landing.ts", symbols: ["Landing"] }],
        notes: [],
        flows: [{ testId: "checkout-path", steps: FLOW_STEPS }],
      });
    },
  };
  await indexCommand({ cwd, model, prompter: scriptedPrompter([]), interactive: true, config: config(), env: {} });
  const index = readIndex(indexPath);
  const flow = index.flows?.find((item) => item.testId === "checkout-path");
  assert.ok(flow);
  assert.equal(flow.steps.length, 3);
  assert.deepEqual(
    flow.closure.map((file) => file.path),
    ["src/checkout.ts", "src/landing.ts", "src/pricing.ts"],
  );
  assert.equal(flow.closure.length, new Set(flow.closure.map((file) => file.path)).size);
});

test("a flow longer than at most N fails without a model call", async () => {
  const { cwd, indexPath } = writeFlowRepo("the user reaches checkout in at most 2 clicks");
  const landing = computeSurfaceClosure({ cwd, entry: "src/landing.ts", depth: null, parentClosure: null });
  const flow = flowRecord(cwd, FLOW_STEPS);
  writeIndex(indexPath, {
    closure: landing.files,
    closureHash: hashClosure(landing.files),
    entry: ["src/landing.ts"],
    files: landing.files.map((file) => ({ ...file, symbols: ["Landing"] })),
    notes: [],
    flows: [flow],
  });
  let decides = 0;
  const model: ModelClient = {
    async decide() {
      decides += 1;
      return { probabilities: [0.99, 0.01] };
    },
    async complete() {
      throw new Error("index model should not be called");
    },
  };
  const outcome = await runCommand({ cwd, model, config: config(), interactive: true, env: {} });
  assert.equal(decides, 0);
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.match(outcome.results[0]?.explanation ?? "", /3 steps/);
  assert.match(outcome.results[0]?.explanation ?? "", /at most 2/);
});

test("a flow within at most N checks each step and does not ask the model to count", async () => {
  const { cwd, indexPath } = writeFlowRepo("the user reaches checkout in at most 5 clicks");
  const landing = computeSurfaceClosure({ cwd, entry: "src/landing.ts", depth: null, parentClosure: null });
  const steps = FLOW_STEPS.slice(0, 2);
  writeIndex(indexPath, {
    closure: landing.files,
    closureHash: hashClosure(landing.files),
    entry: ["src/landing.ts"],
    files: landing.files.map((file) => ({ ...file, symbols: ["Landing"] })),
    notes: [],
    flows: [flowRecord(cwd, steps)],
  });
  const states: string[] = [];
  const model: ModelClient = {
    async decide(request: DecisionRequest) {
      if (request.purpose === "verdict") states.push(request.state);
      if (request.purpose === "verdict") return { probabilities: [0.99, 0.01] };
      return { probabilities: [1, 0] };
    },
    async complete() {
      throw new Error("index model should not be called");
    },
  };
  const outcome = await runCommand({ cwd, model, config: config(), interactive: true, env: {} });
  assert.equal(states.length, 2);
  assert.ok(states.every((state) => !/at most/i.test(state)));
  assert.match(states[0] ?? "", /landing has a CTA/);
  assert.match(states[1] ?? "", /pricing has a plan button/);
  assert.equal(outcome.results[0]?.verdict, "pass");
});

test("a failed flow step records a pending suggestion and does not write the index", async () => {
  const { cwd, indexPath } = writeFlowRepo("the user reaches checkout in at most 5 clicks");
  const landing = computeSurfaceClosure({ cwd, entry: "src/landing.ts", depth: null, parentClosure: null });
  writeIndex(indexPath, {
    closure: landing.files,
    closureHash: hashClosure(landing.files),
    entry: ["src/landing.ts"],
    files: landing.files.map((file) => ({ ...file, symbols: ["Landing"] })),
    notes: [],
    flows: [flowRecord(cwd, FLOW_STEPS.slice(0, 2))],
  });
  const before = fs.readFileSync(indexPath);
  const purposes: string[] = [];
  const model: ModelClient = {
    async decide(request: DecisionRequest) {
      if (request.purpose === "verdict") return { probabilities: [0.01, 0.99] };
      return { probabilities: [0, 1] };
    },
    async complete(request: ModelRequest) {
      purposes.push(request.purpose);
      return JSON.stringify({ found: true, path: "src/billing.ts" });
    },
  };
  const outcome = await runCommand({ cwd, model, config: config(), interactive: true, env: {} });
  assert.deepEqual(purposes, ["relocate"]);
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.match(outcome.results[0]?.explanation ?? "", /src\/billing\.ts/);
  assert.deepEqual(fs.readFileSync(indexPath), before);
  const pending = readPending(cwd);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.surface, "landing");
  assert.equal(pending[0]?.testId, "checkout-path");
  const results = JSON.parse(fs.readFileSync(path.join(cwd, ".tyxtest/results.json"), "utf8")) as {
    tests: Array<Record<string, unknown>>;
  };
  assert.equal(results.tests[0]?.indexStale, undefined);
});

function writeLogin(cwd: string, source: string): string {
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), source);
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n",
  );
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  const indexPath = path.join(cwd, "tyxtest/login/.index.json");
  writeIndex(indexPath, {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["SubmitButton"] })),
    notes: [],
  });
  return indexPath;
}

test("escalation records a pending suggestion locally and does not write the index", async () => {
  const cwd = tempDir("tyxtest-pending-");
  const indexPath = writeLogin(cwd, "export function SubmitButton() {\n  return \"submit\";\n}\n");
  const before = fs.readFileSync(indexPath);
  const stderr: string[] = [];
  const runner: ModelClient = {
    async decide() {
      return { probabilities: [0.5, 0.5] };
    },
    async complete() {
      throw new Error("runner should escalate");
    },
  };
  const escalate: ModelClient = {
    async complete() {
      return JSON.stringify({
        verdict: "unsure",
        evidence: [],
        explanation: "the map looks incomplete",
        notes: [],
        indexStale: true,
      });
    },
  };
  const outcome = await runCommand({
    cwd,
    model: runner,
    escalateModel: escalate,
    config: config(),
    interactive: true,
    env: {},
    stderr: (message) => stderr.push(message),
  });
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/.pending.json")), true);
  const pending = readPending(cwd);
  assert.equal(pending[0]?.surface, "login");
  assert.equal(pending[0]?.testId, "submit-exists");
  assert.ok(stderr.some((line) => line === "login/submit-exists: index may be stale; run `tyxtest index --pending`."));
});

test("CI warns about a stale index and does not write pending.json", async () => {
  const cwd = tempDir("tyxtest-ci-pending-");
  const indexPath = writeLogin(cwd, "export function SubmitButton() {\n  return \"submit\";\n}\n");
  const before = fs.readFileSync(indexPath);
  const stderr: string[] = [];
  await runCommand({
    cwd,
    model: {
      async decide() {
        return { probabilities: [0.5, 0.5] };
      },
      async complete() {
        throw new Error("runner should escalate");
      },
    },
    escalateModel: {
      async complete() {
        return JSON.stringify({ verdict: "fail", evidence: [], explanation: "stale", notes: [], indexStale: true });
      },
    },
    config: config(),
    interactive: false,
    env: { CI: "true" },
    stderr: (message) => stderr.push(message),
  });
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/.pending.json")), false);
  assert.ok(stderr.some((line) => line.includes("tyxtest index --pending")));
});

test("index --pending reindexes only the flagged surface and clears it", async () => {
  const cwd = tempDir("tyxtest-index-pending-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  for (const name of ["login", "billing"]) {
    fs.mkdirSync(path.join(cwd, "tyxtest", name), { recursive: true });
    fs.writeFileSync(path.join(cwd, `src/${name}.ts`), `export function ${name}() {\n  return 1;\n}\n`);
    fs.writeFileSync(
      path.join(cwd, `tyxtest/${name}/surface.md`),
      `---\nsurface: ${name}\nentry: src/${name}.ts\n---\n- [exists] ${name} exists\n`,
    );
    const closure = computeSurfaceClosure({ cwd, entry: `src/${name}.ts`, depth: null, parentClosure: null });
    writeIndex(path.join(cwd, `tyxtest/${name}/.index.json`), {
      closure: closure.files,
      closureHash: closure.closureHash,
      entry: [`src/${name}.ts`],
      files: closure.files.map((file) => ({ ...file, symbols: [name] })),
      notes: ["old"],
    });
  }
  fs.writeFileSync(
    path.join(cwd, "tyxtest/.pending.json"),
    `${JSON.stringify({ suggestions: [{ surface: "login", testId: "exists", reason: "index may be stale" }] }, null, 2)}\n`,
  );
  const billingBefore = fs.readFileSync(path.join(cwd, "tyxtest/billing/.index.json"));
  const seen: string[] = [];
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      seen.push(request.prompt);
      const surface = request.prompt.includes("Surface: login") ? "login" : "billing";
      return JSON.stringify({ files: [{ path: `src/${surface}.ts`, symbols: [surface] }], notes: ["refreshed"] });
    },
  };
  const logs: string[] = [];
  await indexCommand({
    cwd,
    pending: true,
    model,
    interactive: true,
    config: config(),
    env: {},
    prompter: { async ask() { return ""; }, warn() {}, log(message: string) { logs.push(message); } },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /Surface: login/);
  assert.match(seen[0] ?? "", /Pending suggestions/);
  const login = readIndex(path.join(cwd, "tyxtest/login/.index.json"));
  assert.deepEqual(login.notes, ["refreshed"]);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/billing/.index.json")), billingBefore);
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/.pending.json")), false);
  assert.ok(logs.includes("indexed login"));
});

test("generate asks one batched prompt up to maxQuestions and flags the overflow", async () => {
  const cwd = tempDir("tyxtest-questions-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function LoginForm() {\n  return \"submit\";\n}\n");
  const asks: string[] = [];
  const prompter = scriptedPrompter(["", "accept"]);
  const originalAsk = prompter.ask.bind(prompter);
  prompter.ask = async (question: string) => {
    asks.push(question);
    return originalAsk(question);
  };
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      if (request.purpose === "generate") {
        return JSON.stringify({
          surfaces: [
            {
              slug: "login",
              name: "Login",
              entry: "src/login.ts",
              tests: [{ id: "submit-exists", text: "There is a submit button" }],
            },
          ],
          questions: [
            { prompt: "Which file is the login form?", guess: "src/login.ts" },
            { prompt: "Should empty passwords be rejected?", guess: "yes" },
          ],
        });
      }
      return JSON.stringify({ files: [{ path: "src/login.ts", symbols: ["LoginForm"] }], notes: [] });
    },
  };
  await generateCommand({
    cwd,
    model,
    prompter,
    interactive: true,
    config: config({ maxQuestions: 1 }),
    env: {},
  });
  const questionAsks = asks.filter((question) => question.startsWith("Answer these"));
  assert.equal(questionAsks.length, 1);
  assert.match(questionAsks[0] ?? "", /Which file is the login form/);
  assert.doesNotMatch(questionAsks[0] ?? "", /empty passwords/);
  assert.ok(prompter.logs.some((line) => line.includes("over maxQuestions") && line.includes("empty passwords")));
});

test("maxQuestions 0 never asks the question prompt", async () => {
  const cwd = tempDir("tyxtest-questions-zero-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function LoginForm() {\n  return \"submit\";\n}\n");
  const prompter = scriptedPrompter(["accept"]);
  const asks: string[] = [];
  const originalAsk = prompter.ask.bind(prompter);
  prompter.ask = async (question: string) => {
    asks.push(question);
    return originalAsk(question);
  };
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      if (request.purpose === "generate") {
        return JSON.stringify({
          surfaces: [
            {
              slug: "login",
              name: "Login",
              entry: "src/login.ts",
              tests: [{ id: "submit-exists", text: "There is a submit button" }],
            },
          ],
          questions: [{ prompt: "Which file is the login form?", guess: "src/login.ts" }],
        });
      }
      return JSON.stringify({ files: [{ path: "src/login.ts", symbols: ["LoginForm"] }], notes: [] });
    },
  };
  await generateCommand({
    cwd,
    model,
    prompter,
    interactive: true,
    config: config({ maxQuestions: 0 }),
    env: {},
  });
  assert.equal(asks.some((question) => question.startsWith("Answer these")), false);
  assert.ok(prompter.logs.some((line) => line.includes("over maxQuestions") && line.includes("Which file is the login form")));
});
