import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { claimHashFor, readIndex, readIndexes, writeIndex, type SurfaceIndex } from "../src/surface/index-file.js";
import { indexCommand } from "../src/commands/index-command.js";
import { parseConfig } from "../src/config/config.js";
import { collectIndexedEvidence } from "../src/closure/indexed-evidence.js";
import { addPending, readPending } from "../src/surface/pending.js";
import { runCommand } from "../src/commands/run.js";
import { readTests } from "../src/surface/surface.js";
import { scriptedPrompter, tempDir } from "./helpers.js";

const sample = (name: string): SurfaceIndex => ({
  closure: [{ path: `src/${name}.ts`, hash: `closure-${name}` }], closureHash: `hash-${name}`,
  entry: [`src/${name}.ts`], files: [{ path: `src/${name}.ts`, hash: `file-${name}`, symbols: ["z", "a"] }],
  notes: [], tests: [{ testId: "claim", claimHash: claimHashFor("claim text", "note"), chunks: [{ path: `src/${name}.ts`, symbol: "a" }] }],
});

test("consolidated index writes preserve surfaces and use compact stable record lines", () => {
  const cwd = tempDir("tyxtest-index-file-");
  writeIndex(path.join(cwd, "tyxtest/one/.index.json"), sample("one"));
  writeIndex(path.join(cwd, "tyxtest/two/.index.json"), sample("two"));
  const file = path.join(cwd, "tyxtest/.index.json");
  const text = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(text).version, 2);
  assert.ok(text.split(/\r?\n/).filter((line) => line.startsWith("    {")).every((line) => {
    const record = JSON.parse(line.replace(/,$/, "")) as Record<string, unknown>;
    return Object.keys(record).join(",") === Object.keys(record).sort().join(",");
  }));
  assert.equal(text, fs.readFileSync(file, "utf8"));
  assert.deepEqual([...readIndexes(cwd).keys()], ["one", "two"]);
  const read = readIndex(path.join(cwd, "tyxtest/one/.index.json"));
  assert.equal(read.closure, undefined);
  assert.equal(read.entry, undefined);
  assert.equal(read.closureHash, undefined);
  assert.deepEqual(read.files, []);
  assert.equal(read.tests?.[0]?.context, undefined);
  assert.deepEqual(read.tests?.[0]?.closure, [{ hash: "closure-one", path: "src/one.ts" }]);
  assert.equal(read.tests?.[0]?.closureHash, "hash-one");
});

test("schema v2 persists per-test closure and context without surface entry or closure aggregates", () => {
  const cwd = tempDir("tyxtest-index-v2-");
  const index: SurfaceIndex = {
    files: [], notes: ["central note"], contextHash: "surface-context",
    tests: [{ testId: "claim", chunks: [{ path: "src/impl.ts", symbol: "run" }], context: ["src/wiring.ts"], closure: [{ path: "src/impl.ts", hash: "impl" }], closureHash: "per-test" }],
    flows: [{ testId: "claim", steps: [{ id: "one", text: "Run", chunks: [{ path: "src/impl.ts", symbol: "run" }], context: ["src/wiring.ts"] }] }],
  };
  writeIndex(path.join(cwd, "tyxtest/child/.index.json"), index);
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8")) as { version: number; records: Array<Record<string, unknown>> };
  assert.equal(stored.version, 2);
  assert.ok(stored.records.every((record) => record.kind !== "closure" && !("entry" in record)));
  const roundtrip = readIndex(path.join(cwd, "tyxtest/child/.index.json"));
  assert.equal(roundtrip.contextHash, "surface-context");
  assert.deepEqual(roundtrip.tests?.[0]?.context, ["src/wiring.ts"]);
  assert.equal(roundtrip.tests?.[0]?.closureHash, "per-test");
  assert.deepEqual(roundtrip.tests?.[0]?.closure, [{ hash: "impl", path: "src/impl.ts" }]);
  assert.deepEqual(roundtrip.flows?.[0]?.steps[0]?.context, ["src/wiring.ts"]);
});

