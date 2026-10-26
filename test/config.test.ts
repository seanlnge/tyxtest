import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultApiKeyEnv, loadConfig, parseConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

test("config defaults", () => {
  const config = parseConfig({});
  assert.equal(config.entryMode, "ask-plain");
  assert.equal(config.nonInteractive, "fail");
  assert.equal(config.reruns, 2);
  assert.equal(config.verdictRule, "worst");
  assert.equal(config.unsureBlocks, false);
  assert.equal(config.closureDepth, null);
  assert.equal(config.escalate, true);
  assert.equal(config.escalateModel, undefined);
  assert.deepEqual(config.thresholds, { pass: 0.9, fail: 0.1 });
  assert.equal(config.ignoreUnchanged, true);
  assert.equal(config.baseRef, "origin/main");
  assert.equal(config.triage, false);
  assert.equal(config.relocateCheck, true);
  assert.deepEqual(config.guards, { literalKeyCheck: true, gitignoreEnv: true });
  assert.equal(config.indexModel, undefined);
  assert.equal(config.runnerModel, undefined);
});

test("config keeps explicit values and fills the other guard", () => {
  const config = parseConfig({
    entryMode: "required",
    nonInteractive: "search",
    reruns: 0,
    unsureBlocks: true,
    closureDepth: 0,
    guards: { literalKeyCheck: false },
    indexModel: { provider: "anthropic", model: "claude", apiKeyEnv: "TYXTEST_INDEX_KEY" },
    runnerModel: { provider: "openai", model: "gpt" },
  });
  assert.equal(config.entryMode, "required");
  assert.equal(config.nonInteractive, "search");
  assert.equal(config.reruns, 0);
  assert.equal(config.unsureBlocks, true);
  assert.equal(config.closureDepth, 0);
  assert.equal(config.guards.literalKeyCheck, false);
  assert.equal(config.guards.gitignoreEnv, true);
  assert.equal(config.indexModel?.apiKeyEnv, "TYXTEST_INDEX_KEY");
  assert.equal(config.runnerModel?.provider, "openai");
  assert.equal(config.runnerModel?.kind, "decision");
});

test("config rejects a literal API key and does not echo it", () => {
  const secret = "sk-1234567890abcdef";
  assert.throws(() => parseConfig({ note: secret }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /literal API key/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.throws(
    () =>
      parseConfig({
        indexModel: { provider: "anthropic", model: secret, apiKeyEnv: "TYXTEST_INDEX_KEY" },
      }),
    /literal API key/,
  );
});

test("config allows env var names and disables the literal-key guard", () => {
  const secret = "sk-1234567890abcdef";
  const config = parseConfig({
    guards: { literalKeyCheck: false },
    indexModel: { provider: "anthropic", model: secret, apiKeyEnv: "TYXTEST_INDEX_KEY" },
  });
  assert.equal(config.indexModel?.model, secret);
  assert.doesNotThrow(() =>
    parseConfig({
      indexModel: { provider: "anthropic", model: "claude", apiKeyEnv: "ANTHROPIC_API_KEY" },
      runnerModel: { provider: "openai", model: "gpt", apiKeyEnv: "OPENAI_API_KEY" },
    }),
  );
});

test("config rejects invalid enums and non-integers", () => {
  assert.throws(() => parseConfig({ entryMode: "guess" }), /entryMode/);
  assert.throws(() => parseConfig({ reruns: 1.5 }), /reruns/);
  assert.throws(() => parseConfig({ closureDepth: -1 }), /closureDepth/);
  assert.throws(() => parseConfig({ verdictRule: "majority" }), /verdictRule/);
});

test("default API key env vars", () => {
  assert.equal(defaultApiKeyEnv("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(defaultApiKeyEnv("OpenAI"), "OPENAI_API_KEY");
  assert.equal(defaultApiKeyEnv("ollama"), undefined);
});

test("loadConfig reads a file and rejects a stored key", () => {
  const cwd = tempDir("tyxtest-config-");
  const file = path.join(cwd, "tyxtest", "tyxtest.config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      indexModel: { provider: "ollama", model: "llama" },
      runnerModel: { provider: "ollama", model: "llama" },
    }),
  );
  assert.equal(loadConfig(cwd).entryMode, "ask-plain");
  fs.writeFileSync(file, JSON.stringify({ token: "sk-abcdef1234567890" }));
  assert.throws(() => loadConfig(cwd), /literal API key/);
});
