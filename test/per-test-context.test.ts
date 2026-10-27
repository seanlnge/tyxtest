import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectTestContext } from "../src/closure/closure.js";
import { runCommand } from "../src/commands/run.js";
import { parseConfig } from "../src/config/config.js";
import type { DecisionRequest, ModelClient } from "../src/config/types.js";
import { discoverSurfaces, surfaceContextFor } from "../src/surface/discover.js";
import { claimHashFor, writeIndex } from "../src/surface/index-file.js";
import { readTests } from "../src/surface/surface.js";
import { tempDir } from "./helpers.js";

function fixture(flow = false) {
  const cwd = tempDir("tyxtest-per-test-context-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tyxtest/checkout/payment"), { recursive: true });
  const parent = path.join(cwd, "tyxtest/checkout/surface.md");
  fs.writeFileSync(parent, "# Checkout\n\nThe customer's personal purchase, not an admin action.\n");
  const markdown = "# Payment\n\nThe customer's payment.\n\n## The payment form is connected\n\nOnly for signed-in customers.\n\n## Invalid amounts are rejected\n";
  fs.writeFileSync(path.join(cwd, "tyxtest/checkout/payment/surface.md"), markdown);
  fs.writeFileSync(path.join(cwd, "src/ui.ts"), "export function form() { return 'PAYMENT_FORM'; }\n");
  fs.writeFileSync(path.join(cwd, "src/api.ts"), "export function validate() { return 'AMOUNT_REJECTED'; }\n");
  if (flow) fs.writeFileSync(path.join(cwd, "src/caller.ts"), "import { form } from './ui.js'; export function pay() { return form(); }\n");
  const cases = readTests(markdown);
  const surfaces = discoverSurfaces(cwd);
  const surface = surfaces.find((item) => item.relativeDir === "checkout/payment")!;
  const refs = [{ path: "src/ui.ts", symbol: "form" }, { path: "src/api.ts", symbol: "validate" }];
  writeIndex(path.join(cwd, "tyxtest/checkout/payment/.index.json"), {
    files: [], notes: [], contextHash: surfaceContextFor(surface, surfaces).hash,
    tests: cases.map((claim, index) => {
      const chunks = [refs[index]!];
      const snapshot = collectTestContext({ cwd, chunks });
      return { testId: claim.id, claimHash: claimHashFor(claim.text, claim.notes),
        chunks: flow && index === 0 ? [] : chunks, closure: snapshot.files, closureHash: snapshot.closureHash };
    }),
    flows: flow ? [{ testId: cases[0]!.id, steps: [{ id: "show", text: "Render the payment form", chunks: [refs[0]!], context: ["src/caller.ts"] }] }] : [],
  });
  const config = parseConfig({
    indexModel: { provider: "ollama", model: "index" },
    runnerModel: { kind: "decision", provider: "typesafe", model: "jev" },
    reruns: 0, escalate: false, fallback: false, relocateCheck: false, ignoreUnchanged: false,
  });
  return { cwd, parent, cases, config };
}

test("entry-free child tests own separate source maps and require no parent index", async () => {
  const { cwd, parent, config } = fixture();
  const requests: DecisionRequest[] = [];
  const model: ModelClient = {
    async complete() { throw new Error("Unexpected LLM call"); },
    async decide(request) { requests.push(request); return { probabilities: [0.99, 0.01] }; },
  };
  const indexBefore = fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8");
  const run = () => runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
  const first = await run();
  assert.equal(first.results.length, 2);
  assert.ok(first.results.every((result) => result.verdict === "pass"));
  const verdicts = requests.filter((request) => request.purpose === "verdict");
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((request) => request.state.includes("personal purchase, not an admin action")));
  assert.ok(verdicts.every((request) => request.state.includes("checkout/payment/")));
  assert.match(verdicts[0]!.state, /PAYMENT_FORM/);
  assert.doesNotMatch(verdicts[0]!.state, /AMOUNT_REJECTED/);
  assert.match(verdicts[1]!.state, /AMOUNT_REJECTED/);
  assert.doesNotMatch(verdicts[1]!.state, /PAYMENT_FORM/);
  assert.ok((await run()).results.every((result) => result.cached));
  const callsBeforeContextEdit = requests.length;
  fs.appendFileSync(parent, "\nThis now describes an administrator purchase.\n");
  const stale = await run();
  assert.ok(stale.results.every((result) => result.verdict === "unsure" && !result.cached));
  assert.equal(requests.length, callsBeforeContextEdit);
  assert.equal(fs.readFileSync(path.join(cwd, "tyxtest/.index.json"), "utf8"), indexBefore);
});

test("a flow retains disconnected caller context while an unrelated test stays cached", async () => {
  const { cwd, cases, config } = fixture(true);
  const requests: DecisionRequest[] = [];
  const model: ModelClient = {
    async complete() { throw new Error("Unexpected LLM call"); },
    async decide(request) {
      requests.push(request);
      const failed = request.purpose === "verdict" && request.state.includes("DISCONNECTED");
      return { probabilities: failed ? [0.01, 0.99] : [0.99, 0.01] };
    },
  };
  const run = () => runCommand({ cwd, config, model, env: {}, stdout: () => {}, stderr: () => {} });
  assert.ok((await run()).results.every((result) => result.verdict === "pass"));
  assert.ok(requests.some((request) => request.purpose === "verdict" && request.state.includes("return form()")));
  fs.writeFileSync(path.join(cwd, "src/caller.ts"), "export function pay() { return 'DISCONNECTED'; }\n");
  requests.length = 0;
  const changed = await run();
  assert.equal(changed.results.find((result) => result.id === cases[0]!.id)?.verdict, "fail");
  assert.equal(changed.results.find((result) => result.id === cases[1]!.id)?.cached, true);
  const verdict = requests.find((request) => request.purpose === "verdict")!;
  assert.match(verdict.state, /DISCONNECTED/);
  assert.match(verdict.state, /Only for signed-in customers/);
  assert.match(verdict.state, /personal purchase, not an admin action/);
});
