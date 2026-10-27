import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { chunkClosure, chunkSource, estimateTokens, evidenceForChunks, evidenceIdentity, indexableSymbols, selectChunks } from "../src/closure/chunk.js";
import { collectIndexedEvidence } from "../src/closure/indexed-evidence.js";
import { indexCommand } from "../src/commands/index-command.js";
import { parseConfig } from "../src/config/config.js";
import { readIndex } from "../src/surface/index-file.js";
import { testIdFor } from "../src/surface/surface.js";
import { scriptedPrompter, tempDir } from "./helpers.js";

test("mixed modules retain route registration, named helpers, and anonymous default functions", () => {
  const source = `import app from "./app.js";
export function helper() { return true; }
app.post("/checkout", helper);
export default function() { return "screen"; }
app.listen(3000);
`;
  const chunks = chunkSource("src/app.ts", source);
  assert.match(chunks.find((chunk) => chunk.name === "helper")?.text ?? "", /function helper/);
  const anonymous = chunks.find((chunk) => chunk.name === "default");
  assert.equal(anonymous?.line, 4);
  assert.match(anonymous?.text ?? "", /export default function\(\)/);
  const module = chunks.find((chunk) => chunk.name === "app.ts");
  assert.equal(module?.text, source);
  assert.equal(module?.line, 1);
  assert.equal(module?.endLine, 6);
  assert.equal(selectChunks(chunks, [{ path: "src/app.ts", symbol: "app.ts" }])[0], module);
});

test("anonymous default classes remain class evidence alongside named declarations", () => {
  const source = `function helper() { return 1; }
export default class {
  read() { return helper(); }
  write() { return 2; }
}`;
  for (const cap of [4000, 1]) {
    const chunks = chunkSource("src/store.ts", source, cap);
    const defaults = selectChunks(chunks, [{ path: "src/store.ts", symbol: "default" }]);
    assert.ok(defaults.length > 0);
    assert.ok(defaults.every((chunk) => chunk.kind === "class" && chunk.symbol === "default"));
    assert.ok(defaults.every((chunk) => chunk.text === source.slice(source.indexOf("export default"))));
    if (cap === 1) assert.deepEqual(defaults.map((chunk) => chunk.name), ["read", "write"]);
  }
});

test("mixed variable declarators retain every initializer, binding, export, and evaluation order", () => {
  const source = `export const first = initialize(), helper = () => first, second = update(), { value } = load();`;
  for (const cap of [4000, 1]) {
    const chunks = chunkSource("src/mixed.ts", source, cap);
    assert.deepEqual(chunks.map((chunk) => chunk.name), ["first", "helper", "second", "{ value }"]);
    assert.ok(chunks.every((chunk) => chunk.text === source));
    assert.equal(chunks.find((chunk) => chunk.name === "first")?.kind, "constant");
    assert.equal(chunks.find((chunk) => chunk.name === "helper")?.kind, "function");
  }
  const multiline = `const first = initialize(),\n  helper = () => first,\n  second = update();`;
  const chunks = chunkSource("src/mixed.ts", multiline, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.line), [1, 2, 3]);
  assert.ok(chunks.every((chunk) => chunk.text === multiline));
});

test("module context retains top-level guards and execution ordering around declarations", () => {
  const source = `initialize();
if (!authorized()) throw new Error("unauthorized");
function handler() { return serve(); }
for (const route of routes) app.post(route, handler);
start();`;
  const chunks = chunkSource("src/routes.ts", source, 1);
  assert.equal(chunks.find((chunk) => chunk.name === "routes.ts")?.text, source);
  assert.ok(chunks.some((chunk) => chunk.symbol === "handler"));
});

