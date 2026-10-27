import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectClosure } from "../src/closure/closure.js";
import { claimHashFor, writeIndex } from "../src/surface/index-file.js";
import { readTests } from "../src/surface/surface.js";
import { runCommand } from "../src/commands/run.js";
import type { ModelClient, ModelRequest } from "../src/config/types.js";
import { tempDir } from "./helpers.js";

function project(extraConfig: Record<string, unknown> = {}): string {
  const cwd = tempDir("tyxtest-run-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "login"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'export function LoginForm() {\n  return "TOKEN_LOGIN_SOURCE";\n}\n');
  fs.writeFileSync(path.join(cwd, "src/other.ts"), 'export const other = "TOKEN_OTHER_SOURCE";\n');
  fs.writeFileSync(
    path.join(cwd, "tyxtest/tyxtest.config.json"),
    JSON.stringify({
      markdown: { tests: "bullets" },
      indexModel: { provider: "ollama", model: "index" },
      runnerModel: { kind: "llm", provider: "ollama", model: "runner" },
      ignoreUnchanged: false,
      reruns: 2,
      ...extraConfig,
    }),
  );
  fs.writeFileSync(
    path.join(cwd, "tyxtest/login/surface.md"),
    "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n",
  );
  return cwd;
}

function writeFreshIndex(cwd: string): void {
  const closure = collectClosure({ cwd, entries: ["src/login.ts"], depth: null });
  const testCase = readTests(fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8"), { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } })[0]!;
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["LoginForm"] })),
    notes: [],
    tests: [{ testId: testCase.id, claimHash: claimHashFor(testCase.text, testCase.notes), chunks: [{ path: "src/login.ts", symbol: "LoginForm" }] }],
  });
}

function scriptedModel(responses: string[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(request: ModelRequest): Promise<string> {
      requests.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error(`Unexpected model call: ${request.purpose}`);
      return next;
    },
  };
}

const pass = JSON.stringify({
  verdict: "pass",
  evidence: [{ file: "src/login.ts", line: 1 }],
  explanation: "The form source is in the closure.",
});
const fail = JSON.stringify({ verdict: "fail", evidence: [], explanation: "No submit control." });

test("run passes with valid evidence, caches it, and does not write the index", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"));
  const model = scriptedModel([pass]);
  const first = await runCommand({ cwd, model, interactive: true, env: {} });
  assert.equal(first.exitCode, 0);
  assert.equal(first.results[0]?.verdict, "pass");
  assert.equal(first.results[0]?.cached, false);
  assert.equal(model.requests.length, 1);
  assert.match(model.requests[0]?.prompt ?? "", /TOKEN_LOGIN_SOURCE/);
  assert.equal((model.requests[0]?.prompt ?? "").includes("TOKEN_OTHER_SOURCE"), false);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/.index.json")), indexBefore);

  const second = await runCommand({
    cwd,
    interactive: true,
    env: {},
    model: {
      async complete(): Promise<string> {
        throw new Error("model should not be called");
      },
    },
  });
  assert.equal(second.results[0]?.verdict, "pass");
  assert.equal(second.results[0]?.cached, true);
  assert.equal(fs.existsSync(path.join(cwd, ".tyxtest/results.json")), true);
  assert.equal(fs.existsSync(path.join(cwd, ".tyxtest/junit.xml")), true);
});

test("default runs reuse cache without requiring a valid git base ref", async () => {
  const cwd = project({ ignoreUnchanged: undefined, baseRef: "missing-base-ref" });
  writeFreshIndex(cwd);
  let calls = 0;
  const model: ModelClient = {
    async complete() {
      calls += 1;
      return pass;
    },
  };
  await runCommand({ cwd, model, interactive: true, env: {} });
  const second = await runCommand({
    cwd,
    model: { async complete() { throw new Error("cache should avoid model calls"); } },
    interactive: true,
    env: {},
  });
  assert.equal(calls, 1);
  assert.equal(second.results[0]?.cached, true);
  assert.equal(second.results[0]?.verdict, "pass");
});

