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
  assert.match(frames()[0] ?? "", /\[submit-exists\] There is a submit button {2}⠋/);
  assert.match(frames()[0] ?? "", /\[writes-results\] Run writes results {2}⠋/);

  const second = result("writes-results", "Run writes results", "unsure");
  progress.complete(second, 3200);
  const afterLater = frames().at(-1) ?? "";
  assert.match(afterLater, /\[submit-exists\] There is a submit button {2}⠋/);
  assert.match(afterLater, /\[writes-results\] Run writes results {2}\x1b\[33munsure\x1b\[0m {2}\x1b\[34m\[3\.2 s\]\x1b\[0m/);
  assert.ok(afterLater.indexOf("[submit-exists]") < afterLater.indexOf("[writes-results]"));

  const first = result("submit-exists", "There is a submit button", "fail");
  progress.complete(first, 193);
  progress.finish([first, second], { unsureBlocks: false, verbose: false });
  const finished = frames().at(-1) ?? "";
  assert.match(finished, /\[submit-exists\] There is a submit button {2}\x1b\[31mfail\x1b\[0m {2}\x1b\[34m\[193 ms\]\x1b\[0m/);
  assert.match(finished, /\[writes-results\] Run writes results {2}\x1b\[33munsure\x1b\[0m {2}\x1b\[34m\[3\.2 s\]\x1b\[0m/);
  assert.ok(finished.indexOf("[submit-exists]") < finished.indexOf("[writes-results]"));
  assert.match(finished, /0 pass, 1 fail, 1 unsure/);
  assert.doesNotMatch(finished, /⠋/);
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
