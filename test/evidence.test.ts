import assert from "node:assert/strict";
import test from "node:test";

import { applyEvidenceCheck } from "../src/verdict/evidence.js";
import { hashContent } from "../src/util/hash.js";

const source = "export const submit = true;\n";
const closure = [{ path: "src/login.ts", hash: hashContent(source) }];
const files = { "src/login.ts": source };

test("pass with valid evidence stays pass", () => {
  assert.equal(applyEvidenceCheck("pass", [{ file: "src/login.ts", line: 1 }], closure, files), "pass");
});

test("pass without valid evidence becomes unsure", () => {
  assert.equal(applyEvidenceCheck("pass", [], closure, files), "unsure");
  assert.equal(applyEvidenceCheck("pass", [{ file: "src/login.ts", line: 9 }], closure, files), "unsure");
  assert.equal(applyEvidenceCheck("pass", [{ file: "src/missing.ts", line: 1 }], closure, files), "unsure");
  assert.equal(
    applyEvidenceCheck("pass", [{ file: "src/login.ts", line: 1 }], [{ path: "src/login.ts", hash: "deadbeef" }], files),
    "unsure",
  );
  assert.equal(
    applyEvidenceCheck(
      "pass",
      [
        { file: "src/login.ts", line: 1 },
        { file: "src/missing.ts", line: 1 },
      ],
      closure,
      files,
    ),
    "unsure",
  );
});

test("fail without evidence stays fail", () => {
  assert.equal(applyEvidenceCheck("fail", [], closure, files), "fail");
  assert.equal(applyEvidenceCheck("unsure", [], closure, files), "unsure");
});