test("legacy per-surface files are readable and removed only after central persistence", () => {
  const cwd = tempDir("tyxtest-index-legacy-");
  const dir = path.join(cwd, "tyxtest/legacy");
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, ".index.json");
  fs.writeFileSync(legacy, JSON.stringify(sample("legacy")));
  assert.deepEqual(readIndex(legacy).closure, sample("legacy").closure);
  writeIndex(legacy, sample("legacy"));
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/.index.json")), true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(readIndexes(cwd).get("legacy")?.tests?.[0]?.context, undefined);
  assert.deepEqual(readIndexes(cwd).get("legacy")?.tests?.[0]?.closure, [{ hash: "closure-legacy", path: "src/legacy.ts" }]);
});

test("version 1 snapshots remain metadata and never become explicit context", () => {
  const cwd = tempDir("tyxtest-index-v1-");
  const central = path.join(cwd, "tyxtest/.index.json");
  fs.mkdirSync(path.dirname(central), { recursive: true });
  fs.writeFileSync(central, JSON.stringify({ version: 1, records: [
    { surface: "old", kind: "meta", closureHash: "legacy-hash", entry: ["src/entry.ts"], notes: [] },
    { surface: "old", kind: "closure", path: "src/entry.ts", hash: "entry-hash" },
    { surface: "old", kind: "source", path: "src/entry.ts", hash: "entry-hash", symbols: ["start"] },
    { surface: "old", kind: "test", testId: "legacy", chunks: [{ path: "src/entry.ts", symbol: "start" }] },
  ] }));
  const migrated = readIndexes(cwd).get("old")!;
  assert.equal(migrated.tests?.[0]?.context, undefined);
  assert.deepEqual(migrated.tests?.[0]?.closure, [{ hash: "entry-hash", path: "src/entry.ts" }]);
  assert.equal(migrated.tests?.[0]?.closureHash, "legacy-hash");
  writeIndex(path.join(cwd, "tyxtest/old/.index.json"), migrated);
  assert.equal(readIndexes(cwd).get("old")?.tests?.[0]?.context, undefined);
});

test("a child flow indexes unrelated files and all step contexts without an entry or parent index", async () => {
  const cwd = tempDir("tyxtest-flow-context-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/checkout/payment"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tyxtest/checkout/surface.md"), "# Checkout\n\nThe customer purchases their cart.\n\n- Payment must complete\n");
  fs.writeFileSync(path.join(cwd, "tyxtest/checkout/payment/surface.md"), "# Payment\n\nThe purchase payment handoff.\n\n- [flow] Opening checkout leads to a receipt\n");
  fs.writeFileSync(path.join(cwd, "src/ui.ts"), "export function begin() { return '/pay'; }\n");
  fs.writeFileSync(path.join(cwd, "src/api.ts"), `/*${"padding".repeat(20_000)}*/\nexport function finish() { return 'afterBudgetMarker'; }\n`);
  fs.writeFileSync(path.join(cwd, "src/caller.ts"), "import { finish } from './api.js'; export const receipt = finish();\n");
  let prompt = "";
  await indexCommand({
    cwd,
    config: parseConfig({ markdown: { tests: "bullets" }, indexModel: { provider: "ollama", model: "index" }, runnerModel: { kind: "llm", provider: "ollama", model: "run" } }),
    interactive: false,
    surfaces: ["checkout/payment"],
    prompter: scriptedPrompter([]),
    env: {},
    model: { async complete(request) {
      prompt = request.prompt;
      return JSON.stringify({ flows: [{ testId: "flow", steps: [
        { id: "begin", text: "Open payment", chunks: [{ path: "src/ui.ts", symbol: "begin" }] },
        { id: "finish", text: "Return receipt", chunks: [{ path: "src/api.ts", symbol: "finish" }] },
      ] }] });
    } },
  });
  assert.ok(prompt.startsWith("Exact declaration inventory"));
  assert.ok(prompt.indexOf("Code:") < prompt.lastIndexOf("\n\nSurface: "));
  assert.ok(prompt.includes("customer purchases their cart"));
  assert.ok(prompt.includes("Payment must complete"));
  assert.ok(prompt.includes("checkout/payment"));
  assert.ok(prompt.includes("afterBudgetMarker"));
  const indexes = readIndexes(cwd);
  assert.equal(indexes.has("checkout"), false);
  const child = indexes.get("checkout/payment")!;
  assert.deepEqual(child.tests?.[0]?.closure?.map((file) => file.path), ["src/api.ts", "src/ui.ts"]);
  assert.ok(child.contextHash);
  assert.equal(child.tests?.[0]?.claimHash, claimHashFor("Opening checkout leads to a receipt"));
  assert.equal(child.flows?.[0]?.steps.length, 2);
  assert.ok(child.flows?.[0]?.steps.every((step) => step.entry === undefined));
});

function qualityFixture(claims = ["The correct caller role is validated"]) {
  const cwd = tempDir("tyxtest-index-quality-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/quality"), { recursive: true });
  const markdown = `# Quality\n\nSemantic context for the real product.\n\n${claims.map((claim) => `## ${claim}\n\nFull specification body with exact role defaults.`).join("\n\n")}\n`;
  fs.writeFileSync(path.join(cwd, "tyxtest/quality/surface.md"), markdown);
  fs.writeFileSync(path.join(cwd, "src/caller.ts"), "import { literalKeyCheck, ROLE } from './helper.js';\nexport function chooseRole(role = ROLE) { return literalKeyCheck(role); }\n");
  fs.writeFileSync(path.join(cwd, "src/helper.ts"), "export const ROLE = 'customer';\nexport function literalKeyCheck(role: string) { return role === ROLE; }\n");
  const cases = readTests(markdown);
  const config = parseConfig({ indexModel: { provider: "ollama", model: "index" }, runnerModel: { kind: "decision", provider: "typesafe", model: "jev" }, reruns: 0, ignoreUnchanged: false });
  return { cwd, cases, config, markdown };
}

