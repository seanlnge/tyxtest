import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { INDEX_MERGE_RULE, PENDING_GITIGNORE } from "../src/git/git-files.js";
import { setupCommand } from "../src/commands/setup.js";
import { scriptedPrompter, tempDir } from "./helpers.js";

const ANSWERS = [
  "anthropic",
  "claude-strong",
  "TYXTEST_INDEX_KEY",
  "decision",
  "typesafe",
  "jev",
  "TYXTEST_RUN_KEY",
  "",
  "ask-entry",
  "no",
];

test("setup writes .gitignore and .gitattributes merge=ours for .index.json", async () => {
  const cwd = tempDir("tyxtest-setup-");
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  const prompter = scriptedPrompter(ANSWERS);
  await setupCommand({
    cwd,
    prompter,
    env: { TYXTEST_INDEX_KEY: "present-index-key", TYXTEST_RUN_KEY: "" },
  });

  const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
  assert.ok(gitignore.split(/\r?\n/).includes("node_modules/"));
  assert.ok(gitignore.split(/\r?\n/).includes(".env"));
  assert.ok(gitignore.split(/\r?\n/).includes(PENDING_GITIGNORE));
  const attributes = fs.readFileSync(path.join(cwd, ".gitattributes"), "utf8");
  assert.match(attributes, /\.index\.json/);
  assert.match(attributes, /merge=ours/);
  assert.ok(attributes.includes(INDEX_MERGE_RULE));
  assert.equal(
    execFileSync("git", ["config", "--local", "--get", "merge.ours.driver"], { cwd, encoding: "utf8" }).trim(),
    "true",
  );

  const configText = fs.readFileSync(path.join(cwd, "tyxtest", "tyxtest.config.json"), "utf8");
  assert.equal(configText.includes("present-index-key"), false);
  assert.doesNotMatch(configText, /sk-[A-Za-z0-9_-]{8,}/);
  const config = JSON.parse(configText) as {
    entryMode: string;
    indexModel: { provider: string; apiKeyEnv: string; kind?: string };
    runnerModel: { kind: string; provider: string; model: string; apiKeyEnv: string };
    escalateModel: unknown;
    fallback: boolean;
    ignoreUnchanged: boolean;
    relocateCheck: boolean;
    maxQuestions: number;
    chunkMaxTokens: number;
    concurrency: number;
    guards: { gitignoreEnv: boolean };
  };
  assert.equal(config.entryMode, "ask-entry");
  assert.equal(config.indexModel.kind, undefined);
  assert.equal(config.indexModel.provider, "anthropic");
  assert.equal(config.indexModel.apiKeyEnv, "TYXTEST_INDEX_KEY");
  assert.equal(config.runnerModel.kind, "decision");
  assert.equal(config.runnerModel.provider, "typesafe");
  assert.equal(config.runnerModel.model, "jev");
  assert.equal(config.runnerModel.apiKeyEnv, "TYXTEST_RUN_KEY");
  assert.equal(config.escalateModel, null);
  assert.equal(config.fallback, true);
  assert.equal(config.ignoreUnchanged, false);
  assert.equal(config.relocateCheck, true);
  assert.equal(config.maxQuestions, 5);
  assert.equal(config.chunkMaxTokens, 4000);
  assert.equal(config.concurrency, 8);
  assert.equal(config.guards.gitignoreEnv, true);
  assert.ok(prompter.warnings.some((warning) => warning.includes("TYXTEST_RUN_KEY")));
  assert.equal(
    prompter.warnings.some((warning) => warning.includes("TYXTEST_INDEX_KEY")),
    false,
  );

  await setupCommand({
    cwd,
    prompter: scriptedPrompter(ANSWERS),
    env: { TYXTEST_INDEX_KEY: "present-index-key", TYXTEST_RUN_KEY: "present-run-key" },
  });
  const gitignoreAgain = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
  assert.equal(gitignoreAgain.split(/\r?\n/).filter((line) => line.trim() === ".env").length, 1);
  const attributesAgain = fs.readFileSync(path.join(cwd, ".gitattributes"), "utf8");
  assert.equal(attributesAgain.split(/\r?\n/).filter((line) => line.includes("merge=ours")).length, 1);
});

test("setup prompts for a separate escalation key environment variable", async () => {
  const cwd = tempDir("tyxtest-setup-escalation-");
  const prompter = scriptedPrompter([
    "anthropic", "claude-index", "INDEX_KEY",
    "decision", "typesafe", "jev", "RUN_KEY",
    "openai", "gpt-escalate", "ESCALATE_KEY",
    "ask-plain", "no",
  ]);
  await setupCommand({ cwd, prompter, env: { INDEX_KEY: "i", RUN_KEY: "r", ESCALATE_KEY: "e" } });
  const config = JSON.parse(fs.readFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), "utf8")) as {
    escalateModel: { apiKeyEnv: string };
  };
  assert.equal(config.escalateModel.apiKeyEnv, "ESCALATE_KEY");
});
