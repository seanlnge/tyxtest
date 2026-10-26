import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { backfillSurfaceFile, backfillTestIds, testIdFor } from "../src/surface/surface.js";
import { tempDir } from "./helpers.js";

test("a claim without an id gets a stable hash id written into the markdown", () => {
  const input = `---
surface: Login form
description: Email/password form on /login
entry: src/pages/login.tsx
---
- [submit-exists] There is a submit button in the form
- Email is validated before submit
`;
  const result = backfillTestIds(input);
  assert.equal(result.changed, true);
  assert.match(result.markdown, new RegExp(`- \\[${testIdFor("Email is validated before submit")}\\] Email is validated before submit`));
  assert.deepEqual(
    result.tests.map((item) => item.id),
    ["submit-exists", testIdFor("Email is validated before submit")],
  );
});

test("duplicate claims get distinct hash ids and prose stays put", () => {
  const input = `---
surface: Login form
---

Intro line.

- [there-is-a-submit-button] Kept
- There is a submit button
- There is a submit button
- !!!
`;
  const result = backfillTestIds(input);
  assert.equal(result.changed, true);
  assert.match(result.markdown, /Intro line\./);
  assert.match(result.markdown, /\[there-is-a-submit-button\] Kept/);
  const hashed = testIdFor("There is a submit button");
  assert.deepEqual(result.tests.map((item) => item.id), [
    "there-is-a-submit-button",
    hashed,
    `${hashed}-2`,
    testIdFor("!!!"),
  ]);
});

test("indexing a surface writes hash ids into the file", () => {
  const cwd = tempDir("tyxtest-surface-");
  const file = path.join(cwd, "tyxtest", "login", "surface.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = "---\nsurface: Login\n---\n- There is a submit button\n";
  fs.writeFileSync(file, original);
  const written = backfillSurfaceFile(file);
  assert.equal(written.changed, true);
  assert.equal(written.tests[0]?.id, testIdFor("There is a submit button"));
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`\\[${testIdFor("There is a submit button")}\\]`));
});