const preciseChunks = [
  { path: "src/caller.ts", symbol: "chooseRole" },
  { path: "src/helper.ts", symbol: "literalKeyCheck" },
  { path: "src/helper.ts", symbol: "ROLE" },
];

test("index normalizes actual import references while repairing removed refs instead of silently filtering them", async () => {
  const { cwd, cases, config, markdown } = qualityFixture();
  const prompter = scriptedPrompter([]);
  let calls = 0;
  await indexCommand({ cwd, config, prompter, interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      assert.match(request.prompt, /src\/helper\.ts#literalKeyCheck \d+ chars ~\d+ tokens/);
      assert.doesNotMatch(request.prompt, /^src\/caller\.ts#literalKeyCheck /m);
      assert.match(request.prompt, /Full specification body with exact role defaults/);
      assert.match(request.prompt, /Semantic context for the real product/);
      assert.match(request.system, /caller arguments\/default role selections/);
      assert.match(request.system, /context:\[\]/);
      if (calls === 1) return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [
        preciseChunks[0], { path: "src/caller.ts", symbol: "literalKeyCheck" }, { path: "src/helper.ts", symbol: "removed" },
      ] }] });
      assert.match(request.prompt, /REPAIR REQUIRED/);
      assert.doesNotMatch(request.prompt, /src\/caller\.ts#literalKeyCheck is not a declared selectable symbol/);
      assert.match(request.prompt, /src\/helper\.ts#removed/);
      assert.match(request.prompt, /export function literalKeyCheck/);
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: preciseChunks, context: [] },
        { testId: "unknown-test-id", chunks: [{ path: "nonexistent.ts", symbol: "invented" }] }] });
    },
  } });
  assert.equal(calls, 2);
  assert.ok(prompter.warnings.some((warning) => warning.includes("repairing invalid or incomplete mapping")));
  assert.ok(prompter.logs.some((message) => message.includes("normalized imported reference src/caller.ts#literalKeyCheck -> src/helper.ts#literalKeyCheck")));
  const mapping = readIndexes(cwd).get("quality")!.tests![0]!;
  assert.deepEqual(mapping.chunks, preciseChunks);
  assert.deepEqual(mapping.context, []);
  assert.equal(readIndexes(cwd).get("quality")!.tests!.length, 1);
  assert.equal(collectIndexedEvidence({ cwd, chunks: mapping.chunks }).missing, false);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/quality/surface.md"), "utf8"), markdown);
});

test("index repairs declared-but-incomplete dependency evidence using explicit precise selections", async () => {
  const { cwd, cases, config } = qualityFixture();
  let calls = 0;
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [preciseChunks[0]], missingDependencies: ["literalKeyCheck and ROLE default selection"] }] });
      assert.match(request.prompt, /necessary dependencies are not mapped: literalKeyCheck and ROLE default selection/);
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: preciseChunks }] });
    },
  } });
  assert.equal(calls, 2);
  const mapping = readIndexes(cwd).get("quality")!.tests![0]!;
  assert.equal(mapping.chunks.length, 3);
  assert.deepEqual(mapping.context, []);
});

