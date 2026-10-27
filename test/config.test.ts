import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultApiKeyEnv, loadConfig, parseConfig } from "../src/config/config.js";
import { tempDir } from "./helpers.js";

test("config defaults", () => {
  const config = parseConfig({});
  assert.deepEqual(config.markdown, { testDiscovery: { mode: "headings", headingLevel: 2, prefix: null } });
  assert.equal(config.nonInteractive, "fail");
  assert.equal(config.reruns, 2);
  assert.equal(config.verdictRule, "worst");
  assert.equal(config.unsureBlocks, false);
  assert.equal(config.showCached, false);
  assert.equal(config.escalate, true);
  assert.equal(config.escalateModel, undefined);
  assert.equal(config.fallback, true);
  assert.deepEqual(config.thresholds, { pass: 0.9, fail: 0.1 });
  assert.equal(config.ignoreUnchanged, false);
  assert.equal(config.baseRef, "origin/main");
  assert.equal(config.triage, false);
  assert.equal(config.relocateCheck, true);
  assert.equal(config.maxQuestions, 5);
  assert.equal(config.chunkMaxTokens, 4000);
  assert.equal(config.concurrency, 8);
  assert.deepEqual(config.guards, { literalKeyCheck: true, gitignoreEnv: true });
  assert.equal(config.indexModel, undefined);
  assert.equal(config.runnerModel, undefined);
});

test("config keeps explicit values and fills the other guard", () => {
  const config = parseConfig({
    nonInteractive: "search",
    reruns: 0,
    unsureBlocks: true,
    entryMode: "required",
    closureDepth: 0,
    guards: { literalKeyCheck: false },
    indexModel: { provider: "anthropic", model: "claude", apiKeyEnv: "TYXTEST_INDEX_KEY" },
    runnerModel: { provider: "openai", model: "gpt" },
  });
  assert.equal(config.nonInteractive, "search");
  assert.equal(config.reruns, 0);
  assert.equal(config.unsureBlocks, true);
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

test("config ignores removed entry and closure settings and rejects invalid active values", () => {
  assert.equal("entryMode" in parseConfig({ entryMode: "guess" }), false);
  assert.equal("closureDepth" in parseConfig({ closureDepth: -1 }), false);
  assert.throws(() => parseConfig({ reruns: 1.5 }), /reruns/);
  assert.equal(parseConfig({ verdictRule: "majority" }).verdictRule, "majority");
  assert.equal(parseConfig({ verdictRule: "best" }).verdictRule, "best");
  assert.throws(() => parseConfig({ verdictRule: "random" }), /verdictRule/);
});

test("Markdown config validates explicit bullet mode and heading depth", () => {
  const expected = { testDiscovery: { mode: "bullets", headingLevel: 4, prefix: null } };
  assert.deepEqual(parseConfig({ markdown: expected }).markdown, expected);
  assert.deepEqual(parseConfig({ markdown: { tests: "bullets", testHeadingLevel: 4 } }).markdown, expected);
  assert.throws(() => parseConfig({ markdown: { testDiscovery: { mode: "automatic" } } }), /testDiscovery.mode/);
  assert.throws(() => parseConfig({ markdown: { testDiscovery: { headingLevel: 1 } } }), /between 2 and 6/);
  assert.throws(() => parseConfig({ markdown: { testDiscovery: null } }), /testDiscovery must be an object/);
  assert.throws(() => parseConfig({ markdown: { tests: "bullets", testDiscovery: {} } }), /cannot mix/);
  for (const prefix of ["", "  ", "one\ntwo", 4]) assert.throws(() => parseConfig({ markdown: { testDiscovery: { prefix } } }), /prefix/);
  assert.equal(parseConfig({ markdown: { testDiscovery: { prefix: "Claim  " } } }).markdown.testDiscovery.prefix, "Claim  ");
});

test("default API key env vars", () => {
  assert.equal(defaultApiKeyEnv("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(defaultApiKeyEnv("OpenAI"), "OPENAI_API_KEY");
  assert.equal(defaultApiKeyEnv("ollama"), undefined);
  assert.equal(defaultApiKeyEnv("typesafe"), "TYPESAFE_API_KEY");
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
  assert.equal(loadConfig(cwd).nonInteractive, "fail");
  fs.writeFileSync(file, JSON.stringify({ token: "sk-abcdef1234567890" }));
  assert.throws(() => loadConfig(cwd), /literal API key/);
});
