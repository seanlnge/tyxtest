import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cacheKey, judgmentContextFingerprint } from "../src/verdict/cache.js";
import type { TyxtestConfig } from "../src/config/types.js";
import type { FlowRecord } from "../src/surface/index-file.js";
import { hashLockfiles } from "../src/verdict/lockfile.js";
import { tempDir } from "./helpers.js";

const base = {
  testId: "submit-exists",
  testText: "There is a submit button",
  closureHash: "closure-hash",
  lockfileHash: "lockfile-hash",
  optionOrder: ["pass", "fail"],
  judgmentContext: "jctx-v1:context-hash",
};

const config: TyxtestConfig = {
  runnerModel: { provider: "test", model: "decision-v1", kind: "decision", apiKeyEnv: "TEST_KEY" },
  indexModel: { provider: "test", model: "index-v1" },
  escalate: true,
  escalateModel: { provider: "test", model: "escalate-v1", kind: "llm" },
  fallback: true,
  thresholds: { pass: 0.9, fail: 0.1 },
  ignoreUnchanged: false,
  baseRef: "main",
  entryMode: "required",
  nonInteractive: "fail",
  reruns: 1,
  verdictRule: "worst",
  unsureBlocks: false,
  showCached: false,
  triage: true,
  relocateCheck: true,
  closureDepth: null,
  maxQuestions: 5,
  chunkMaxTokens: 4000,
  concurrency: 8,
  guards: { literalKeyCheck: true, gitignoreEnv: true },
};
const surface = { relativeDir: "checkout", name: "Checkout", description: "Completes an order", entry: "src/checkout.ts" };
const flows: FlowRecord[] = [{
  testId: "submit-exists",
  steps: [{ id: "submit", text: "Submit the order", entry: "src/checkout.ts", chunks: [{ path: "src/checkout.ts", symbol: "submit" }] }],
  closure: [{ path: "src/checkout.ts", hash: "abc" }],
}];

test("cache keys change when any component changes", () => {
  const key = cacheKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, cacheKey({ ...base }));
  assert.notEqual(key, cacheKey({ ...base, testId: "email-validated" }));
  assert.notEqual(key, cacheKey({ ...base, testText: "Email is validated before submit" }));
  assert.notEqual(key, cacheKey({ ...base, closureHash: "other-closure" }));
  assert.notEqual(key, cacheKey({ ...base, lockfileHash: "other-lock" }));
  assert.notEqual(key, cacheKey({ ...base, optionOrder: ["fail", "pass"] }));
  assert.equal(key, cacheKey({ ...base, optionOrder: ["pass", "fail"] }));
  assert.equal(key, cacheKey({ ...base, chunkIds: [] }));
  assert.notEqual(key, cacheKey({ ...base, chunkIds: ["src/login.ts#SubmitButton"] }));
});

test("judgment context fingerprints judgment policy and ordered flow content", () => {
  const fingerprint = judgmentContextFingerprint(config, surface, flows);
  assert.match(fingerprint, /^jctx-v1:[a-f0-9]{64}$/);
  assert.equal(fingerprint, judgmentContextFingerprint({ ...config }, { ...surface }, structuredClone(flows)));
  const step = flows[0]!.steps[0]!;
  const invalidations: Array<[string, TyxtestConfig, typeof surface, FlowRecord[]]> = [
    ["surface path namespace", config, { ...surface, relativeDir: "admin/checkout" }, flows],
    ["surface description", config, { ...surface, description: "Different claim context" }, flows],
    ["thresholds", { ...config, thresholds: { pass: 0.95, fail: 0.1 } }, surface, flows],
    ["runner model", { ...config, runnerModel: { ...config.runnerModel!, model: "other" } }, surface, flows],
    ["model kind", { ...config, runnerModel: { ...config.runnerModel!, kind: "llm" } }, surface, flows],
    ["escalation flag", { ...config, escalate: false }, surface, flows],
    ["escalation model", { ...config, escalateModel: { ...config.escalateModel!, model: "other" } }, surface, flows],
    ["fallback policy", { ...config, fallback: false }, surface, flows],
    ["retry count", { ...config, reruns: 2 }, surface, flows],
    ["verdict aggregation", { ...config, verdictRule: "majority" }, surface, flows],
    ["flow entry", config, surface, [{ ...flows[0]!, steps: [{ ...step, entry: "src/other.ts" }] }]],
    ["flow step order", config, surface, [{ ...flows[0]!, steps: [{ ...step, id: "first" }, { ...step, id: "second" }] }]],
    ["flow chunk mapping", config, surface, [{ ...flows[0]!, steps: [{ ...step, chunks: [{ path: "src/other.ts", symbol: "other" }] }] }]],
  ];
  for (const [label, changedConfig, changedSurface, changedFlows] of invalidations) {
    assert.notEqual(judgmentContextFingerprint(changedConfig, changedSurface, changedFlows), fingerprint, label);
  }
  const orderedSteps = [{ ...step, id: "first" }, { ...step, id: "second" }];
  const orderedFlow: FlowRecord[] = [{ ...flows[0]!, steps: orderedSteps }];
  const reversedFlow: FlowRecord[] = [{ ...flows[0]!, steps: [...orderedSteps].reverse() }];
  assert.notEqual(judgmentContextFingerprint(config, surface, orderedFlow), judgmentContextFingerprint(config, surface, reversedFlow));
  const orderedChunks: FlowRecord[] = [{ ...flows[0]!, steps: [{ ...step, chunks: [step.chunks[0]!, { path: "src/other.ts", symbol: "other" }] }] }];
  const reversedChunks: FlowRecord[] = [{ ...flows[0]!, steps: [{ ...step, chunks: [...orderedChunks[0]!.steps[0]!.chunks].reverse() }] }];
  assert.notEqual(judgmentContextFingerprint(config, surface, orderedChunks), judgmentContextFingerprint(config, surface, reversedChunks));
  assert.notEqual(
    judgmentContextFingerprint(config, surface, flows, ["a", "b"]),
    judgmentContextFingerprint(config, surface, flows, ["b", "a"]),
  );
  assert.notEqual(judgmentContextFingerprint(config, surface, flows, ["chunk-a"]), judgmentContextFingerprint(config, surface, flows, ["chunk-b"]));
  const excludedConfig: TyxtestConfig = {
    ...config,
    showCached: true,
    concurrency: 1,
    baseRef: "develop",
    unsureBlocks: true,
    maxQuestions: 99,
    runnerModel: { ...config.runnerModel!, apiKeyEnv: "OTHER_KEY" },
    escalateModel: { ...config.escalateModel!, apiKeyEnv: "ANOTHER_KEY" },
  };
  assert.equal(fingerprint, judgmentContextFingerprint(excludedConfig, surface, flows));
  assert.equal(fingerprint, judgmentContextFingerprint(config, surface, flows));
});

test("cache keys incorporate the versioned judgment context", () => {
  assert.notEqual(cacheKey(base), cacheKey({ ...base, judgmentContext: "jctx-v1:different" }));
});

test("lockfile hash changes when the lockfile changes", () => {
  const cwd = tempDir("tyxtest-lock-");
  const empty = hashLockfiles(cwd);
  assert.equal(empty, hashLockfiles(cwd));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), "{\"name\":\"sample\"}\n");
  const filled = hashLockfiles(cwd);
  assert.notEqual(filled, empty);
  assert.equal(filled, hashLockfiles(cwd));
});
