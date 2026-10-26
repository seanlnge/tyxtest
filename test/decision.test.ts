import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { chunkClosure } from "../src/closure/chunk.js";
import { computeSurfaceClosure } from "../src/closure/closure.js";
import { parseConfig } from "../src/config/config.js";
import { writeIndex } from "../src/surface/index-file.js";
import { formatReport } from "../src/verdict/reporter.js";
import { runCommand } from "../src/commands/run.js";
import type { DecisionRequest, ModelClient, TyxtestConfig } from "../src/config/types.js";
import { tempDir } from "./helpers.js";

const SOURCE = `export function header() {
  return 1;
}

export function SubmitButton() {
  return "submit";
}
`;

function config(overrides: Record<string, unknown> = {}): TyxtestConfig {
  return parseConfig({
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    ignoreUnchanged: false,
    reruns: 0,
    ...overrides,
  });
}

function scaffold(source = SOURCE): string {
  const cwd = tempDir("tyxtest-decision-");
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), source);
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n",
  );
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["header", "SubmitButton"] })),
    notes: [],
    tests: [
      {
        testId: "submit-exists",
        chunks: [
          { path: "src/login.ts", symbol: "header" },
          { path: "src/login.ts", symbol: "SubmitButton" },
        ],
      },
    ],
  });
  return cwd;
}

function decisionRunner(pPass: number, yesFor: (state: string) => number): ModelClient & { decides: DecisionRequest[]; completes: number } {
  const decides: DecisionRequest[] = [];
  return {
    decides,
    completes: 0,
    async decide(request) {
      decides.push(request);
      if (request.purpose === "verdict") return { probabilities: [pPass, 1 - pPass] };
      const yes = yesFor(request.state);
      return { probabilities: [yes, 1 - yes] };
    },
    async complete() {
      this.completes += 1;
      throw new Error("LLM should not be called");
    },
  };
}

test("decision thresholds pass and fail without an LLM call, and evidence lines come from the chunker", async () => {
  const cwd = scaffold();
  const chunks = chunkClosure(cwd, [{ path: "src/login.ts" }]);
  const submit = chunks.find((chunk) => chunk.name === "SubmitButton");
  const header = chunks.find((chunk) => chunk.name === "header");
  assert.ok(submit);
  assert.ok(header);
  assert.notEqual(submit.line, header.line);

  const passRunner = decisionRunner(0.95, (state) => (state.includes("SubmitButton") ? 0.91 : 0.2));
  const passed = await runCommand({ cwd, model: passRunner, config: config(), interactive: true, env: {} });
  assert.equal(passed.results[0]?.verdict, "pass");
  assert.equal(passed.exitCode, 0);
  assert.equal(passRunner.completes, 0);
  const evidence = passed.results[0]?.evidence[0];
  assert.equal(evidence?.file, "src/login.ts");
  assert.equal(evidence?.line, submit.line);
  assert.equal(evidence?.symbol, "SubmitButton");
  assert.match(evidence?.id ?? "", /^login\.ts#SubmitButton@[a-f0-9]{8}$/);
  assert.equal(
    passRunner.decides.every((request) => !("line" in request) && request.options.join(",") !== ""),
    true,
  );

  const failCwd = scaffold();
  const failChunks = chunkClosure(failCwd, [{ path: "src/login.ts" }]);
  const failRunner = decisionRunner(0.05, () => 0.1);
  const failed = await runCommand({ cwd: failCwd, model: failRunner, config: config(), interactive: true, env: {} });
  assert.equal(failed.results[0]?.verdict, "fail");
  assert.equal(failed.exitCode, 1);
  assert.equal(failRunner.completes, 0);
  assert.deepEqual(
    failed.results[0]?.evidence.map((citation) => citation.line).sort(),
    failChunks.map((chunk) => chunk.line).sort(),
  );
});

test("escalate false reports unsure and does not call an LLM", async () => {
  const cwd = scaffold();
  const runner = decisionRunner(0.5, () => 0.5);
  const outcome = await runCommand({
    cwd,
    model: runner,
    config: config({ escalate: false }),
    interactive: true,
    env: {},
  });
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.equal(outcome.exitCode, 0);
  assert.equal(runner.completes, 0);
  assert.equal(runner.decides[0]?.purpose, "verdict");
  assert.ok(runner.decides.slice(1).every((request) => request.purpose === "evidence"));
});

test("runnerModel.kind llm skips the decision model", async () => {
  const cwd = scaffold();
  let decisions = 0;
  const model: ModelClient = {
    async decide() {
      decisions += 1;
      throw new Error("decision model should not be called");
    },
    async complete() {
      return JSON.stringify({
        verdict: "pass",
        evidence: [{ file: "src/login.ts", line: 1 }],
        explanation: "cited",
      });
    },
  };
  const outcome = await runCommand({
    cwd,
    model,
    config: config({ runnerModel: { kind: "llm", provider: "ollama", model: "runner" } }),
    interactive: true,
    env: {},
  });
  assert.equal(decisions, 0);
  assert.equal(outcome.results[0]?.verdict, "pass");
});

test("an escalated pass with no citation becomes unsure", async () => {
  const cwd = scaffold();
  const runner = decisionRunner(0.5, () => 0.5);
  let llmCalls = 0;
  const escalate: ModelClient = {
    async complete() {
      llmCalls += 1;
      return JSON.stringify({ verdict: "pass", evidence: [], explanation: "no citation" });
    },
  };
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ escalate: true, reruns: 0 }),
    interactive: true,
    env: {},
  });
  assert.equal(llmCalls, 1);
  assert.equal(runner.completes, 0);
  assert.equal(outcome.results[0]?.verdict, "unsure");
});

