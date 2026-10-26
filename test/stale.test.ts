import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeSurfaceClosure } from "../src/closure/closure.js";
import { writeIndex } from "../src/surface/index-file.js";
import { readPending } from "../src/surface/pending.js";
import { parseConfig } from "../src/config/config.js";
import { runCommand } from "../src/commands/run.js";
import type { DecisionRequest, ModelClient, ModelRequest, TyxtestConfig } from "../src/config/types.js";
import { tempDir } from "./helpers.js";

function config(overrides: Record<string, unknown> = {}): TyxtestConfig {
  return parseConfig({
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    ignoreUnchanged: false,
    reruns: 0,
    ...overrides,
  });
}

function writeSurface(cwd: string, entry: string, source: string, symbols: string[]): void {
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.writeFileSync(path.join(cwd, entry), source);
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    `---\nsurface: Login form\nentry: ${entry}\n---\n- [submit-exists] There is a submit button\n`,
  );
  const closure = computeSurfaceClosure({ cwd, entry, depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: [entry],
    files: closure.files.map((file) => ({ ...file, symbols })),
    notes: [],
    tests: [{ testId: "submit-exists", chunks: symbols.map((symbol) => ({ path: entry, symbol })) }],
  });
}

function decisionRunner(pPass: number): ModelClient & { decides: DecisionRequest[]; completes: number } {
  const decides: DecisionRequest[] = [];
  return {
    decides,
    completes: 0,
    async decide(request) {
      decides.push(request);
      if (request.purpose === "verdict") return { probabilities: [pPass, 1 - pPass] };
      return { probabilities: [0.2, 0.8] };
    },
    async complete() {
      this.completes += 1;
      throw new Error("runner LLM should not be called");
    },
  };
}

test("import graph drift uses the fresh closure and warns index stale before the model", async () => {
  const cwd = tempDir("tyxtest-drift-");
  writeSurface(cwd, "src/login.ts", "export function Login() {\n  return \"login\";\n}\n", ["Login"]);
  fs.writeFileSync(
    path.join(cwd, "src/login.ts"),
    'import { helper } from "./helper";\nexport function Login() {\n  return helper();\n}\n',
  );
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() {\n  return "TOKEN_MOVED_HELPER";\n}\n');
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"));
  const events: string[] = [];
  const runner = decisionRunner(0.95);
  const wrapped: ModelClient = {
    async decide(request) {
      events.push(`decide:${request.purpose}`);
      if (request.purpose === "verdict" && request.state.includes("return helper()")) events.push("saw-fresh-login");
      if (request.purpose === "verdict" && request.state.includes("TOKEN_MOVED_HELPER")) events.push("saw-helper-file");
      return runner.decide!(request);
    },
    async complete(request) {
      events.push(`complete:${request.purpose}`);
      return runner.complete(request);
    },
  };
  const outcome = await runCommand({
    cwd,
    model: wrapped,
    config: config(),
    interactive: true,
    env: {},
    stderr: (message) => {
      events.push(`stderr:${message}`);
    },
  });
  const warnAt = events.findIndex((event) => event.includes("index stale"));
  const decideAt = events.findIndex((event) => event.startsWith("decide:"));
  assert.ok(warnAt >= 0);
  assert.ok(decideAt > warnAt);
  assert.ok(events.includes("saw-fresh-login"));
  assert.equal(events.includes("saw-helper-file"), true);
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.equal(runner.completes, 0);
  assert.ok(runner.decides.some((request) => request.purpose === "verdict"));
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json")), indexBefore);
});

