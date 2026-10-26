import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeSurfaceClosure } from "../src/closure.js";
import { writeIndex } from "../src/index-file.js";
import { runCommand } from "../src/run.js";
import type { ModelClient, ModelRequest } from "../src/types.js";
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
      indexModel: { provider: "ollama", model: "index" },
      runnerModel: { provider: "ollama", model: "runner" },
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
  const closure = computeSurfaceClosure({ cwd, entry: "src/login.ts", depth: null, parentClosure: null });
  writeIndex(path.join(cwd, "tyxtest/login/.index.json"), {
    closure: closure.files,
    closureHash: closure.closureHash,
    entry: ["src/login.ts"],
    files: closure.files.map((file) => ({ ...file, symbols: ["LoginForm"] })),
    notes: [],
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
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"));
  const model = scriptedModel([pass]);
  const first = await runCommand({ cwd, model, interactive: true, env: {} });
  assert.equal(first.exitCode, 0);
  assert.equal(first.results[0]?.verdict, "pass");
  assert.equal(first.results[0]?.cached, false);
  assert.equal(model.requests.length, 1);
  assert.match(model.requests[0]?.prompt ?? "", /TOKEN_LOGIN_SOURCE/);
  assert.equal((model.requests[0]?.prompt ?? "").includes("TOKEN_OTHER_SOURCE"), false);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json")), indexBefore);

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

test("run aggregates all-fail and mixed verdicts", async () => {
  const failing = project();
  writeFreshIndex(failing);
  const failModel = scriptedModel([fail, fail, fail]);
  const failed = await runCommand({ cwd: failing, model: failModel, interactive: true, env: {} });
  assert.equal(failModel.requests.length, 3);
  assert.equal(failed.results[0]?.verdict, "fail");
  assert.equal(failed.exitCode, 1);

  const mixed = project();
  writeFreshIndex(mixed);
  const mixedModel = scriptedModel([fail, pass, fail]);
  const result = await runCommand({ cwd: mixed, model: mixedModel, interactive: true, env: {} });
  assert.equal(mixedModel.requests.length, 3);
  assert.equal(result.results[0]?.verdict, "unsure");
  assert.equal(result.exitCode, 0);
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