test("unresolved symbols or missing claims stop after one repair without changing index or pending state", async () => {
  for (const invalid of ["symbol", "missing", "malformed", "path"] as const) {
    const { cwd, cases, config } = qualityFixture(["First claim", "Second claim"]);
    writeIndex(path.join(cwd, "tyxtest/quality/.index.json"), { files: [], notes: ["original"], tests: [] });
    addPending(cwd, { surface: "quality", testId: cases[0]!.id, reason: "preserve this until persistence succeeds" });
    const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
    const pendingBefore = fs.readFileSync(path.join(cwd, "tyxtest/.pending.json"), "utf8");
    let calls = 0;
    await assert.rejects(() => indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
      async complete() {
        calls += 1;
        if (invalid === "malformed") return JSON.stringify({ tests: cases.map((test) => ({ testId: test.id, chunks: [preciseChunks[0], { path: "src/helper.ts" }] })) });
        return JSON.stringify({ tests: (invalid === "missing" ? cases.slice(0, 1) : cases).map((test) => ({ testId: test.id,
          chunks: invalid === "symbol" ? [{ path: "src/helper.ts", symbol: "invented" }] : invalid === "path" ? [preciseChunks[0], { path: "src/missing.ts", symbol: "literalKeyCheck" }] : preciseChunks })) });
      },
    } }), /invalid after one repair; nothing was persisted/);
    assert.equal(calls, 2, invalid);
    assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), indexBefore);
    assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.pending.json"), "utf8"), pendingBefore);
  }
});

test("a later surface failure preserves earlier surfaces and pending suggestions until final persistence", async () => {
  const { cwd, cases, config } = qualityFixture();
  fs.mkdirSync(path.join(cwd, "tyxtest/a-first"));
  fs.writeFileSync(path.join(cwd, "tyxtest/a-first/surface.md"), "# First\n\n## First mapped claim\n");
  const first = readTests(fs.readFileSync(path.join(cwd, "tyxtest/a-first/surface.md"), "utf8"))[0]!;
  for (const surface of ["a-first", "quality"]) {
    writeIndex(path.join(cwd, `tyxtest/${surface}/.index.json`), { files: [], notes: ["old"], tests: [] });
    addPending(cwd, { surface, testId: surface === "quality" ? cases[0]!.id : first.id, reason: "old pending" });
  }
  const before = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
  let calls = 0;
  await assert.rejects(() => indexCommand({ cwd, config, pending: true, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      if (request.prompt.includes(`- [${first.id}]`)) return JSON.stringify({ tests: [{ testId: first.id, chunks: preciseChunks }] });
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [{ path: "src/helper.ts", symbol: "missing" }] }] });
    },
  } }), /invalid after one repair/);
  assert.equal(calls, 3);
  assert.equal(readPending(cwd).length, 2);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), before);
});

test("failed final index persistence does not clear pending suggestions", async () => {
  const { cwd, cases, config } = qualityFixture();
  addPending(cwd, { surface: "quality", testId: cases[0]!.id, reason: "pending must survive failed write" });
  await assert.rejects(() => indexCommand({ cwd, config, pending: true, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete() {
      fs.mkdirSync(path.join(cwd, "tyxtest/.index.json"));
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: preciseChunks }] });
    },
  } }));
  assert.equal(readPending(cwd).length, 1);
  assert.equal(readPending(cwd)[0]?.reason, "pending must survive failed write");
});

test("explicitly unmappable implementation persists empty chunks and reaches the decision runner", async () => {
  const { cwd, cases, config } = qualityFixture();
  const prompter = scriptedPrompter([]);
  let calls = 0;
  await indexCommand({ cwd, config, prompter, interactive: false, env: {}, model: {
    async complete() { calls += 1; return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [], unmappable: "No implementation of this feature is discoverable." }] }); },
  } });
  assert.equal(calls, 1);
  assert.ok(prompter.logs.includes("coverage quality: 0 mapped, 1 explicitly unmappable of 1 tests"));
  assert.match(readIndexes(cwd).get("quality")!.notes.join("\n"), /Unmappable test.*No implementation/);
  assert.deepEqual(readIndexes(cwd).get("quality")!.tests![0]!.chunks, []);
  assert.ok(prompter.warnings.some((warning) => warning.includes("Run will judge with no related code chunks")));
  let judgments = 0;
  const result = await runCommand({ cwd, config, env: {}, stdout: () => {}, stderr: () => {}, model: {
    async complete() { throw new Error("No reindex or LLM call expected"); },
    async decideMany(requests) {
      judgments += 1;
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.purpose, "verdict");
      assert.match(requests[0]!.state, /No related implementation was discoverable/);
      return [{ probabilities: [0, 1] }];
    },
  } });
  assert.ok(judgments > 0);
  assert.equal(result.results[0]?.verdict, "fail");
  assert.deepEqual(result.results[0]?.evidence, []);
});