test("entry rename from git diff -M updates entry and warns", async () => {
  const cwd = tempDir("tyxtest-rename-");
  writeSurface(cwd, "src/login.ts", 'export function Login() {\n  return "TOKEN_RENAMED";\n}\n', ["Login"]);
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Tyxtest", "-c", "user.email=tyxtest@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
    cwd,
    stdio: "ignore",
  });
  execFileSync("git", ["mv", "src/login.ts", "src/auth.ts"], { cwd, stdio: "ignore" });
  const events: string[] = [];
  const runner = decisionRunner(0.95);
  const outcome = await runCommand({
    cwd,
    model: {
      async decide(request) {
        events.push("decide");
        if (request.purpose === "verdict") assert.match(request.state, /TOKEN_RENAMED/);
        return runner.decide!(request);
      },
      async complete() {
        throw new Error("LLM should not be called");
      },
    },
    config: config({ baseRef: "HEAD" }),
    interactive: true,
    env: {},
    stderr: (message) => {
      events.push(`stderr:${message}`);
    },
  });
  const warnAt = events.findIndex((event) => event.includes("renamed from src/login.ts to src/auth.ts"));
  assert.ok(warnAt >= 0);
  assert.ok(events.indexOf("decide") > warnAt);
  assert.match(events[warnAt] ?? "", /Updated entry:/);
  assert.match(fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8"), /entry: src\/auth\.ts/);
  assert.equal(outcome.results[0]?.verdict, "pass");
  const index = JSON.parse(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"), "utf8")) as { entry: string[] };
  assert.deepEqual(index.entry, ["src/login.ts"]);
});

test("deleted entry errors and tells the user to re-index", async () => {
  const cwd = tempDir("tyxtest-deleted-");
  writeSurface(cwd, "src/login.ts", "export function Login() {\n  return 1;\n}\n", ["Login"]);
  fs.rmSync(path.join(cwd, "src/login.ts"));
  let calls = 0;
  const model: ModelClient = {
    async decide() {
      calls += 1;
      throw new Error("model should not be called");
    },
    async complete() {
      calls += 1;
      throw new Error("model should not be called");
    },
  };
  await assert.rejects(
    () => runCommand({ cwd, model, config: config(), interactive: true, env: {} }),
    /re-index/,
  );
  assert.equal(calls, 0);
});

