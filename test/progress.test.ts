import assert from "node:assert/strict";
import test from "node:test";

import type { ReportedTest } from "../src/verdict/reporter.js";
import { createRunProgress, formatDuration } from "../src/verdict/progress.js";

test("duration uses milliseconds under one second and one decimal second after", () => {
  assert.equal(formatDuration(193), "193 ms");
  assert.equal(formatDuration(193.4), "193 ms");
  assert.equal(formatDuration(3200), "3.2 s");
  assert.equal(formatDuration(999.6), "1.0 s");
});

test("progress lists tests in order and replaces each spinner where it finishes", () => {
  const chunks: string[] = [];
  const progress = createRunProgress(
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
      columns: 120,
    },
    [
      { surface: "login", id: "submit-exists", text: "There is a submit button" },
      { surface: "login", id: "writes-results", text: "Run writes results" },
    ],
    { color: true, timer: false },
  );

  const frames = () => chunks.join("").split(/\x1b\[\d+A/);
  assert.match(frames()[0] ?? "", /- There is a submit button {2}⠋/);
  assert.match(frames()[0] ?? "", /- Run writes results {2}⠋/);

  const second = result("writes-results", "Run writes results", "unsure");
  progress.complete(second, 3200);
  const afterLater = frames().at(-1) ?? "";
  assert.match(afterLater, /- There is a submit button {2}⠋/);
  assert.match(afterLater, /- Run writes results {2}\x1b\[33munsure\x1b\[0m {2}\x1b\[34m\[3\.2 s\]\x1b\[0m/);
  assert.ok(afterLater.indexOf("There is a submit button") < afterLater.indexOf("Run writes results"));

  const first = result("submit-exists", "There is a submit button", "fail");
  progress.complete(first, 193);
  progress.finish([first, second], { unsureBlocks: false, verbose: false });
  const finished = frames().at(-1) ?? "";
  assert.match(finished, /- There is a submit button {2}\x1b\[31mfail\x1b\[0m {2}\x1b\[34m\[193 ms\]\x1b\[0m/);
  assert.match(finished, /- Run writes results {2}\x1b\[33munsure\x1b\[0m {2}\x1b\[34m\[3\.2 s\]\x1b\[0m/);
  assert.ok(finished.indexOf("There is a submit button") < finished.indexOf("Run writes results"));
  assert.match(finished.replace(/\x1b\[[0-9;]*m/g, ""), /0 pass, 1 fail, 1 unsure/);
  assert.match(finished.replace(/\x1b\[[0-9;]*m/g, ""), /0 pass, 1 fail, 1 unsure/);
  assert.doesNotMatch(finished, /⠋/);
});

test("summary reports elapsed time and provider-reported usage", () => {
  const chunks: string[] = [];
  const passed = result("claim", "Claim", "pass");
  const progress = createRunProgress({ write: (chunk) => chunks.push(chunk) }, [{ surface: "shop/cart", surfaceTitle: "Shop/Cart", id: "claim", text: "Claim" }], { color: false, timer: false });
  progress.complete(passed, 12);
  progress.finish([passed], { unsureBlocks: false, verbose: false, elapsedMs: 1500, runnerUsage: { inputTokens: 11, outputTokens: 2, available: true }, fallbackUsage: { inputTokens: 4, outputTokens: 1, available: true } });
  const output = chunks.join("");
  assert.match(output, /Shop\/Cart/);
  assert.match(output, /\[1\.5 s\]/);
  assert.match(output, /runner tokens: 11 input, 2 output, 13 total/);
  assert.match(output, /fallback-model tokens: 4 input, 1 output, 5 total/);
});

test("live progress renders nested surface titles as a hierarchy", () => {
  const chunks: string[] = [];
  const results = [result("root", "Root claim", "pass", "index"), result("child", "Child claim", "pass", "index/apply-pending")];
  const progress = createRunProgress({ write: (chunk) => chunks.push(chunk) }, [
    { surface: "index", surfaceTitle: "Index\0", id: "root", text: "Root claim" },
    { surface: "index/apply-pending", surfaceTitle: "Index\0Apply pending suggestions", id: "child", text: "Child claim" },
  ], { color: false, timer: false });
  progress.complete(results[0]!, 5);
  progress.complete(results[1]!, 8);
  progress.finish(results, { unsureBlocks: false, verbose: false, elapsedMs: 13 });
  assert.match(chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), /Index\/\n  - Root claim.*\n  Apply pending suggestions\/\n    - Child claim/s);
});

test("a pass is green", () => {
  const chunks: string[] = [];
  const progress = createRunProgress(
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
      columns: 100,
    },
    [{ surface: "run", id: "static-claim-checks", text: "Checks claims" }],
    { color: true, timer: false },
  );
  const passed = result("static-claim-checks", "Checks claims", "pass", "run");
  progress.complete(passed, 840);
  progress.finish([passed], { unsureBlocks: false, verbose: false });
  assert.match(chunks.join(""), /\x1b\[32mpass\x1b\[0m {2}\x1b\[34m\[840 ms\]\x1b\[0m/);
});

test("a line that does not fit ends with a text ellipsis", () => {
  const chunks: string[] = [];
  const progress = createRunProgress(
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
      columns: 40,
    },
    [{ surface: "setup", id: "configures-git", text: "Setup adds .env, .tyxtest/, and tyxtest/.pending.json to .gitignore and configures index merging" }],
    { color: false, timer: false },
  );
  progress.dispose();
  const text = chunks.join("");
  assert.match(text, /\u2026/);
  assert.doesNotMatch(text, /\.\.\./);
});

function result(id: string, text: string, verdict: ReportedTest["verdict"], surface = "login"): ReportedTest {
  return {
    surface,
    id,
    text,
    verdict,
    cached: false,
    runs: [],
    evidence: [],
    explanation: "",
  };
}