test("ignoreUnchanged skips tests outside the diff", async () => {
  const cwd = tempDir("tyxtest-diff-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  const writeSurface = (name: string, file: string, source: string): void => {
    fs.writeFileSync(path.join(cwd, "src", file), source);
    fs.mkdirSync(path.join(cwd, "tyxtest", name), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "tyxtest", name, "surface.md"),
      `---\nsurface: ${name}\nentry: src/${file}\n---\n- [${name}-exists] ${name} exists\n`,
    );
    const closure = computeSurfaceClosure({ cwd, entry: `src/${file}`, depth: null, parentClosure: null });
    writeIndex(path.join(cwd, "tyxtest", name, ".index.json"), {
      closure: closure.files,
      closureHash: closure.closureHash,
      entry: [`src/${file}`],
      files: closure.files.map((entry) => ({ ...entry, symbols: [] })),
      notes: [],
      tests: [
        {
          testId: `${name}-exists`,
          chunks: [{ path: `src/${file}`, symbol: name.charAt(0).toUpperCase() + name.slice(1) }],
        },
      ],
    });
  };
  writeSurface("login", "login.ts", 'export function Login() {\n  return "login";\n}\n');
  writeSurface("about", "about.ts", 'export function About() {\n  return "about";\n}\n');
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Tyxtest", "-c", "user.email=tyxtest@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
    cwd,
    stdio: "ignore",
  });
  fs.appendFileSync(path.join(cwd, "src/login.ts"), "export const edited = true;\n");

  let decisions = 0;
  const model: ModelClient = {
    async decide(request) {
      decisions += 1;
      if (request.purpose === "verdict") return { probabilities: [0.99, 0.01] };
      return { probabilities: [0.8, 0.2] };
    },
    async complete() {
      throw new Error("LLM should not be called");
    },
  };
  let report = "";
  const outcome = await runCommand({
    cwd,
    model,
    config: config({ ignoreUnchanged: true, baseRef: "main" }),
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  const skipped = outcome.results.filter((result) => result.verdict === "skipped");
  const ran = outcome.results.filter((result) => result.verdict !== "skipped");
  assert.deepEqual(
    skipped.map((result) => result.surface),
    ["about"],
  );
  assert.deepEqual(
    ran.map((result) => result.surface),
    ["login"],
  );
  assert.equal(ran[0]?.verdict, "pass");
  assert.ok(decisions > 0);
  assert.match(report, /skipped \(unchanged\)/);
  assert.match(formatReport(outcome.results, false), /skipped \(unchanged\)/);
});

