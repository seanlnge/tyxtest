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
    files: closure.files.map((file) => ({ ...file, symbols: ["SubmitButton"] })),
    notes: [],
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
  assert.deepEqual(
    runner.decides.map((request) => request.purpose),
    ["verdict"],
  );
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