test("flow step imports normalize without repair while missing step evidence or dependencies require repair", async () => {
  for (const invalid of ["import", "empty", "dependency"] as const) {
    const { cwd, cases, config } = qualityFixture();
    let calls = 0;
    await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
      async complete(request) {
        calls += 1;
        if (calls === 2) assert.match(request.prompt, /step check:/);
        return JSON.stringify({ flows: [{ testId: cases[0]!.id, steps: [{ id: "check", text: "Validate the selected role",
          chunks: calls === 2 ? preciseChunks : invalid === "empty" ? [] : invalid === "import" ? [{ path: "src/caller.ts", symbol: "literalKeyCheck" }] : [preciseChunks[0]],
          ...(calls === 1 && invalid === "dependency" ? { missingDependencies: ["ROLE default constant"] } : {}),
        }] }] });
      },
    } });
    assert.equal(calls, invalid === "import" ? 1 : 2, invalid);
    assert.deepEqual(readIndexes(cwd).get("quality")!.flows![0]!.steps[0]!.chunks, invalid === "import" ? [preciseChunks[1]] : preciseChunks);
  }
});

test("full-file context has an explicit cost warning while valid precise mappings need no repair", async () => {
  const { cwd, cases, config } = qualityFixture();
  fs.appendFileSync(path.join(cwd, "src/helper.ts"), "registerValidation(literalKeyCheck);\n");
  const prompter = scriptedPrompter([]);
  let calls = 0;
  await indexCommand({ cwd, config, prompter, interactive: false, env: {}, model: {
    async complete() { calls += 1; return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [preciseChunks[0]], context: ["src/helper.ts"], wholeFileReason: "The module's top-level validation registration and initialization ordering are necessary evidence." }] }); },
  } });
  assert.equal(calls, 1);
  assert.ok(prompter.warnings.some((warning) => /explicit whole-file context src\/helper\.ts costs \d+ chars \(~\d+ tokens\)/.test(warning)));
  assert.deepEqual(readIndexes(cwd).get("quality")!.tests![0]!.context, ["src/helper.ts"]);
});

test("unjustified full-file selections repair to precise chunks instead of hiding missing evidence", async () => {
  const { cwd, cases, config } = qualityFixture();
  let calls = 0;
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [preciseChunks[0]], context: ["src/helper.ts"] }] });
      assert.match(request.prompt, /whole-file input.*needs wholeFileReason/);
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: preciseChunks, context: [] }] });
    },
  } });
  assert.equal(calls, 2);
  assert.deepEqual(readIndexes(cwd).get("quality")!.tests![0]!.context, []);
});

test("malformed index JSON and missing claim coverage share the single bounded repair", async () => {
  for (const initial of ["not JSON", JSON.stringify({ tests: [] })]) {
    const { cwd, cases, config } = qualityFixture();
    let calls = 0;
    await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
      async complete(request) {
        calls += 1;
        if (calls === 1) return initial;
        assert.match(request.prompt, /REPAIR REQUIRED/);
        assert.match(request.prompt, /Full specification body/);
        return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: preciseChunks }] });
      },
    } });
    assert.equal(calls, 2);
    assert.equal(readIndexes(cwd).get("quality")!.tests![0]!.chunks.length, 3);
  }
});