test("each verdict sees the complete closure while evidence stays selected per test", async () => {
  const cwd = tempDir("tyxtest-chunks-");
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), SOURCE);
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n- [header-exists] There is a header\n",
  );
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["header", "SubmitButton"] })),
    notes: [],
    tests: [
      { testId: "submit-exists", chunks: [{ path: "src/login.ts", symbol: "SubmitButton" }] },
      { testId: "header-exists", chunks: [{ path: "src/login.ts", symbol: "header" }] },
    ],
  });
  const states = new Map<string, string>();
  const model: ModelClient = {
    async decide(request) {
      if (request.purpose === "verdict") {
        const id = request.state.includes("[submit-exists]") ? "submit-exists" : "header-exists";
        states.set(id, request.state);
      }
      return { probabilities: [0.95, 0.05] };
    },
    async complete() {
      throw new Error("LLM should not be called");
    },
  };
  const outcome = await runCommand({ cwd, model, config: config(), interactive: true, env: {} });
  assert.equal(outcome.results.length, 2);
  const submit = states.get("submit-exists") ?? "";
  const header = states.get("header-exists") ?? "";
  assert.match(submit, /function SubmitButton/);
  assert.match(submit, /function header/);
  assert.equal(submit.split("function SubmitButton").length - 1, 1);
  assert.match(header, /function header/);
  assert.match(header, /function SubmitButton/);
  assert.deepEqual(outcome.results.find((result) => result.id === "submit-exists")?.evidence.map((item) => item.symbol), ["SubmitButton"]);
  assert.deepEqual(outcome.results.find((result) => result.id === "header-exists")?.evidence.map((item) => item.symbol), ["header"]);
});

test("caller disconnects, helper edits, and newly imported behavior change fresh decision verdicts without reindexing", async () => {
  const cwd = scaffold();
  const entry = 'import { helper } from "./helper.js";\nexport function SubmitButton() { return helper(); }\nexport function Login() { return SubmitButton(); }\n';
  fs.writeFileSync(path.join(cwd, "src/login.ts"), entry);
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() { return "submit"; }\n');
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: [] })),
    notes: [],
    tests: [{ testId: "submit-exists", chunks: [{ path: "src/login.ts", symbol: "SubmitButton" }] }],
  });
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"));
  const states: string[] = [];
  const model: ModelClient = {
    async decide(request) {
      if (request.purpose !== "verdict") return { probabilities: [0.95, 0.05] };
      states.push(request.state);
      const passes = request.state.includes("return SubmitButton()") && request.state.includes('return "submit"') && !request.state.includes("DISABLE_SUBMIT");
      return { probabilities: passes ? [0.99, 0.01] : [0.01, 0.99] };
    },
    async complete() { throw new Error("LLM should not be called"); },
  };
  const run = () => runCommand({ cwd, model, config: config(), env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal((await run()).results[0]?.verdict, "pass");
  fs.writeFileSync(path.join(cwd, "src/login.ts"), entry.replace("return SubmitButton()", 'return "disconnected"'));
  assert.equal((await run()).results[0]?.verdict, "fail");
  assert.match(states.at(-1) ?? "", /function Login\(\) \{ return "disconnected"/);
  fs.writeFileSync(path.join(cwd, "src/login.ts"), entry);
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() { return "removed"; }\n');
  assert.equal((await run()).results[0]?.verdict, "fail");
  assert.match(states.at(-1) ?? "", /return "removed"/);
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() { return "submit"; }\n');
  fs.writeFileSync(path.join(cwd, "src/policy.ts"), 'export const policy = "DISABLE_SUBMIT";\n');
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'import "./policy.js";\n' + entry);
  assert.equal((await run()).results[0]?.verdict, "fail");
  assert.match(states.at(-1) ?? "", /DISABLE_SUBMIT/);
  assert.equal(states.length, 4);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json")), indexBefore);
});

test("a decision API failure falls back to the escalation model and notes it", async () => {
  const cwd = scaffold();
  let report = "";
  let used = "";
  const outcome = await runCommand({
    cwd,
    model: {
      async decide() {
        throw new Error("max_tokens_exceeded");
      },
      async complete() {
        throw new Error("runner should not generate");
      },
    },
    indexModel: {
      async complete() {
        used = "index";
        return JSON.stringify({ verdict: "fail", evidence: [], explanation: "fallback judged the claim" });
      },
    },
    config: config(),
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  assert.equal(used, "index");
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.equal(outcome.results[0]?.fallback, "ollama/index");
  assert.match(report, /1 test fell back to ollama\/index after the decision API failed/);
});

function scriptedJev(pPasses: number[]): ModelClient & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async decideMany(requests) {
      const pPass = pPasses[state.calls];
      if (pPass === undefined) throw new Error(`unexpected decision call ${state.calls + 1}`);
      state.calls += 1;
      return requests.map((request) =>
        request.purpose === "verdict" ? { probabilities: [pPass, 1 - pPass] } : { probabilities: [0.2, 0.8] },
      );
    },
    async complete() {
      throw new Error("LLM should not be called");
    },
  };
}

