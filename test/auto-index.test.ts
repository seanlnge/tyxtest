import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/commands/run.js";
import { parseConfig } from "../src/config/config.js";
import type { DecisionRequest, ModelClient, ModelRequest, TyxtestConfig } from "../src/config/types.js";
import { discoverSurfaces, surfaceContextFor } from "../src/surface/discover.js";
import { claimHashFor, readIndexes, writeIndex, type SurfaceIndex } from "../src/surface/index-file.js";
import { addPending, readPending } from "../src/surface/pending.js";
import { readTests } from "../src/surface/surface.js";
import { tempDir } from "./helpers.js";

function fixture(markdown = "# Product\n\nPersonal product context.\n\n## Alpha works\n\nFULL_BODY prose.\n\n```ts\nconst example = 'FULL_BODY_CODE';\n```\n", overrides: Record<string, unknown> = {}) {
  const cwd = tempDir("tyxtest-auto-index-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/product"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/code.ts"), "export function alpha() { return 'ALPHA_SOURCE'; }\nexport function beta() { return 'BETA_SOURCE'; }\nexport function gamma() { return 'GAMMA_SOURCE'; }\nexport function omitted() { return 'UNMAPPED_SENTINEL'; }\n");
  fs.writeFileSync(path.join(cwd, "src/context.ts"), "export const context = 'EXPLICIT_CONTEXT';\n");
  const file = path.join(cwd, "tyxtest/product/surface.md");
  fs.writeFileSync(file, markdown);
  const config = parseConfig({ indexModel: { provider: "anthropic", model: "index", apiKeyEnv: "AUTO_INDEX_KEY" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev", apiKeyEnv: "RUNNER_KEY" },
    ignoreUnchanged: false, reruns: 0, escalate: false, fallback: false, relocateCheck: false, concurrency: 1,
    guards: { literalKeyCheck: false }, ...overrides });
  return { cwd, file, config };
}

function current(cwd: string, config: TyxtestConfig, dir = "product", customize?: (index: SurfaceIndex) => void) {
  const surfaces = discoverSurfaces(cwd, config.markdown);
  const surface = surfaces.find((item) => item.relativeDir === dir)!;
  const cases = readTests(fs.readFileSync(surface.markdownPath, "utf8"), config.markdown);
  const index: SurfaceIndex = { files: [], notes: ["Keep existing notes"], contextHash: surfaceContextFor(surface, surfaces, config.markdown).hash,
    tests: cases.map((claim, position) => ({ testId: claim.id, claimHash: claimHashFor(claim.text, claim.notes),
      chunks: [{ path: "src/code.ts", symbol: position === 0 ? "alpha" : "gamma" }] })) };
  customize?.(index);
  writeIndex(path.join(cwd, `tyxtest/${dir}/.index.json`), index);
  return cases;
}

function targets(request: ModelRequest): string[] {
  const section = request.prompt.slice(request.prompt.lastIndexOf("\n\nTest ids:\n\n")).split("\n\nREPAIR REQUIRED")[0]!;
  return [...section.matchAll(/^- \[([^\]]+)\] /gm)].map((match) => match[1]!);
}

function models(symbol = "alpha") {
  const indexed: ModelRequest[] = [];
  const judged: DecisionRequest[][] = [];
  const model: ModelClient = {
    async complete(request) {
      assert.equal(request.purpose, "index");
      indexed.push(request);
      return JSON.stringify({ tests: targets(request).map((testId) => ({ testId, chunks: [{ path: "src/code.ts", symbol }] })) });
    },
    async decideMany(requests) { judged.push(requests); return requests.map(() => ({ probabilities: [1, 0] })); },
  };
  return { model, indexed, judged };
}

test("run automatically indexes a new surface before live judgment and then reuses index and verdict cache", async () => {
  const { cwd, file, config } = fixture();
  const markdown = fs.readFileSync(file, "utf8");
  const { model, indexed, judged } = models();
  const events: string[] = [];
  let progressText = "";
  const result = await runCommand({ cwd, config, model, interactive: false, env: {}, stdout: () => {}, stderr: (text) => events.push(text),
    indexModel: () => { events.push("index client"); return model; },
    progressSink: { write(text) { events.push("paint"); progressText += text; }, columns: 160 } });
  assert.equal(result.results[0]?.verdict, "pass");
  assert.equal(indexed.length, 1);
  assert.equal(judged.length, 1);
  assert.ok(events.findIndex((event) => event.startsWith("auto-index: product: 1")) < events.indexOf("index client"));
  assert.ok(events.indexOf("index client") < events.indexOf("paint"));
  assert.match(progressText, /index-model tokens: unavailable/);
  assert.match(indexed[0]!.prompt, /FULL_BODY_CODE/);
  assert.match(judged[0]![0]!.state, /FULL_BODY_CODE/);
  assert.match(judged[0]![0]!.state, /ALPHA_SOURCE/);
  assert.ok(judged[0]!.every((request) => !/UNMAPPED_SENTINEL|BETA_SOURCE|GAMMA_SOURCE/.test(request.state)));
  const mapping = readIndexes(cwd).get("product")!.tests![0]!;
  const claim = readTests(markdown)[0]!;
  assert.equal(mapping.claimHash, claimHashFor(claim.text, claim.notes));
  const before = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
  const again = await runCommand({ cwd, config, model, indexModel: () => { throw new Error("No index client needed for a current map"); }, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(again.results[0]?.cached, true);
  assert.equal(indexed.length, 1);
  assert.equal(judged.length, 1);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), before);
  assert.equal(fs.readFileSync(file, "utf8"), markdown);
});

test("added claims map only their subset and preserve trusted old tests, flows, context and pending suggestions", async () => {
  const { cwd, file, config } = fixture("# Product\n\nPersonal product context.\n\n## Alpha works\n\nUse this same form.\n\n## A flow works\n\nFollow the product path.\n");
  const claims = current(cwd, config, "product", (index) => {
    index.tests![0]!.context = ["src/context.ts"];
    index.tests![1]!.chunks = [];
    index.tests![1]!.context = ["src/context.ts"];
    index.flows = [{ testId: index.tests![1]!.testId, steps: [{ id: "path", text: "Follow the path", chunks: [{ path: "src/code.ts", symbol: "gamma" }], context: ["src/context.ts"] }] }];
  });
  const { model: initial } = models();
  await runCommand({ cwd, config, model: initial, env: {}, stdout: () => {}, stderr: () => {} });
  const before = readIndexes(cwd).get("product")!;
  for (const claim of claims) addPending(cwd, { surface: "product", testId: claim.id, reason: "Keep this source suggestion" });
  fs.appendFileSync(file, "\n## Beta is connected\n\nIt uses the same form described above.\n");
  const added = readTests(fs.readFileSync(file, "utf8"))[2]!;
  addPending(cwd, { surface: "product", testId: added.id, reason: "Will be refreshed" });
  const { model, indexed, judged } = models("beta");
  const originalComplete = model.complete;
  model.complete = async (request) => {
    const parsed = JSON.parse(await originalComplete(request));
    parsed.tests.push({ testId: claims[0]!.id, chunks: [{ path: "bad.ts", symbol: "corrupt" }] });
    parsed.flows = [{ testId: claims[1]!.id, steps: [] }];
    return JSON.stringify(parsed);
  };
  const result = await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(indexed.length, 1);
  assert.deepEqual(targets(indexed[0]!), [added.id]);
  assert.match(indexed[0]!.prompt, /Surface claims \(context only/);
  assert.match(indexed[0]!.prompt, /Use this same form/);
  assert.ok(!indexed[0]!.prompt.includes(`[${claims[0]!.id}]`));
  assert.equal(judged.length, 1);
  assert.ok(claims.every((claim) => result.results.find((item) => item.id === claim.id)?.cached));
  assert.equal(result.results.find((item) => item.id === added.id)?.cached, false);
  const after = readIndexes(cwd).get("product")!;
  for (const claim of claims) assert.deepEqual(after.tests!.find((item) => item.testId === claim.id), before.tests!.find((item) => item.testId === claim.id));
  assert.deepEqual(after.flows, before.flows);
  assert.deepEqual(readPending(cwd).map((item) => item.testId).sort(), claims.map((item) => item.id).sort());
});

test("full Markdown body edits refresh only the same heading claim before cache lookup", async () => {
  const { cwd, file, config } = fixture("# Product\n\nContext.\n\n## Alpha works\n\nOriginal prose.\n\n```ts\nconst example = 'OLD_BODY';\n```\n\n## Another claim\n\nKeep unchanged.\n");
  const claims = current(cwd, config);
  const initial = models();
  await runCommand({ cwd, config, model: initial.model, env: {}, stdout: () => {}, stderr: () => {} });
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("OLD_BODY", "NEW_BODY"));
  const edited = readTests(fs.readFileSync(file, "utf8"))[0]!;
  const changed = models("beta");
  const result = await runCommand({ cwd, config, model: changed.model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.deepEqual(targets(changed.indexed[0]!), [edited.id]);
  assert.equal(changed.judged.length, 1);
  assert.match(changed.judged[0]![0]!.state, /NEW_BODY/);
  assert.match(changed.judged[0]![0]!.state, /BETA_SOURCE/);
  assert.doesNotMatch(changed.judged[0]![0]!.state, /OLD_BODY|ALPHA_SOURCE/);
  assert.equal(result.results.find((item) => item.id === claims[1]!.id)?.cached, true);
  assert.ok(!readIndexes(cwd).get("product")!.tests!.some((item) => item.testId === claims[0]!.id));
});

test("a changed claim hash with a stable legacy id automatically refreshes that mapping", async () => {
  const { cwd, file, config } = fixture("# Product\n\nContext.\n\n- [stable-id] Alpha works\n", { markdown: { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } } });
  current(cwd, config);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Alpha works", "Beta works"));
  const { model, indexed, judged } = models("beta");
  const result = await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.deepEqual(targets(indexed[0]!), ["stable-id"]);
  assert.equal(result.results[0]?.verdict, "pass");
  assert.match(judged[0]![0]!.state, /BETA_SOURCE/);
  assert.equal(readIndexes(cwd).get("product")!.tests![0]!.claimHash, claimHashFor("Beta works"));
});

test("new flow claims automatically index and immediately judge step-local selected code", async () => {
  const { cwd, config } = fixture();
  let indexed = 0;
  const batches: DecisionRequest[][] = [];
  const model: ModelClient = {
    async complete(request) {
      indexed += 1;
      return JSON.stringify({ flows: targets(request).map((testId) => ({ testId, steps: [
        { id: "alpha", text: "First step", chunks: [{ path: "src/code.ts", symbol: "alpha" }] },
        { id: "beta", text: "Second step", chunks: [{ path: "src/code.ts", symbol: "beta" }] },
      ] })) });
    },
    async decideMany(requests) { batches.push(requests); return requests.map(() => ({ probabilities: [1, 0] })); },
  };
  const result = await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(result.results[0]?.verdict, "pass");
  assert.equal(indexed, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 4);
  assert.match(batches[0]![0]!.state, /ALPHA_SOURCE/);
  assert.doesNotMatch(batches[0]![0]!.state, /BETA_SOURCE|UNMAPPED_SENTINEL/);
  assert.match(batches[0]![2]!.state, /BETA_SOURCE/);
  assert.doesNotMatch(batches[0]![2]!.state, /ALPHA_SOURCE|UNMAPPED_SENTINEL/);
  assert.equal(readIndexes(cwd).get("product")!.flows![0]!.steps.length, 2);
});

test("ancestor semantic changes refresh every selected child claim without requiring or indexing a parent map", async () => {
  const { cwd, config } = fixture();
  fs.mkdirSync(path.join(cwd, "tyxtest/parent/child"), { recursive: true });
  const parent = path.join(cwd, "tyxtest/parent/surface.md");
  fs.writeFileSync(parent, "# Parent\n\nPersonal context.\n\n## Parent claim\n\nParent specification.\n");
  fs.writeFileSync(path.join(cwd, "tyxtest/parent/child/surface.md"), "# Child\n\nChild context.\n\n## Child alpha\n\n## Child beta\n");
  const claims = current(cwd, config, "parent/child");
  const other = current(cwd, config);
  const unrelated = readIndexes(cwd).get("product");
  const initial = models();
  await runCommand({ cwd, config, model: initial.model, surfaces: ["parent/child"], env: {}, stdout: () => {}, stderr: () => {} });
  fs.writeFileSync(parent, fs.readFileSync(parent, "utf8").replace("Personal context", "Administrator context"));
  const { model, indexed, judged } = models();
  const result = await runCommand({ cwd, config, model, surfaces: ["parent/child"], env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(indexed.length, 1);
  assert.deepEqual(targets(indexed[0]!), claims.map((claim) => claim.id));
  assert.equal(judged.length, 2);
  assert.ok(judged.every((batch) => batch[0]!.state.includes("Administrator context")));
  assert.ok(result.results.every((claim) => !claim.cached && claim.surface === "parent/child"));
  assert.equal(readIndexes(cwd).has("parent"), false);
  assert.deepEqual(readIndexes(cwd).get("product"), unrelated);
  assert.equal(other.length, 1);
  const child = path.join(cwd, "tyxtest/parent/child/surface.md");
  fs.writeFileSync(child, fs.readFileSync(child, "utf8").replace("Child context", "Revised child context"));
  const ownContext = await runCommand({ cwd, config, model, surfaces: ["parent/child"], env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(indexed.length, 2);
  assert.deepEqual(targets(indexed[1]!), claims.map((claim) => claim.id));
  assert.ok(ownContext.results.every((claim) => !claim.cached));
});

test("deletion-only synchronization prunes tests and flows without index credentials or model calls", async () => {
  const { cwd, file, config } = fixture("# Product\n\nContext.\n\n## Alpha works\n\n## Removed test\n\n## Removed flow\n");
  const claims = current(cwd, config, "product", (index) => {
    index.tests![2]!.chunks = [];
    index.flows = [{ testId: index.tests![2]!.testId, steps: [{ id: "old", text: "Old path", chunks: [{ path: "src/code.ts", symbol: "gamma" }] }] }];
  });
  for (const claim of claims) addPending(cwd, { surface: "product", testId: claim.id, reason: "Pending source check" });
  addPending(cwd, { surface: "unselected", testId: "keep", reason: "Leave unrelated pending" });
  const initial = models();
  await runCommand({ cwd, config, model: initial.model, env: {}, stdout: () => {}, stderr: () => {} });
  const retained = readIndexes(cwd).get("product")!.tests!.find((item) => item.testId === claims[0]!.id);
  fs.writeFileSync(file, "# Product\n\nContext.\n\n## Alpha works\n");
  let report = "";
  const next = await runCommand({ cwd, config, model: initial.model, indexModel: () => { throw new Error("Deletion must not create an index client"); }, env: {}, stdout: (text) => { report += text; }, stderr: () => {} });
  assert.equal(next.results[0]?.cached, true);
  assert.deepEqual(readIndexes(cwd).get("product")!.tests, [retained]);
  assert.equal(readIndexes(cwd).get("product")!.flows, undefined);
  assert.deepEqual(readPending(cwd).map((item) => item.testId).sort(), [claims[0]!.id, "keep"].sort());
  assert.doesNotMatch(report, /index-model tokens/);
  assert.equal(initial.indexed.length, 0);
});

test("automatic exact surface plans do not expand into unchanged descendants or prune unrelated stored surfaces", async () => {
  const { cwd, config } = fixture();
  fs.mkdirSync(path.join(cwd, "tyxtest/product/child"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tyxtest/product/child/surface.md"), "# Child\n\n## A child claim\n");
  current(cwd, config, "product/child", (index) => { index.tests![0]!.context = ["src/context.ts"]; });
  writeIndex(path.join(cwd, "tyxtest/unselected/.index.json"), { files: [], notes: ["Do not prune this unrelated surface"], tests: [] });
  const before = readIndexes(cwd);
  const { model, indexed } = models();
  await runCommand({ cwd, config, model, surfaces: ["product"], env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(indexed.length, 1);
  assert.deepEqual(readIndexes(cwd).get("product/child"), before.get("product/child"));
  assert.deepEqual(readIndexes(cwd).get("unselected"), before.get("unselected"));
});

test("index failures across selected surfaces preserve the whole store, cache, reports and pending before any judgment", async () => {
  const { cwd, file, config } = fixture();
  fs.mkdirSync(path.join(cwd, "tyxtest/second"));
  const secondFile = path.join(cwd, "tyxtest/second/surface.md");
  fs.writeFileSync(secondFile, "# Second\n\n## Existing second claim\n");
  current(cwd, config);
  current(cwd, config, "second");
  const initial = models();
  await runCommand({ cwd, config, model: initial.model, env: {}, stdout: () => {}, stderr: () => {} });
  const watched = ["tyxtest/.index.json", ".tyxtest/verdict-cache.json", ".tyxtest/results.json", ".tyxtest/junit.xml"];
  const before = watched.map((name) => fs.readFileSync(path.join(cwd, name), "utf8"));
  fs.appendFileSync(file, "\n## New product claim\n");
  fs.appendFileSync(secondFile, "\n## New second claim\n");
  addPending(cwd, { surface: "product", testId: readTests(fs.readFileSync(file, "utf8"))[1]!.id, reason: "Preserve on failure" });
  let indexCalls = 0;
  let judgments = 0;
  await assert.rejects(() => runCommand({ cwd, config, env: {}, stdout: () => {}, stderr: () => {}, model: {
    async complete(request) {
      indexCalls += 1;
      return JSON.stringify({ tests: targets(request).map((testId) => ({ testId, chunks: [{ path: "src/code.ts", symbol: request.prompt.includes("Surface: Second") ? "nonexistent" : "beta" }] })) });
    },
    async decideMany() { judgments += 1; throw new Error("Must not judge after index failure"); },
  } }), /invalid after one repair/);
  assert.equal(indexCalls, 3);
  assert.equal(judgments, 0);
  for (const [index, name] of watched.entries()) assert.equal(fs.readFileSync(path.join(cwd, name), "utf8"), before[index]);
  assert.equal(readPending(cwd).length, 1);
});

test("missing index credentials fail before runner initialization and before index/cache/report writes", async () => {
  const { cwd, config } = fixture();
  await assert.rejects(() => runCommand({ cwd, config, env: {}, stdout: () => {}, stderr: () => {} }), /Missing API key\. Set AUTO_INDEX_KEY/);
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/.index.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".tyxtest")), false);
});

test("current ordinary and legacy flow-only maps judge without creating an index client or requiring its config", async () => {
  for (const flowOnly of [false, true]) {
    const { cwd, config } = fixture();
    current(cwd, config, "product", (index) => {
      if (!flowOnly) return;
      index.flows = [{ testId: index.tests![0]!.testId, steps: [{ id: "legacy", text: "An existing path", chunks: [{ path: "src/code.ts", symbol: "alpha" }] }] }];
      index.tests = [];
    });
    const before = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
    if (flowOnly) assert.equal(readIndexes(cwd).get("product")!.tests, undefined);
    const { model, indexed, judged } = models();
    const result = await runCommand({ cwd, config: { ...config, indexModel: undefined }, model,
      indexModel: () => { throw new Error("A current map must not resolve an unused index client"); }, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal(result.results[0]?.verdict, "pass");
    assert.equal(indexed.length, 0);
    assert.equal(judged.length, 1);
    assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), before);
  }
});

test("new mappings bypass Git unchanged filtering and an old matching cache without creating commits", async () => {
  const { cwd, config } = fixture();
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".tyxtest/\n");
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  const tree = execFileSync("git", ["write-tree"], { cwd, encoding: "utf8" }).trim();
  const { model, indexed, judged } = models();
  const settings = { ...config, ignoreUnchanged: true, baseRef: tree };
  const first = await runCommand({ cwd, config: settings, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(first.results[0]?.verdict, "pass");
  fs.rmSync(path.join(cwd, "tyxtest/.index.json"));
  const readded = await runCommand({ cwd, config: settings, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.equal(readded.results[0]?.verdict, "pass");
  assert.equal(readded.results[0]?.cached, false);
  assert.equal(indexed.length, 2);
  assert.equal(judged.length, 2);
});

test("explicit unmappable claims and source-missing existing maps do not trigger repeated automatic indexing", async () => {
  for (const mode of ["unmappable", "missing-source"]) {
    const { cwd, config } = fixture();
    let indexCalls = 0;
    let judgments = 0;
    const model: ModelClient = {
      async complete(request) { indexCalls += 1; return JSON.stringify({ tests: targets(request).map((testId) => ({ testId, chunks: [], unmappable: "No discoverable implementation for this claim." })) }); },
      async decideMany(requests) {
        judgments += 1;
        assert.equal(mode, "unmappable");
        assert.equal(requests.length, 1);
        assert.match(requests[0]!.state, /No related implementation was discoverable/);
        assert.doesNotMatch(requests[0]!.state, /ALPHA_SOURCE|UNMAPPED_SENTINEL/);
        return [{ probabilities: [0, 1] }];
      },
    };
    if (mode === "missing-source") {
      current(cwd, config);
      fs.writeFileSync(path.join(cwd, "src/code.ts"), "export function beta() { return true; }\n");
    }
    const expected = mode === "unmappable" ? "fail" : "unsure";
    assert.equal((await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} })).results[0]?.verdict, expected);
    const before = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
    assert.equal((await runCommand({ cwd, config, model, indexModel: () => { throw new Error("Do not auto-reindex source problems or explicit unmappable claims"); }, env: {}, stdout: () => {}, stderr: () => {} })).results[0]?.verdict, expected);
    assert.equal(indexCalls, mode === "unmappable" ? 1 : 0);
    assert.equal(judgments, mode === "unmappable" ? 1 : 0);
    assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), before);
  }
});

test("empty mappings preserve decision verdicts and support cache reuse and forced judgment", async () => {
  for (const [pPass, verdict] of [[1, "pass"], [0, "fail"], [0.5, "unsure"]] as const) {
    const { cwd, config } = fixture();
    current(cwd, config, "product", (index) => { index.tests![0]!.chunks = []; });
    let judgments = 0;
    const model: ModelClient = {
      async complete() { throw new Error("Empty mappings must not trigger indexing or fallback"); },
      async decideMany(requests) {
        judgments += 1;
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.purpose, "verdict");
        assert.match(requests[0]!.state, /FULL_BODY_CODE/);
        assert.match(requests[0]!.state, /There are no indexed code chunks/);
        return [{ probabilities: [pPass, 1 - pPass] }];
      },
    };
    for (const all of [false, false, true]) {
      const result = await runCommand({ cwd, config, model, all, env: {}, stdout: () => {}, stderr: () => {} });
      assert.equal(result.results[0]?.verdict, verdict);
      assert.deepEqual(result.results[0]?.evidence, []);
    }
    assert.equal(judgments, 2);
    assert.deepEqual(readPending(cwd), []);
  }
});

test("automatic indexing respects configured heading and bullet prefixes and preserves full bodies", async () => {
  for (const mode of ["headings", "bullets"] as const) {
    const markdown = mode === "headings"
      ? "# Product\n\n## Documentation\n\nNot a claim.\n\n### Test: Alpha works\n\nFull body prose.\n\n```ts\nconst example = 'PREFIX_BODY';\n```\n"
      : "# Product\n\n- Documentation\n- [test] Alpha works\n  Full body prose.\n  ```ts\n  const example = 'PREFIX_BODY';\n  ```\n";
    const { cwd, file, config } = fixture(markdown, { markdown: { testDiscovery: { mode, headingLevel: 3, prefix: mode === "headings" ? "Test: " : "[test]" } } });
    const { model, indexed, judged } = models();
    await runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
    assert.equal(targets(indexed[0]!).length, 1);
    assert.match(indexed[0]!.prompt, /PREFIX_BODY/);
    assert.match(judged[0]![0]!.state, /PREFIX_BODY/);
    assert.equal(fs.readFileSync(file, "utf8"), markdown);
  }
});

test("preparation token accounting separates shared mutable index/runner clients and per-run baselines", async () => {
  const { cwd, file, config } = fixture();
  const usage = { inputTokens: 100, outputTokens: 10, available: true };
  const model: ModelClient = {
    async complete(request) { usage.inputTokens += 40; usage.outputTokens += 4; return JSON.stringify({ tests: targets(request).map((testId) => ({ testId, chunks: [{ path: "src/code.ts", symbol: "alpha" }] })) }); },
    async decideMany(requests) { usage.inputTokens += 7; usage.outputTokens += 2; return requests.map(() => ({ probabilities: [1, 0] })); },
    usage() { return usage; },
  };
  let report = "";
  const run = () => runCommand({ cwd, config, model, env: {}, stdout: (text) => { report += text; }, stderr: () => {} });
  await run();
  assert.match(report, /index-model tokens: 40 input, 4 output/);
  assert.match(report, /runner tokens: 7 input, 2 output/);
  assert.match(report, /fallback-model tokens: 0 input, 0 output/);
  report = "";
  await run();
  assert.doesNotMatch(report, /index-model tokens/);
  assert.match(report, /runner tokens: 0 input, 0 output/);
  fs.appendFileSync(file, "\n## New shared-client claim\n");
  report = "";
  await run();
  assert.match(report, /index-model tokens: 40 input, 4 output/);
  assert.match(report, /runner tokens: 7 input, 2 output/);
});

test("index and fallback aliases report preparation separately from later escalation with no double counting", async () => {
  const { cwd, config } = fixture();
  const usage = { inputTokens: 100, outputTokens: 10, available: true };
  const indexer: ModelClient = {
    async complete(request) {
      if (request.purpose === "index") {
        usage.inputTokens += 20; usage.outputTokens += 3;
        return JSON.stringify({ tests: targets(request).map((testId) => ({ testId, chunks: [{ path: "src/code.ts", symbol: "alpha" }] })) });
      }
      assert.equal(request.purpose, "run");
      usage.inputTokens += 11; usage.outputTokens += 2;
      return JSON.stringify({ verdict: "pass", evidence: [{ file: "src/code.ts", line: 1 }] });
    },
    usage() { return usage; },
  };
  const runner: ModelClient = {
    async complete() { throw new Error("Runner cannot generate"); },
    async decideMany() { throw new Error("Decision API unavailable"); },
    usage() { return { inputTokens: 0, outputTokens: 0, available: true }; },
  };
  let report = "";
  const result = await runCommand({ cwd, config: { ...config, fallback: true }, model: runner, indexModel: indexer, env: {}, stdout: (text) => { report += text; }, stderr: () => {} });
  assert.equal(result.results[0]?.verdict, "pass");
  assert.match(report, /index-model tokens: 20 input, 3 output/);
  assert.match(report, /fallback-model tokens: 11 input, 2 output/);
  assert.match(report, /runner tokens: 0 input, 0 output/);
});
