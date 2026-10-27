import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { indexCommand } from "../src/commands/index-command.js";
import { runCommand } from "../src/commands/run.js";
import { parseConfig } from "../src/config/config.js";
import type { ModelClient } from "../src/config/types.js";
import { readIndexes } from "../src/surface/index-file.js";
import { readTests } from "../src/surface/surface.js";
import { scriptedPrompter, tempDir } from "./helpers.js";

test("prefix discovery indexes and judges only selected sections without swallowing peer documentation", async () => {
  const cwd = tempDir("tyxtest-prefixed-spec-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/export"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/export.ts"), "export function filter() { return 'active products'; }\n");
  const file = path.join(cwd, "tyxtest/export/surface.md");
  const markdown = "# Export\n\nA customer export.\n\n## Background\n\nPersonal catalog exports.\n\n## Test: Export respects filters\n\nOnly active products are exported.\n\n## Implementation notes\n\nUNRELATED_PEER_DOCUMENTATION\n\n## test: Case-sensitive documentation\n\nNot selected.\n";
  fs.writeFileSync(file, markdown);
  const config = parseConfig({
    markdown: { testDiscovery: { mode: "headings", headingLevel: 2, prefix: "Test:" } },
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { provider: "typesafe", model: "jev", kind: "decision" },
    reruns: 0, escalate: false, relocateCheck: false, ignoreUnchanged: false,
  });
  const claim = readTests(markdown, config.markdown)[0]!;
  await indexCommand({ cwd, config, env: {}, interactive: false, prompter: scriptedPrompter([]), model: {
    async complete() { return JSON.stringify({ tests: [
      { testId: claim.id, chunks: [{ path: "src/export.ts", symbol: "filter" }] },
      { testId: "not-a-selected-test", chunks: [{ path: "src/export.ts", symbol: "filter" }] },
    ] }); },
  } });
  assert.equal(readIndexes(cwd).get("export")?.tests?.length, 1);
  const states: string[] = [];
  const runner: ModelClient = {
    async complete() { throw new Error("Unexpected LLM call"); },
    async decide(request) { states.push(request.state); return { probabilities: [0.99, 0.01] }; },
  };
  const run = () => runCommand({ cwd, config, model: runner, env: {}, stdout: () => {}, stderr: () => {} });
  const first = await run();
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0]?.text, "Export respects filters");
  assert.equal(first.results[0]?.verdict, "pass");
  assert.ok(states.some((state) => state.includes("Personal catalog exports.") && state.includes("Only active products are exported.")));
  assert.ok(states.every((state) => !state.includes("UNRELATED_PEER_DOCUMENTATION")));
  const calls = states.length;
  fs.writeFileSync(file, markdown.replace("UNRELATED_PEER_DOCUMENTATION", "Edited unrelated documentation."));
  assert.equal((await run()).results[0]?.cached, true);
  assert.equal(states.length, calls);
});

