import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ensureIndexMergeAttributes, PENDING_GITIGNORE } from "../src/git/git-files.js";
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
  "no",
];

test("setup writes .gitignore and removes unsafe index merge=ours attributes", async () => {
  const cwd = tempDir("tyxtest-setup-");
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.generated linguist-generated=true\ntyxtest/**/.index.json text merge=ours eol=lf diff\n");
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
  assert.doesNotMatch(attributes, /merge=ours/);
  assert.match(attributes, /tyxtest\/\*\*\/\.index\.json text eol=lf diff/);
  assert.match(attributes, /\*\.generated linguist-generated=true/);
  const actualGitAttributes = execFileSync("git", ["check-attr", "merge", "text", "eol", "diff", "--", "tyxtest/login/.index.json"], { cwd, encoding: "utf8" });
  assert.match(actualGitAttributes, /merge: unspecified/);
  assert.match(actualGitAttributes, /text: set/);
  assert.match(actualGitAttributes, /eol: lf/);
  assert.match(actualGitAttributes, /diff: set/);

  const configText = fs.readFileSync(path.join(cwd, "tyxtest", "tyxtest.config.json"), "utf8");
  assert.equal(configText.includes("present-index-key"), false);
  assert.doesNotMatch(configText, /sk-[A-Za-z0-9_-]{8,}/);
  const config = JSON.parse(configText) as {
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
    markdown: { testDiscovery: { mode: string; headingLevel: number; prefix: string | null } };
  };
  assert.equal("entryMode" in config, false);
  assert.equal("closureDepth" in config, false);
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
  assert.deepEqual(config.markdown, { testDiscovery: { mode: "headings", headingLevel: 2, prefix: null } });
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
  assert.equal(attributesAgain, attributes);
});

test("index merge cleanup removes exact merge=ours tokens in any attribute position", () => {
  const cwd = tempDir("tyxtest-attributes-order-");
  const file = path.join(cwd, ".gitattributes");
  for (const pattern of ["tyxtest/.index.json", "tyxtest/**/.index.json", '"tyxtest/.index.json"', '"tyxtest/**/.index.json"', "/tyxtest/.index.json", '  "/tyxtest/**/.index.json"']) {
    fs.writeFileSync(file, [
      `${pattern} merge=ours text eol=lf diff`,
      `${pattern} text merge=ours eol=lf diff`,
      `${pattern} text eol=lf diff merge=ours`,
      `${pattern}\ttext\tmerge=ours\teol=lf\tdiff\tmerge=ours`,
    ].join("\n") + "\n");
    ensureIndexMergeAttributes(cwd);
    assert.equal(fs.readFileSync(file, "utf8"), Array(4).fill(`${pattern} text eol=lf diff`).join("\n") + "\n", pattern);
  }
});

test("index merge cleanup preserves unrelated rules and lookalike values byte-for-byte when unchanged", () => {
  const cwd = tempDir("tyxtest-attributes-unrelated-");
  const file = path.join(cwd, ".gitattributes");
  const original = [
    "*.generated\tlinguist-generated=true  ",
    "other/*.json merge=ours",
    "other/tyxtest/**/.index.json merge=ours",
    "tyxtest/.index.json.backup merge=ours",
    "tyxtest/*.json merge=ours",
    "tyxtest/.index.json text merge=ours-extra",
    '"tyxtest/**/.index.json" merge=ours.extra eol=lf',
    "tyxtest/**/.index.json merge=ours=another-value",
    'tyxtest/.index.json custom="merge=ours"',
    "# tyxtest/.index.json merge=ours",
  ].join("\r\n") + "\r\n";
  fs.writeFileSync(file, original);
  ensureIndexMergeAttributes(cwd);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("index merge cleanup deletes emptied rules and the file when only obsolete rules and comments remain", () => {
  const cwd = tempDir("tyxtest-attributes-empty-");
  const file = path.join(cwd, ".gitattributes");
  for (const original of [
    "# tyxtest index files merge like a lockfile\r\ntyxtest/.index.json merge=ours\r\n",
    '"tyxtest/**/.index.json" merge=ours\n',
    " \t\n# tyxtest index files merge like a lockfile\ntyxtest/**/.index.json merge=ours\n",
  ]) {
    fs.writeFileSync(file, original);
    ensureIndexMergeAttributes(cwd);
    assert.equal(fs.existsSync(file), false);
    ensureIndexMergeAttributes(cwd);
    assert.equal(fs.existsSync(file), false);
  }
});

test("modified index rules retain other attributes and unrelated line content with existing LF rewrite behavior", () => {
  const cwd = tempDir("tyxtest-attributes-retain-");
  const file = path.join(cwd, ".gitattributes");
  fs.writeFileSync(file, [
    "# Keep this comment  ",
    "*.generated\tlinguist-generated=true  ",
    "tyxtest/.index.json text merge=ours-extra merge=ours eol=lf diff",
    "tyxtest/**/.index.json merge=ours",
    "other.json merge=ours",
  ].join("\r\n") + "\r\n");
  ensureIndexMergeAttributes(cwd);
  const expected = [
    "# Keep this comment  ",
    "*.generated\tlinguist-generated=true  ",
    "tyxtest/.index.json text merge=ours-extra eol=lf diff",
    "other.json merge=ours",
  ].join("\n") + "\n";
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  ensureIndexMergeAttributes(cwd);
  assert.equal(fs.readFileSync(file, "utf8"), expected);
});

test("setup prompts for a separate escalation key environment variable", async () => {
  const cwd = tempDir("tyxtest-setup-escalation-");
  const prompter = scriptedPrompter([
    "anthropic", "claude-index", "INDEX_KEY",
    "decision", "typesafe", "jev", "RUN_KEY",
    "openai", "gpt-escalate", "ESCALATE_KEY",
    "no",
  ]);
  await setupCommand({ cwd, prompter, env: { INDEX_KEY: "i", RUN_KEY: "r", ESCALATE_KEY: "e" } });
  const config = JSON.parse(fs.readFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), "utf8")) as {
    escalateModel: { apiKeyEnv: string };
  };
  assert.equal(config.escalateModel.apiKeyEnv, "ESCALATE_KEY");
});