test("run -A rejudges a cached test and ignores unchanged skips", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  await runCommand({ cwd, model: scriptedModel([pass]), interactive: true, env: {} });
  let calls = 0;
  const again = await runCommand({
    cwd,
    all: true,
    interactive: true,
    env: {},
    model: {
      async complete() {
        calls += 1;
        return pass;
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(again.results[0]?.cached, false);
  assert.equal(again.results[0]?.verdict, "pass");

  const unchanged = project({ ignoreUnchanged: true });
  writeFreshIndex(unchanged);
  const judged = await runCommand({
    cwd: unchanged,
    all: true,
    model: scriptedModel([pass]),
    interactive: true,
    env: {},
  });
  assert.equal(judged.results[0]?.verdict, "pass");
  assert.equal(judged.results[0]?.verdict === "skipped", false);
});

test("an LLM runner judges once even when reruns is 2", async () => {
  const failing = project();
  fs.writeFileSync(
    path.join(failing, "src/login.ts"),
    'import { helper } from "./other.js";\nexport function LoginForm() { return "TOKEN_LOGIN_SOURCE"; }\nexport function OtherFeature() { return helper(); }\n',
  );
  fs.writeFileSync(path.join(failing, "src/other.ts"), 'export function helper() { return "TOKEN_HELPER_CONTEXT"; }\n');
  writeFreshIndex(failing);
  const failModel = scriptedModel([fail]);
  let report = "";
  const failed = await runCommand({
    cwd: failing,
    model: failModel,
    interactive: true,
    env: {},
    stdout: (message) => {
      report += message;
    },
  });
  assert.equal(failModel.requests.length, 1);
  assert.doesNotMatch(failModel.requests[0]?.prompt ?? "", /TOKEN_HELPER_CONTEXT|function OtherFeature/);
  assert.equal(failed.results[0]?.verdict, "fail");
  assert.deepEqual(failed.results[0]?.runs, ["fail"]);
  assert.equal(failed.exitCode, 1);
  assert.match(report, /- fail There is a submit button/);
  assert.match(report.replace(/\x1b\[[0-9;]*m/g, ""), /0 pass, 1 fail, 0 unsure/);
});

test("LLM passes can cite fresh mapped source but not newly imported unmapped files", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"));
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'export function LoginForm() { return "EDITED_LOGIN"; }\n');
  const edited = await runCommand({ cwd, model: scriptedModel([pass]), env: {}, stdout: () => {} });
  assert.equal(edited.results[0]?.verdict, "pass");
  fs.writeFileSync(path.join(cwd, "src/login.ts"), 'import { submit } from "./new.js";\nexport function LoginForm() { return submit(); }\n');
  fs.writeFileSync(path.join(cwd, "src/new.ts"), 'export function submit() { return "NEW_IMPORT"; }\n');
  const model = scriptedModel([JSON.stringify({ verdict: "pass", evidence: [{ file: "src/new.ts", line: 1 }] })]);
  const added = await runCommand({ cwd, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(added.results[0]?.verdict, "unsure");
  assert.doesNotMatch(model.requests[0]?.prompt ?? "", /NEW_IMPORT/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/.index.json")), indexBefore);
});

test("LLM citation checks reject nonexistent, out-of-closure, and invalid line citations", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  for (const citation of [
    { file: "src/missing.ts", line: 1 },
    { file: "src/other.ts", line: 1 },
    { file: "src/login.ts", line: 0 },
    { file: "src/login.ts", line: 1.5 },
    { file: "src/login.ts", line: 99 },
  ]) {
    const model = scriptedModel([JSON.stringify({ verdict: "pass", evidence: [citation] })]);
    const outcome = await runCommand({ cwd, model, all: true, env: {}, stdout: () => {} });
    assert.equal(outcome.results[0]?.verdict, "unsure", JSON.stringify(citation));
  }
});

test("LLM citations are checked against the provided snapshot, not a later disk read", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  const outcome = await runCommand({
    cwd,
    env: {},
    stdout: () => {},
    model: {
      async complete(request) {
        assert.match(request.prompt, /TOKEN_LOGIN_SOURCE/);
        fs.writeFileSync(path.join(cwd, "src/login.ts"), "");
        return pass;
      },
    },
  });
  assert.equal(outcome.results[0]?.verdict, "pass");
});

test("unindexed surfaces fail closed and search mode forces unsure without writing an index", async () => {
  const closed = project();
  await assert.rejects(
    () => runCommand({ cwd: closed, interactive: false, env: {}, model: scriptedModel([]) }),
    /Run `tyxtest index` locally/,
  );

  const cwd = project({ nonInteractive: "search", reruns: 0 });
  const model = scriptedModel([JSON.stringify({ files: ["src/login.ts"] }), pass]);
  const searched = await runCommand({ cwd, model, interactive: false, env: {} });
  assert.equal(searched.results[0]?.verdict, "unsure");
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/login/.index.json")), false);
  assert.equal(model.requests.map((request) => request.purpose).join(","), "search,run");
});

test("run delivers notes to the model and rejects cached judgments after a claim changes", async () => {
  const cwd = project();
  const surfaceFile = path.join(cwd, "tyxtest/login/surface.md");
  fs.writeFileSync(surfaceFile, "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n  It must use the accessible label.\n");
  writeFreshIndex(cwd);
  const model = scriptedModel([pass]);
  const judged = await runCommand({ cwd, model, all: true, env: {}, stdout: () => {} });
  assert.equal(judged.results[0]?.verdict, "pass");
  assert.match(model.requests[0]?.prompt ?? "", /Specification:\nIt must use the accessible label\./);

  fs.writeFileSync(surfaceFile, "---\nsurface: Login form\nentry: src/login.ts\n---\n- [submit-exists] There is a submit button\n  It must have keyboard support.\n");
  const warnings: string[] = [];
  const changed = await runCommand({
    cwd,
    env: {},
    stdout: () => {},
    stderr: (message) => warnings.push(message),
    model: { async complete() { throw new Error("changed test must not reuse the old mapping or cache"); } },
  });
  assert.equal(changed.results[0]?.verdict, "unsure");
  assert.equal(changed.results[0]?.cached, false);
  assert.match(warnings.join("\n"), /index stale: test/);
});

test("run token footer reports per-run deltas for reused model clients", async () => {
  const cwd = project();
  writeFreshIndex(cwd);
  let inputTokens = 0;
  let outputTokens = 0;
  const model: ModelClient = {
    async complete() {
      inputTokens += 20;
      outputTokens += 3;
      return pass;
    },
    usage() { return { inputTokens, outputTokens, available: true }; },
  };
  let firstReport = "";
  await runCommand({ cwd, model, all: true, env: {}, stdout: (message) => { firstReport += message; } });
  assert.match(firstReport, /runner tokens: 20 input, 3 output/);
  let cachedReport = "";
  await runCommand({ cwd, model, env: {}, stdout: (message) => { cachedReport += message; } });
  assert.match(cachedReport, /runner tokens: 0 input, 0 output/);
});

test("run token footer separates decision-runner and fallback-model usage", async () => {
  const cwd = project({ runnerModel: { kind: "decision", provider: "typesafe", model: "jev" }, fallback: true, reruns: 0 });
  writeFreshIndex(cwd);
  const runner: ModelClient = {
    async complete() { throw new Error("decision model does not generate"); },
    async decide() { throw new Error("decision API unavailable"); },
    usage() { return { inputTokens: 0, outputTokens: 0, available: true }; },
  };
  let inputTokens = 7;
  let outputTokens = 2;
  const fallback: ModelClient = {
    async complete() { inputTokens += 7; outputTokens += 2; return pass; },
    usage() { return { inputTokens, outputTokens, available: true }; },
  };
  let report = "";
  const outcome = await runCommand({ cwd, model: runner, escalateModel: fallback, all: true, env: {}, stdout: (message) => { report += message; } });
  assert.equal(outcome.results[0]?.verdict, "pass");
  assert.match(report, /runner tokens: 0 input, 0 output/);
  assert.match(report, /fallback-model tokens: 7 input, 2 output/);
});
