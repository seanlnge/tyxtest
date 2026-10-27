import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectClosure } from "../src/closure/closure.js";
import { readIndex, writeIndex } from "../src/surface/index-file.js";
import { readPending } from "../src/surface/pending.js";
import { parseConfig } from "../src/config/config.js";
import { runCommand } from "../src/commands/run.js";
import type { DecisionRequest, ModelClient, ModelRequest, TyxtestConfig } from "../src/config/types.js";
import { tempDir } from "./helpers.js";

const computeSurfaceClosure = ({ cwd, entry }: { cwd: string; entry: string }) => collectClosure({ cwd, entries: [entry], depth: null });

function config(overrides: Record<string, unknown> = {}): TyxtestConfig {
  return parseConfig({
    markdown: { tests: "bullets" },
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

test("import graph drift reads fresh mapped code without adding the imported file", async () => {
  const cwd = tempDir("tyxtest-drift-");
  writeSurface(cwd, "src/login.ts", "export function Login() {\n  return \"login\";\n}\n", ["Login"]);
  fs.writeFileSync(
    path.join(cwd, "src/login.ts"),
    'import { helper } from "./helper";\nexport function Login() {\n  return helper();\n}\n',
  );
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), 'export function helper() {\n  return "TOKEN_MOVED_HELPER";\n}\n');
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"));
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
  assert.equal(warnAt, -1);
  assert.ok(events.includes("saw-fresh-login"));
  assert.equal(events.includes("saw-helper-file"), false);
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.equal(runner.completes, 0);
  assert.ok(runner.decides.some((request) => request.purpose === "verdict"));
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/.index.json")), indexBefore);
});

test("renamed mapped source is resolved without rewriting authored tests or the index", async () => {
  const cwd = tempDir("tyxtest-rename-");
  writeSurface(cwd, "src/login.ts", 'export function Login() {\n  return "TOKEN_RENAMED";\n}\n', ["Login"]);
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Tyxtest", "-c", "user.email=tyxtest@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
    cwd,
    stdio: "ignore",
  });
  execFileSync("git", ["mv", "src/login.ts", "src/auth.ts"], { cwd, stdio: "ignore" });
  const originalMarkdown = fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8");
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
  assert.ok(events.some((event) => event.includes("index stale: source context")));
  assert.equal(events.includes("decide"), true);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8"), originalMarkdown);
  assert.equal(outcome.results[0]?.verdict, "pass");
  const index = readIndex(path.join(cwd, "tyxtest/login/.index.json"));
  assert.equal(index.tests?.[0]?.chunks[0]?.path, "src/login.ts");
});

test("deleted mapped source stays unsure without a model call", async () => {
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
  const result = await runCommand({ cwd, model, config: config(), interactive: true, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(result.results[0]?.verdict, "unsure");
  assert.equal(calls, 0);
});

test("missing symbols stay stale without judging or searching unrelated replacement code", async () => {
  const cwd = tempDir("tyxtest-relocate-");
  writeSurface(
    cwd,
    "src/login.ts",
    "export function SubmitButton() {\n  return \"submit\";\n}\n",
    ["SubmitButton"],
  );
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function header() {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(cwd, "src/billing.ts"), "export function SubmitButton() {\n  return \"submit\";\n}\n");
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"));
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
  assert.equal(indexCalls.length, 0);
  assert.equal(runner.decides.length, 0);
  assert.equal(readPending(cwd).length, 0);
  assert.match(found.results[0]?.explanation ?? "", /source mapping.*unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/.index.json")), indexBefore);

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
  assert.equal(missed.results[0]?.verdict, "unsure");
  assert.equal(missed.exitCode, 0);
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
  assert.equal(runner.decides.length, 0);
  assert.match(outcome.results[0]?.explanation ?? "", /source mapping.*unavailable/);
  assert.deepEqual(outcome.results[0]?.evidence, []);
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.equal(outcome.exitCode, 0);
});

test("test-owned evidence remains context even after a caller stops importing it", async () => {
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
  assert.ok(runner.decides.some((request) => request.purpose === "verdict" && request.state.includes("OUTSIDE_LIVE_CLOSURE")));
  assert.deepEqual(outcome.results[0]?.evidence.map((item) => item.file).sort(), ["src/helper.ts", "src/login.ts"]);
});

test("renamed implementation is read fresh but does not borrow unmapped evidence", async () => {
  const cwd = tempDir("tyxtest-live-evidence-move-");
  writeSurface(cwd, "src/login.ts", 'export function SubmitButton() { return "submit"; }\n', ["SubmitButton"]);
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"));
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
  assert.equal(outcome.results[0]?.verdict, "unsure");
  assert.equal(verdictState, "");
  assert.deepEqual(outcome.results[0]?.evidence, []);
  assert.match(outcome.results[0]?.explanation ?? "", /source mapping.*unavailable/);
  assert.equal(indexCalls, 0);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/.index.json")), indexBefore);
});
