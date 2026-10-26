import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { backfillSurfaceFile, backfillTestIds } from "../src/surface.js";
import { tempDir } from "./helpers.js";

test("surface.md ID backfill writes a slug and keeps existing ids", () => {
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
  assert.deepEqual(
    result.tests.map((item) => item.id),
    ["submit-exists", "email-is-validated-before-submit"],
  );
  assert.equal(
    result.markdown,
    `---
surface: Login form
description: Email/password form on /login
entry: src/pages/login.tsx
---
- [submit-exists] There is a submit button in the form
- [email-is-validated-before-submit] Email is validated before submit
`,
  );
  assert.equal(backfillTestIds(result.markdown).changed, false);
  assert.equal(backfillTestIds(result.markdown).markdown, result.markdown);
});

test("surface.md ID backfill keeps prose and disambiguates duplicate slugs", () => {
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
  assert.match(result.markdown, /Intro line\./);
  assert.deepEqual(
    result.tests.map((item) => item.id),
    ["there-is-a-submit-button", "there-is-a-submit-button-2", "there-is-a-submit-button-3", "test"],
  );
});

test("surface.md ID backfill writes the file", () => {
  const cwd = tempDir("tyxtest-surface-");
  const file = path.join(cwd, "tyxtest", "login", "surface.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\nsurface: Login\n---\n- There is a submit button\n");
  const written = backfillSurfaceFile(file);
  assert.equal(written.changed, true);
  assert.equal(written.tests[0]?.id, "there-is-a-submit-button");
  assert.match(fs.readFileSync(file, "utf8"), /\[there-is-a-submit-button\]/);
  assert.equal(backfillSurfaceFile(file).changed, false);
});