test("index persists exact imported declarations without an extra model call or adding dependencies", async () => {
  const { cwd, cases, config } = qualityFixture();
  fs.writeFileSync(path.join(cwd, "src/decoy.ts"), "export function literalKeyCheck() { return 'DECOY'; }\n");
  fs.appendFileSync(path.join(cwd, "src/helper.ts"), "export function omitted() { return 'UNMAPPED_SENTINEL'; }\n");
  const prompter = scriptedPrompter([]);
  let calls = 0;
  await indexCommand({ cwd, config, prompter, interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      assert.ok(request.prompt.indexOf("Exact declaration inventory") < request.prompt.indexOf("Surface: Quality"));
      assert.ok(request.prompt.indexOf("Code:") < request.prompt.indexOf("Surface: Quality"));
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [
        { path: "src/caller.ts", symbol: "literalKeyCheck" }, { path: "src/caller.ts", symbol: "ROLE" },
      ] }] });
    },
  } });
  assert.equal(calls, 1);
  const mapping = readIndexes(cwd).get("quality")!.tests![0]!;
  assert.deepEqual(mapping.chunks, preciseChunks.slice(1));
  assert.deepEqual(mapping.context, []);
  assert.deepEqual(mapping.closure?.map((file) => file.path), ["src/helper.ts"]);
  const evidence = collectIndexedEvidence({ cwd, chunks: mapping.chunks });
  assert.equal(evidence.missing, false);
  assert.doesNotMatch(evidence.bundle, /UNMAPPED_SENTINEL|DECOY|function chooseRole/);
  assert.equal(prompter.logs.filter((message) => message.includes("normalized imported reference")).length, 2);
});

test("arbitrary wrong-file refs cannot use a globally unique declaration without actual provenance", async () => {
  const { cwd, cases, config } = qualityFixture();
  fs.writeFileSync(path.join(cwd, "src/unrelated.ts"), "export function unrelated() { return true; }\n");
  const prompter = scriptedPrompter([]);
  let calls = 0;
  await assert.rejects(() => indexCommand({ cwd, config, prompter, interactive: false, env: {}, model: {
    async complete() {
      calls += 1;
      return JSON.stringify({ tests: [{ testId: cases[0]!.id, chunks: [{ path: "src/unrelated.ts", symbol: "literalKeyCheck" }] }] });
    },
  } }), /invalid after one repair/);
  assert.equal(calls, 2);
  assert.equal(readIndexes(cwd).size, 0);
  assert.ok(!prompter.logs.some((message) => message.includes("normalized imported reference")));
});

test("targeted repair requests only a missing claim and preserves valid initial mappings and notes", async () => {
  const { cwd, cases, config } = qualityFixture(["Already mapped claim", "Initially omitted claim"]);
  const [good, missing] = cases;
  let calls = 0;
  let initialPrefix = "";
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      const marker = "\n\nTest ids:\n\n";
      if (calls === 1) {
        initialPrefix = request.prompt.slice(0, request.prompt.lastIndexOf(marker));
        return JSON.stringify({ tests: [{ testId: good!.id, chunks: [{ path: "src/caller.ts", symbol: "literalKeyCheck" }] }], notes: ["Keep the original note"] });
      }
      assert.equal(request.prompt.slice(0, request.prompt.lastIndexOf(marker)), initialPrefix);
      const requestedTests = request.prompt.slice(request.prompt.lastIndexOf(marker), request.prompt.indexOf("\n\nREPAIR REQUIRED"));
      assert.match(requestedTests, new RegExp(`\\[${missing!.id}\\]`));
      assert.doesNotMatch(requestedTests, new RegExp(`\\[${good!.id}\\]`));
      assert.match(request.prompt, /Full specification body/);
      assert.match(request.prompt, /Return mappings ONLY for the requested testIds/);
      return JSON.stringify({ tests: [{ testId: missing!.id, chunks: preciseChunks }], notes: ["Repair note", "Keep the original note"] });
    },
  } });
  assert.equal(calls, 2);
  const index = readIndexes(cwd).get("quality")!;
  assert.deepEqual(index.tests!.find((item) => item.testId === good!.id)!.chunks, [preciseChunks[1]]);
  assert.deepEqual(index.tests!.find((item) => item.testId === missing!.id)!.chunks, preciseChunks);
  assert.deepEqual(index.notes, ["Keep the original note", "Repair note"]);
});