test("three Jev fails stay fail and call the decision model three times when reruns is 2", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.05, 0.04, 0.03]);
  let escalations = 0;
  const escalate: ModelClient = {
    async complete() {
      escalations += 1;
      throw new Error("escalation model should not be called");
    },
  };
  let report = "";
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ reruns: 2 }),
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  assert.equal(runner.calls, 3);
  assert.equal(escalations, 0);
  assert.deepEqual(outcome.results[0]?.runs, ["fail", "fail", "fail"]);
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.equal(outcome.exitCode, 1);
  assert.match(report, /fail {2}\[submit-exists\]/);
  assert.match(report, /0 pass, 1 fail, 0 unsure/);
});

test("a Jev fail then pass escalates once and stops before the remaining rerun", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.05, 0.95, 0.05]);
  let escalations = 0;
  const escalate: ModelClient = {
    async complete() {
      escalations += 1;
      return JSON.stringify({
        verdict: "fail",
        evidence: [{ file: "src/login.ts", line: 1 }],
        explanation: "escalated once",
      });
    },
  };
  let report = "";
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ escalate: true, reruns: 2 }),
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  assert.equal(runner.calls, 2);
  assert.equal(escalations, 1);
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.deepEqual(outcome.results[0]?.runs, ["fail"]);
  assert.equal(outcome.results[0]?.explanation, "escalated once");
  assert.equal(outcome.exitCode, 1);
  assert.match(report, /fail {2}\[submit-exists\]/);
  assert.match(report, /0 pass, 1 fail, 0 unsure/);
});

test("a Jev fail then between-threshold retries through the configured attempts", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.05, 0.5, 0.05]);
  let escalations = 0;
  const escalate: ModelClient = {
    async complete() {
      escalations += 1;
      return JSON.stringify({
        verdict: "unsure",
        evidence: [],
        explanation: "mixed with unsure, escalated once",
      });
    },
  };
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ escalate: true, reruns: 2 }),
    interactive: true,
    env: {},
  });
  assert.equal(runner.calls, 3);
  assert.equal(escalations, 1);
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.deepEqual(outcome.results[0]?.runs, ["unsure"]);
  assert.equal(outcome.results[0]?.explanation, "mixed with unsure, escalated once");
});

test("a Jev pass does not rerun or escalate", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.95, 0.05, 0.05]);
  let escalations = 0;
  const escalate: ModelClient = {
    async complete() {
      escalations += 1;
      throw new Error("escalation model should not be called");
    },
  };
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ reruns: 2 }),
    interactive: true,
    env: {},
  });
  assert.equal(runner.calls, 1);
  assert.equal(escalations, 0);
  assert.deepEqual(outcome.results[0]?.runs, ["pass"]);
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.equal(outcome.exitCode, 0);
});

test("between-threshold verdict retries before escalating once", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.5, 0.05, 0.05]);
  let llmCalls = 0;
  const escalate: ModelClient = {
    async complete() {
      llmCalls += 1;
      return JSON.stringify({
        verdict: "fail",
        evidence: [{ file: "src/login.ts", line: 1 }],
        explanation: "between, judged once",
      });
    },
  };
  let report = "";
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ escalate: true, reruns: 2 }),
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  assert.equal(runner.calls, 3);
  assert.equal(llmCalls, 1);
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.deepEqual(outcome.results[0]?.runs, ["fail"]);
  assert.equal(outcome.exitCode, 1);
  assert.match(report, /fail {2}\[submit-exists\]/);
});