test("relocate check proposes an index update when a failed test's evidence moved", async () => {
  const cwd = tempDir("tyxtest-relocate-");
  writeSurface(
    cwd,
    "src/login.ts",
    "export function SubmitButton() {\n  return \"submit\";\n}\n",
    ["SubmitButton"],
  );
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function header() {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(cwd, "src/billing.ts"), "export function SubmitButton() {\n  return \"submit\";\n}\n");
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"));
  const runner = decisionRunner(0.05);
  const indexCalls: ModelRequest[] = [];
  const indexModel: ModelClient = {
    async complete(request) {
      indexCalls.push(request);
      return JSON.stringify({ found: true, path: "src/billing.ts" });
    },
  };
  const found = await runCommand({
    cwd,
    model: runner,
    indexModel,
    config: config(),
    interactive: true,
    env: {},
  });
  assert.equal(found.results[0]?.verdict, "unsure");
  assert.equal(found.exitCode, 0);
  assert.equal(runner.completes, 0);
  assert.equal(indexCalls.length, 1);
  assert.equal(indexCalls[0]?.purpose, "relocate");
  assert.match(readPending(cwd).map((item) => item.detail ?? "").join("\n"), /src\/billing\.ts/);
  assert.match(found.results[0]?.explanation ?? "", /Proposed index update/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json")), indexBefore);

  const missing = tempDir("tyxtest-relocate-miss-");
  writeSurface(missing, "src/login.ts", "export function SubmitButton() {\n  return \"submit\";\n}\n", ["SubmitButton"]);
  fs.writeFileSync(path.join(missing, "src/login.ts"), "export function header() {\n  return 1;\n}\n");
  const missed = await runCommand({
    cwd: missing,
    model: decisionRunner(0.05),
    indexModel: {
      async complete() {
        return JSON.stringify({ found: false });
      },
    },
    config: config(),
    interactive: true,
    env: {},
  });
  assert.equal(missed.results[0]?.verdict, "fail");
  assert.equal(missed.exitCode, 1);
  assert.equal(readPending(missing).length, 0);
});

test("relocateCheck false does not call the index model", async () => {
  const cwd = tempDir("tyxtest-relocate-off-");
  writeSurface(cwd, "src/login.ts", "export function SubmitButton() {\n  return \"submit\";\n}\n", ["SubmitButton"]);
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function header() {\n  return 1;\n}\n");
  let indexCalls = 0;
  const runner = decisionRunner(0.05);
  const outcome = await runCommand({
    cwd,
    model: runner,
    indexModel: {
      async complete() {
        indexCalls += 1;
        throw new Error("index model should not be called");
      },
    },
    config: config({ relocateCheck: false }),
    interactive: true,
    env: {},
  });
  assert.equal(indexCalls, 0);
  assert.ok(runner.decides.some((request) => request.purpose === "verdict"));
  assert.ok(runner.decides.every((request) => !request.state.includes("function SubmitButton")));
  assert.match(outcome.results[0]?.explanation ?? "", /p\(pass\)=0.05/);
  assert.deepEqual(outcome.results[0]?.evidence.map((item) => item.symbol), ["header"]);
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.equal(outcome.exitCode, 1);
});

test("indexed evidence outside the live import closure is never sent as judgment context", async () => {
  const cwd = tempDir("tyxtest-disconnected-import-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function SubmitButton() { return "OUTSIDE_LIVE_CLOSURE"; }\n');
  writeSurface(cwd, "src/login.ts", 'import { SubmitButton } from "./helper.js";\nexport function Login() { return SubmitButton(); }\n', ["Login"]);
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files, closureHash: closure.closureHash, entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: [] })), notes: [],
    tests: [{ testId: "submit-exists", chunks: [{ path: "src/login.ts", symbol: "Login" }, { path: "src/helper.ts", symbol: "SubmitButton" }] }],
  });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'export function Login() { return "disconnected"; }\n');
  const runner = decisionRunner(0.05);
  const outcome = await runCommand({ cwd, model: runner, config: config({ relocateCheck: false }), env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(outcome.results[0]?.verdict, "fail");
  assert.ok(runner.decides.length > 0);
  assert.ok(runner.decides.every((request) => !request.state.includes("OUTSIDE_LIVE_CLOSURE")));
  assert.deepEqual(outcome.results[0]?.evidence.map((item) => item.file), ["src/login.ts"]);
});

test("renamed implementation in a newly imported module is judged with fresh fallback evidence", async () => {
  const cwd = tempDir("tyxtest-live-evidence-move-");
  writeSurface(cwd, "src/login.ts", 'export function SubmitButton() { return "submit"; }\n', ["SubmitButton"]);
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"));
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'import { CheckoutButton } from "./checkout.js";\nexport function Login() { return CheckoutButton(); }\n');
  fs.writeFileSync(path.join(cwd, "src/checkout.ts"), 'export function CheckoutButton() { return "LIVE_RENAMED_SUBMIT"; }\n');
  let verdictState = "";
  let indexCalls = 0;
  const outcome = await runCommand({
    cwd, config: config(), env: {}, stdout: () => {}, stderr: () => {},
    model: {
      async decide(request) {
        assert.doesNotMatch(request.state, /function SubmitButton/);
        if (request.purpose === "verdict") {
          verdictState = request.state;
          const passes = request.state.includes("LIVE_RENAMED_SUBMIT") && request.state.includes("return CheckoutButton()");
          return { probabilities: passes ? [0.99, 0.01] : [0.01, 0.99] };
        }
        return { probabilities: request.state.includes("LIVE_RENAMED_SUBMIT") ? [0.99, 0.01] : [0.01, 0.99] };
      },
      async complete() { throw new Error("runner should not call an LLM"); },
    },
    indexModel: { async complete() { indexCalls += 1; throw new Error("a live pass must not relocate"); } },
  });
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.match(verdictState, /LIVE_RENAMED_SUBMIT/);
  assert.deepEqual(outcome.results[0]?.evidence.map((item) => [item.file, item.symbol]), [["src/checkout.ts", "CheckoutButton"]]);
  assert.equal(indexCalls, 0);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json")), indexBefore);
});