test("repair cannot corrupt a valid flow and can replace an invalid ordinary claim with a flow", async () => {
  const { cwd, cases, config } = qualityFixture(["Valid initial flow", "Bad initial ordinary mapping"]);
  const [good, bad] = cases;
  const originalStep = { id: "original", text: "Keep this valid step", chunks: preciseChunks };
  const repairedStep = { id: "repaired", text: "A repaired path", chunks: preciseChunks };
  let calls = 0;
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tests: [{ testId: bad!.id, chunks: [{ path: "src/helper.ts", symbol: "removed" }] }],
        flows: [{ testId: good!.id, steps: [originalStep] }] });
      assert.doesNotMatch(request.prompt.slice(request.prompt.lastIndexOf("\n\nTest ids:\n\n")), new RegExp(`\\[${good!.id}\\]`));
      return JSON.stringify({ tests: [{ testId: good!.id, chunks: [{ path: "src/nonexistent.ts", symbol: "corruption" }] }], flows: [
        { testId: good!.id, steps: [] }, { testId: bad!.id, steps: [repairedStep] },
        { testId: "not-a-current-test", steps: [] },
      ] });
    },
  } });
  assert.equal(calls, 2);
  const index = readIndexes(cwd).get("quality")!;
  assert.deepEqual(index.tests!.find((item) => item.testId === good!.id)!.chunks, []);
  assert.deepEqual(index.tests!.find((item) => item.testId === bad!.id)!.chunks, []);
  assert.deepEqual(index.flows!.find((flow) => flow.testId === good!.id)!.steps, [{ ...originalStep, context: [] }]);
  assert.deepEqual(index.flows!.find((flow) => flow.testId === bad!.id)!.steps, [{ ...repairedStep, context: [] }]);
  assert.equal(index.flows!.length, 2);
});

test("repair replaces invalid flow counterparts with ordinary mappings while keeping a valid unmappable claim", async () => {
  const { cwd, cases, config } = qualityFixture(["Undiscoverable implementation", "Invalid initial flow"]);
  const [good, bad] = cases;
  let calls = 0;
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete() {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tests: [{ testId: good!.id, chunks: [], unmappable: "There is no implementation for this claim." }],
        flows: [{ testId: bad!.id, steps: [{ id: "invalid", text: "No evidence", chunks: [] }] }] });
      return JSON.stringify({ tests: [{ testId: bad!.id, chunks: preciseChunks }, { testId: good!.id, chunks: preciseChunks }] });
    },
  } });
  assert.equal(calls, 2);
  const index = readIndexes(cwd).get("quality")!;
  assert.deepEqual(index.tests!.find((item) => item.testId === good!.id)!.chunks, []);
  assert.deepEqual(index.tests!.find((item) => item.testId === bad!.id)!.chunks, preciseChunks);
  assert.equal(index.flows, undefined);
  assert.match(index.notes.join("\n"), /There is no implementation for this claim/);
});

test("an unresolved targeted repair still aborts without persisting good maps or clearing pending suggestions", async () => {
  const { cwd, cases, config } = qualityFixture(["Good initial mapping", "Still missing after repair"]);
  const [good, bad] = cases;
  writeIndex(path.join(cwd, "tyxtest/quality/.index.json"), { files: [], notes: ["Original store"], tests: [] });
  addPending(cwd, { surface: "quality", testId: bad!.id, reason: "Keep pending on repair failure" });
  const before = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
  let calls = 0;
  await assert.rejects(() => indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete() {
      calls += 1;
      return JSON.stringify({ tests: [{ testId: good!.id, chunks: calls === 1 ? preciseChunks : [{ path: "src/fake.ts", symbol: "bad" }] }] });
    },
  } }), new RegExp(`invalid after one repair[\\s\\S]*${bad!.id}[\\s\\S]*missing evidence mapping`));
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), before);
  assert.equal(readPending(cwd).length, 1);
});

test("globally malformed initial responses repair all current claims with the same source and semantic prefix", async () => {
  const { cwd, cases, config } = qualityFixture(["First claim after malformed JSON", "Second claim after malformed JSON"]);
  let calls = 0;
  let prefix = "";
  await indexCommand({ cwd, config, prompter: scriptedPrompter([]), interactive: false, env: {}, model: {
    async complete(request) {
      calls += 1;
      const split = request.prompt.lastIndexOf("\n\nTest ids:\n\n");
      if (calls === 1) { prefix = request.prompt.slice(0, split); return "malformed JSON"; }
      assert.equal(request.prompt.slice(0, split), prefix);
      for (const claim of cases) assert.match(request.prompt.slice(split), new RegExp(`\\[${claim.id}\\]`));
      return JSON.stringify({ tests: cases.map((claim) => ({ testId: claim.id, chunks: preciseChunks })) });
    },
  } });
  assert.equal(calls, 2);
  assert.equal(readIndexes(cwd).get("quality")!.tests!.length, 2);
});