test("LLM escalation receives the full surface closure, not only indexed chunks", async () => {
  const cwd = scaffold(`import { helper } from "./helper.js";

export function header() {
  return 1;
}

export function SubmitButton() {
  return "submit";
}

export function OtherFeature() {
  return helper();
}
`);
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() { return "TOKEN_HELPER_CONTEXT"; }\n');
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["SubmitButton"] })),
    notes: [],
    tests: [{ testId: "submit-exists", chunks: [{ path: "src/login.ts", symbol: "SubmitButton" }] }],
  });
  const runner = decisionRunner(0.5, () => 0.5);
  let prompt = "";
  const escalate: ModelClient = {
    async complete(request) {
      prompt = request.prompt;
      return JSON.stringify({ verdict: "unsure", evidence: [], explanation: "unclear" });
    },
  };
  await runCommand({
    cwd,
    model: runner,
    indexModel: escalate,
    config: config({ escalate: true, reruns: 0 }),
    interactive: true,
    env: {},
  });
  assert.equal(runner.completes, 0);
  assert.match(prompt, /TOKEN_HELPER_CONTEXT/);
});

test("between-threshold verdicts use all configured attempts when escalation is disabled", async () => {
  const cwd = scaffold();
  const runner = scriptedJev([0.5, 0.55, 0.45]);
  const outcome = await runCommand({
    cwd,
    model: runner,
    config: config({ escalate: false, reruns: 2 }),
    interactive: true,
    env: {},
  });
  assert.equal(runner.calls, 3);
  assert.deepEqual(outcome.results[0]?.runs, ["unsure", "unsure", "unsure"]);
  assert.equal(outcome.results[0]?.verdict, "unsure");
});

test("fallback false lets a decision API failure through", async () => {
  const cwd = scaffold();
  await assert.rejects(
    () =>
      runCommand({
        cwd,
        model: {
          async decide() {
            throw new Error("max_tokens_exceeded");
          },
          async complete() {
            throw new Error("runner should not generate");
          },
        },
        config: config({ fallback: false }),
        interactive: true,
        env: {},
      }),
    /max_tokens_exceeded/,
  );
});