test("modern Markdown indexes and runs nested claims with notes without rewriting author text", async () => {
  const cwd = tempDir("tyxtest-authoring-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest", "index", "apply"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export function apply() { return true; }\n");
  const parent = "# Index commands\n\nMap product claims to code.\n\n## Claims are indexed\n";
  const child = "# Apply suggestions\n\nApply only pending suggestions.\n\n## Suggestions are applied\n\nLeave unrelated suggestions unchanged.\n\n```json\n{\"type\":\"object\",\"required\":[\"surface\"]}\n```\n\n### Supporting example\n\n- This list item is not a separate test.\n\n```md\n## This example heading is not a test\n```\n";
  const parentFile = path.join(cwd, "tyxtest", "index", "surface.md");
  const childFile = path.join(cwd, "tyxtest", "index", "apply", "surface.md");
  fs.writeFileSync(parentFile, parent);
  fs.writeFileSync(childFile, child);
  const claims = [...readTests(parent), ...readTests(child)];
  const config = parseConfig({
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    entryMode: "required",
    ignoreUnchanged: false,
    reruns: 0,
    relocateCheck: false,
  });
  const indexPrompts: string[] = [];
  const indexer: ModelClient = {
    async complete(request) {
      indexPrompts.push(request.prompt);
      return JSON.stringify({
        tests: claims.filter((claim) => request.prompt.includes(claim.id)).map((claim) => ({
          testId: claim.id,
          chunks: [{ path: "src/index.ts", symbol: "apply" }],
        })),
      });
    },
  };
  await indexCommand({ cwd, config, model: indexer, prompter: scriptedPrompter([]), env: {} });
  assert.equal(fs.readFileSync(parentFile, "utf8"), parent);
  assert.equal(fs.readFileSync(childFile, "utf8"), child);
  assert.ok(fs.existsSync(path.join(cwd, "tyxtest", ".index.json")));
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest", "index", ".index.json")), false);
  assert.equal(readIndexes(cwd).get("index/apply")?.tests?.[0]?.testId, claims[1]?.id);
  assert.ok(indexPrompts.some((prompt) => prompt.includes("Leave unrelated suggestions unchanged.")));

  const judgments: string[] = [];
  const runner: ModelClient = {
    async complete() { throw new Error("Unexpected LLM judgment"); },
    async decide(request) {
      judgments.push(request.state);
      return { probabilities: [0.99, 0.01] };
    },
  };
  let output = "";
  const result = await runCommand({
    cwd, config, model: runner, env: {},
    stdout: (text) => { output += text; },
    stderr: () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((claim) => claim.verdict === "pass"));
  assert.ok(judgments.some((state) => state.includes("Leave unrelated suggestions unchanged.")));
  assert.ok(judgments.some((state) => state.includes('"required":["surface"]') && state.includes("## This example heading is not a test")));
  assert.match(output, /Index commands/);
  assert.match(output, /Apply suggestions/);
  assert.match(output, /^Index commands\/\r?\n  - pass Claims are indexed\r?\n  Apply suggestions\/\r?\n    - pass Suggestions are applied/m);
  assert.doesNotMatch(output, new RegExp(`\\[${claims[1]?.id}\\]`));

  const originalParentIndex = readIndexes(cwd).get("index");
  const edited = child.replace("Leave unrelated suggestions unchanged.", "Only apply suggestions for this surface.");
  fs.writeFileSync(childFile, edited);
  const callsBeforeStaleRun = judgments.length;
  const stale = await runCommand({ cwd, config, model: runner, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(stale.results.find((claim) => claim.surface === "index/apply")?.verdict, "unsure");
  assert.equal(judgments.length, callsBeforeStaleRun);

  claims.splice(1, 1, ...readTests(edited));
  await indexCommand({ cwd, config, model: indexer, surfaces: ["index/apply"], prompter: scriptedPrompter([]), env: {} });
  assert.deepEqual(readIndexes(cwd).get("index"), originalParentIndex);
  assert.deepEqual(readIndexes(cwd).get("index/apply")?.tests?.map((claim) => claim.testId), [claims[1]?.id]);
  const refreshed = await runCommand({ cwd, config, model: runner, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(refreshed.results.find((claim) => claim.surface === "index/apply")?.verdict, "pass");
  assert.ok(judgments.some((state) => state.includes("Only apply suggestions for this surface.")));

  fs.writeFileSync(childFile, "# Apply suggestions\n\nNo claims remain.\n");
  await indexCommand({ cwd, config, model: indexer, surfaces: ["index/apply"], prompter: scriptedPrompter([]), env: {} });
  assert.deepEqual(readIndexes(cwd).get("index/apply")?.tests ?? [], []);
  assert.deepEqual(readIndexes(cwd).get("index/apply")?.flows ?? [], []);
  assert.deepEqual(readIndexes(cwd).get("index"), originalParentIndex);
});