test("oversized focus chunks retain authorization, signatures, and early-return ordering", () => {
  const source = `export async function checkout(user: User, cart: Cart): Promise<Result> {
  if (!user.admin) return deny();
  const order = await prepare(cart);
  if (user.authorized) {
    charge(order);
    audit(user);
  } else {
    return deny();
  }
  return complete(order);
}`;
  const chunks = chunkSource("src/checkout.ts", source, 1);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.symbol === "checkout"));
  assert.ok(chunks.every((chunk) => chunk.text === source));
  assert.ok(chunks.every((chunk) => estimateTokens(chunk.text) > 1));
  assert.deepEqual(chunks.map((chunk) => chunk.line), [2, 3, 4, 10]);
  assert.deepEqual(chunks.map((chunk) => chunk.endLine), [2, 3, 9, 10]);
});

test("nested loop, try, switch, and finally context is never emitted as bare actions", () => {
  const source = `function process(items: Item[]) {
  if (!ready()) return;
  for (const item of items) {
    try {
      switch (item.kind) {
        case "allowed": save(item); break;
        default: continue;
      }
    } catch (error) {
      report(error);
    } finally {
      cleanup(item);
    }
  }
  finish();
}`;
  const chunks = chunkSource("src/process.ts", source, 1);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text === source));
});

test("single oversized guarded blocks and arrow signatures are retained intact", () => {
  const sources = [
    `function save(user: User) { if (user.admin) { write(); audit(); } else { deny(); } }`,
    `export const save = async (user: User): Promise<void> => { if (!user.admin) return; write(); audit(); };`,
    `export default (user: User) => { if (!user.admin) return; write(); audit(); };`,
  ];
  for (const source of sources) {
    const chunks = chunkSource("src/save.ts", source, 1);
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => chunk.text === source));
  }
});

test("large constants, referenced constants, and fallback source are not truncated to the cap", () => {
  const constant = `export const PAYLOAD = "${"x".repeat(2000)}";`;
  const source = `${constant}\nexport function read() { check(); return PAYLOAD; }`;
  const chunks = chunkSource("src/data.ts", source, 1);
  assert.equal(chunks.find((chunk) => chunk.name === "PAYLOAD")?.text, constant);
  const read = chunks.filter((chunk) => chunk.symbol === "read");
  assert.ok(read.length > 1);
  assert.ok(read.every((chunk) => chunk.text.includes(constant)));
  const fallback = `register("${"r".repeat(2000)}");\nstart();`;
  assert.equal(chunkSource("src/effects.ts", fallback, 1)[0]?.text, fallback);
  assert.equal(chunkSource("src/empty.ts", "", 1)[0]?.text, "");
});

test("contextual focus citations retain stable names, hashes, and actual file locations", () => {
  const source = `export class Store {
  read() { if (!allowed()) return; return load(); }
  write() { save(); }
}`;
  const chunks = chunkSource("src/store.ts", source, 1);
  const shifted = chunkSource("src/store.ts", `\n\n${source}`, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.name), ["read", "write"]);
  assert.deepEqual(chunks.map((chunk) => chunk.line), [2, 3]);
  for (const [index, chunk] of chunks.entries()) {
    const next = shifted[index]!;
    assert.equal(next.line, chunk.line + 2);
    assert.equal(next.text, chunk.text);
    assert.deepEqual(evidenceIdentity(chunk.path, chunk.name, chunk.text), evidenceIdentity(next.path, next.name, next.text));
  }
  const citations = evidenceForChunks(chunks, [1, 0]);
  assert.equal(citations[0]?.file, "src/store.ts");
  assert.equal(citations[0]?.line, 2);
  assert.equal(citations[0]?.symbol, "read");
});

