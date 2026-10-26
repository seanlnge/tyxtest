import assert from "node:assert/strict";
import test from "node:test";

import { aggregateVerdicts, exitCodeFor, thresholdVerdict } from "../src/verdict/verdict.js";

test("p(pass) thresholds: pass, fail, and between", () => {
  const thresholds = { pass: 0.9, fail: 0.1 };
  assert.equal(thresholdVerdict(0.9, thresholds), "pass");
  assert.equal(thresholdVerdict(0.95, thresholds), "pass");
  assert.equal(thresholdVerdict(0.1, thresholds), "fail");
  assert.equal(thresholdVerdict(0.05, thresholds), "fail");
  assert.equal(thresholdVerdict(0.5, thresholds), "between");
  assert.equal(thresholdVerdict(0.11, thresholds), "between");
  assert.equal(thresholdVerdict(0.89, thresholds), "between");
});

test("verdict aggregation: all pass", () => {
  assert.equal(aggregateVerdicts(["pass"]), "pass");
  assert.equal(aggregateVerdicts(["pass", "pass", "pass"]), "pass");
});

test("verdict aggregation: all fail", () => {
  assert.equal(aggregateVerdicts(["fail"]), "fail");
  assert.equal(aggregateVerdicts(["fail", "fail", "fail"]), "fail");
});

test("verdict aggregation: mixed pass and fail is unsure in any order", () => {
  assert.equal(aggregateVerdicts(["fail", "pass"]), "unsure");
  assert.equal(aggregateVerdicts(["pass", "fail"]), "unsure");
  assert.equal(aggregateVerdicts(["fail", "fail", "pass"]), "unsure");
  assert.equal(aggregateVerdicts(["pass", "fail", "fail"]), "unsure");
  assert.equal(aggregateVerdicts(["fail", "pass", "unsure"]), "unsure");
  assert.equal(aggregateVerdicts(["pass", "unsure", "fail"]), "unsure");
});

test("verdict aggregation: unsure stays unsure unless every attempt agrees", () => {
  assert.equal(aggregateVerdicts(["fail", "unsure", "fail"]), "unsure");
  assert.equal(aggregateVerdicts(["pass", "unsure"]), "unsure");
  assert.equal(aggregateVerdicts(["unsure", "unsure", "unsure"]), "unsure");
  assert.equal(aggregateVerdicts([]), "unsure");
});

test("verdict aggregation supports majority and best rules", () => {
  assert.equal(aggregateVerdicts(["pass", "pass", "fail"], "majority"), "pass");
  assert.equal(aggregateVerdicts(["fail", "fail", "pass"], "majority"), "fail");
  assert.equal(aggregateVerdicts(["pass", "fail"], "majority"), "unsure");
  assert.equal(aggregateVerdicts(["pass", "fail"], "best"), "pass");
  assert.equal(aggregateVerdicts(["fail", "fail"], "best"), "fail");
  assert.equal(aggregateVerdicts(["fail", "unsure"], "best"), "unsure");
});

test("unsure blocks only when configured", () => {
  assert.equal(exitCodeFor(["pass"], false), 0);
  assert.equal(exitCodeFor(["fail"], false), 1);
  assert.equal(exitCodeFor(["unsure"], false), 0);
  assert.equal(exitCodeFor(["unsure"], true), 1);
  assert.equal(exitCodeFor(["pass", "fail"], false), 1);
});
