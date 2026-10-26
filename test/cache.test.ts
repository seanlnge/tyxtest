import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cacheKey } from "../src/verdict/cache.js";
import { hashLockfiles } from "../src/verdict/lockfile.js";
import { tempDir } from "./helpers.js";

const base = {
  testId: "submit-exists",
  testText: "There is a submit button",
  closureHash: "closure-hash",
  lockfileHash: "lockfile-hash",
  optionOrder: ["pass", "fail"],
};

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

test("lockfile hash changes when the lockfile changes", () => {
  const cwd = tempDir("tyxtest-lock-");
  const empty = hashLockfiles(cwd);
  assert.equal(empty, hashLockfiles(cwd));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), "{\"name\":\"sample\"}\n");
  const filled = hashLockfiles(cwd);
  assert.notEqual(filled, empty);
  assert.equal(filled, hashLockfiles(cwd));
});