test("index evidence can address module execution and anonymous defaults", async () => {
  const cwd = tempDir("tyxtest-module-evidence-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "routes"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/routes.ts"), 'export function handler() { return "ok"; }\napp.post("/checkout", handler);\nexport default function() { return "screen"; }\n');
  fs.writeFileSync(path.join(cwd, "tyxtest/routes/surface.md"), "---\nsurface: Routes\nentry: src/routes.ts\n---\n- [registered] Checkout is registered\n- [screen] A default screen exists\n");
  await indexCommand({
    cwd,
    config: parseConfig({ markdown: { tests: "bullets" } }),
    prompter: scriptedPrompter([]),
    interactive: true,
    env: {},
    model: {
      async complete(request) {
        assert.match(request.system, /Use default for anonymous default/);
        assert.match(request.system, /source filename.*file-context chunk/);
        return JSON.stringify({ tests: [
          { testId: "registered", chunks: [{ path: "src/routes.ts", symbol: "routes.ts" }], wholeFileReason: "The top-level route registration and execution ordering are the behavior under test." },
          { testId: "screen", chunks: [{ path: "src/routes.ts", symbol: "default" }] },
        ] });
      },
    },
  });
  const index = readIndex(path.join(cwd, "tyxtest/routes/.index.json"));
  for (const indexed of index.tests ?? []) {
    const chunks = chunkClosure(cwd, indexed.closure ?? index.closure ?? []);
    const selected = selectChunks(chunks, indexed.chunks);
    assert.ok(selected.length > 0);
    assert.match(selected[0]!.text, indexed.testId === "registered" ? /app.post\("\/checkout"/ : /export default function/);
  }
});

test("index maps a no-entry child surface to cross-folder chunks and parent wiring", async () => {
  const cwd = tempDir("tyxtest-cross-file-index-");
  fs.mkdirSync(path.join(cwd, "src", "parent"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "child"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest", "parent", "child"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "child", "logic.ts"), "export function act() { return true; }\n");
  fs.writeFileSync(path.join(cwd, "src", "parent", "wiring.ts"), 'import { act } from "../child/logic"; export const wired = act(); register(wired);\n');
  fs.writeFileSync(path.join(cwd, "tyxtest", "parent", "surface.md"), "# Parent\nParent-level semantic claim.\n");
  fs.writeFileSync(path.join(cwd, "tyxtest", "parent", "child", "surface.md"), "# Child\n\n## The action is available\n");
  await indexCommand({
    cwd, config: parseConfig({}), prompter: scriptedPrompter([]), interactive: true, env: {},
    model: { async complete(request) {
      assert.match(request.prompt, /Parent-level semantic claim/);
      assert.match(request.prompt, /src\/child\/logic\.ts/);
      assert.doesNotMatch(request.prompt, /Entry:/);
      return JSON.stringify({ tests: [{ testId: testIdFor("The action is available"), chunks: [{ path: "src/child/logic.ts", symbol: "act" }], context: ["src/parent/wiring.ts"], wholeFileReason: "Top-level registration and initialization ordering in the wiring module establish that the action is available." }] });
    } },
  });
  const index = readIndex(path.join(cwd, "tyxtest", "parent", "child", ".index.json"));
  assert.equal(index.entry, undefined);
  assert.ok(index.tests?.[0]?.closure?.some((file) => file.path === "src/child/logic.ts"));
  assert.ok(index.tests?.[0]?.closure?.some((file) => file.path === "src/parent/wiring.ts"));
});

test("index declaration inventory matches runner selection for defaults, file-context and focus aliases", () => {
  const cwd = tempDir("tyxtest-symbol-inventory-");
  fs.mkdirSync(path.join(cwd, "src"));
  const file = "src/handler.ts";
  const text = "import { importedOnly } from './helper.js';\nexport const POLICY = 'strict';\nexport default class { read() { return importedOnly(); } write() { return POLICY; } }\nregister();\n";
  fs.writeFileSync(path.join(cwd, file), text);
  const inventory = indexableSymbols(file, text, 1);
  assert.deepEqual(new Set(inventory.map((item) => item.symbol)), new Set(["POLICY", "default", "read", "write", "handler.ts"]));
  assert.ok(!inventory.some((item) => item.symbol === "importedOnly"));
  assert.equal(inventory.find((item) => item.symbol === "handler.ts")?.fileContext, true);
  assert.equal(inventory.find((item) => item.symbol === "handler.ts")?.chars, text.length);
  assert.deepEqual(indexableSymbols("src/empty.ts", ""), []);
  for (const item of inventory) {
    const selected = collectIndexedEvidence({ cwd, chunks: [{ path: file, symbol: item.symbol }], maxTokens: 1 });
    assert.equal(selected.missing, false, item.symbol);
    assert.equal(selected.chunks[0]?.text.length, item.chars, item.symbol);
  }
});
