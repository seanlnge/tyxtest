import assert from "node:assert/strict";
import test from "node:test";

import { aggregateVerdicts, exitCodeFor } from "../src/verdict.js";

test("verdict aggregation: first pass", () => {
  assert.equal(aggregateVerdicts(["pass"]), "pass");
  assert.equal(aggregateVerdicts(["pass", "fail", "fail"]), "pass");
});

test("verdict aggregation: all fail", () => {
  assert.equal(aggregateVerdicts(["fail"]), "fail");
  assert.equal(aggregateVerdicts(["fail", "fail", "fail"]), "fail");
});

test("verdict aggregation: mixed", () => {
  assert.equal(aggregateVerdicts(["fail", "pass"]), "unsure");
  assert.equal(aggregateVerdicts(["fail", "unsure", "fail"]), "unsure");
  assert.equal(aggregateVerdicts(["fail", "pass", "unsure"]), "unsure");
  assert.equal(aggregateVerdicts(["unsure", "unsure", "unsure"]), "unsure");
});

test("unsure blocks only when configured", () => {
  assert.equal(exitCodeFor(["pass"], false), 0);
  assert.equal(exitCodeFor(["fail"], false), 1);
  assert.equal(exitCodeFor(["unsure"], false), 0);
  assert.equal(exitCodeFor(["unsure"], true), 1);
  assert.equal(exitCodeFor(["pass", "fail"], false), 1);
});