test("flow-step verdicts and escalations use fresh step closures and accept live citations", async () => {
  const cwd = scaffold();
  fs.writeFileSync(path.join(cwd, "src/step.ts"), 'export function Checkout() { return "checkout"; }\n');
  const surfaceClosure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  const stepClosure = computeSurfaceClosure({ cwd, entry: "src/step.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: surfaceClosure.files,
    closureHash: surfaceClosure.closureHash,
    entry: ["src/login.ts"],
    files: surfaceClosure.files.map((file) => ({ ...file, symbols: [] })),
    notes: [],
    flows: [{
      testId: "submit-exists",
      closure: stepClosure.files,
      steps: [{ id: "checkout", text: "Checkout is reachable", entry: "src/step.ts", chunks: [{ path: "src/step.ts", symbol: "Checkout" }] }],
    }],
  });
  fs.writeFileSync(path.join(cwd, "src/step.ts"), 'import { helper } from "./added.js";\nexport function Checkout() { return helper(); }\n');
  fs.writeFileSync(path.join(cwd, "src/added.ts"), 'export function helper() { return "LIVE_STEP_HELPER"; }\n');
  const runner = decisionRunner(0.5, () => 0.5);
  let prompt = "";
  const outcome = await runCommand({
    cwd, model: runner, config: config(), env: {}, stdout: () => {}, stderr: () => {},
    indexModel: {
      async complete(request) {
        prompt = request.prompt;
        return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/added.ts", line: 1 }] });
      },
    },
  });
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.match(runner.decides.find((request) => request.purpose === "verdict")?.state ?? "", /LIVE_STEP_HELPER/);
  assert.match(prompt, /LIVE_STEP_HELPER/);
  assert.doesNotMatch(prompt, /function SubmitButton/);

  const indexFile = path.join(cwd, "tyxtest/login/.index.json");
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  index.flows[0].steps[0].text = "Checkout is reachable after confirmation";
  writeIndex(indexFile, index);
  const revisedRunner = decisionRunner(0.95, () => 0.95);
  const revised = await runCommand({ cwd, model: revisedRunner, config: config(), env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(revised.results[0]?.cached, false);
  assert.match(revisedRunner.decides[0]?.state ?? "", /after confirmation/);

  const outsideStep = await runCommand({
    cwd, model: decisionRunner(0.5, () => 0.5), config: config(), all: true, env: {}, stdout: () => {}, stderr: () => {},
    indexModel: { async complete() { return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/login.ts", line: 1 }] }); } },
  });
  assert.equal(outsideStep.results[0]?.verdict, "unsure");
});

test("triage reuses only the same claim, surface context, evidence mapping, and judgment policy", async () => {
  const cwd = scaffold();
  let triages = 0;
  let verdicts = 0;
  const model: ModelClient = {
    async decide(request) {
      if (request.purpose === "triage") {
        triages += 1;
        return { probabilities: [0.01, 0.99] };
      }
      if (request.purpose === "verdict") verdicts += 1;
      return { probabilities: [0.95, 0.05] };
    },
    async complete() { throw new Error("LLM should not be called"); },
  };
  const base = config({ triage: true, escalate: false, relocateCheck: false });
  const run = (settings = base) => runCommand({ cwd, model, config: settings, env: {}, stdout: () => {} });
  assert.equal((await run()).results[0]?.verdict, "pass");
  fs.appendFileSync(path.join(cwd, "src/login.ts"), "export const edited = true;\n");
  assert.equal((await run()).results[0]?.cached, true);
  assert.equal(triages, 1);
  assert.equal(verdicts, 1);

  const strict = await run({ ...base, thresholds: { pass: 0.99, fail: 0.1 } });
  assert.equal(strict.results[0]?.verdict, "unsure");
  assert.equal(strict.results[0]?.cached, false);
  assert.equal(triages, 1);
  assert.equal(verdicts, 2);

  const surfaceFile = path.join(cwd, "tyxtest/login/surface.md");
  fs.writeFileSync(surfaceFile, fs.readFileSync(surfaceFile, "utf8").replace("surface: Login form", "surface: Login form\ndescription: Authenticated form only"));
  assert.equal((await run()).results[0]?.cached, false);
  assert.equal(triages, 1);
  assert.equal(verdicts, 3);
  fs.writeFileSync(surfaceFile, fs.readFileSync(surfaceFile, "utf8").replace("There is a submit button", "There is a disabled submit button"));
  assert.equal((await run()).results[0]?.cached, false);
  assert.equal(triages, 1);
  assert.equal(verdicts, 4);

  const indexFile = path.join(cwd, "tyxtest/login/.index.json");
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  index.tests[0].chunks = [{ path: "src/login.ts", symbol: "SubmitButton" }];
  writeIndex(indexFile, index);
  assert.equal((await run()).results[0]?.cached, false);
  assert.equal(triages, 1);
  assert.equal(verdicts, 5);
});

test("same test IDs on different surfaces do not share verdicts or triage", async () => {
  const cwd = scaffold();
  fs.mkdirSync(path.join(cwd, "tyxtest/other"));
  fs.copyFileSync(path.join(cwd, "tyxtest/login/.index.json"), path.join(cwd, "tyxtest/other/.index.json"));
  fs.writeFileSync(path.join(cwd, "tyxtest/other/surface.md"), fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8").replace("Login form", "Other form"));
  let verdicts = 0;
  const model: ModelClient = {
    async decide(request) {
      assert.notEqual(request.purpose, "triage");
      if (request.purpose === "verdict") {
        verdicts += 1;
        return { probabilities: request.state.includes("Surface: Other form") ? [0.01, 0.99] : [0.99, 0.01] };
      }
      return { probabilities: [0.9, 0.1] };
    },
    async complete() { throw new Error("LLM should not be called"); },
  };
  const settings = config({ triage: true, concurrency: 1 });
  const first = await runCommand({ cwd, model, config: settings, env: {}, stdout: () => {} });
  assert.deepEqual(first.results.map((result) => result.verdict), ["pass", "fail"]);
  const second = await runCommand({ cwd, model, config: settings, env: {}, stdout: () => {} });
  assert.ok(second.results.every((result) => result.cached));
  assert.equal(verdicts, 2);
});

test("a missing indexed evidence mapping stays unsure despite available closure code", async () => {
  const cwd = scaffold();
  const indexFile = path.join(cwd, "tyxtest/login/.index.json");
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  index.tests = [];
  writeIndex(indexFile, index);
  const runner = decisionRunner(0.99, () => 0.99);
  const outcome = await runCommand({ cwd, model: runner, config: config(), env: {}, stdout: () => {} });
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.match(outcome.results[0]?.explanation ?? "", /no chunks indexed/);
  assert.equal(runner.decides.length, 0);
});
