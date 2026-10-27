import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { indexableSymbols } from "../src/closure/chunk.js";
import { createImportedChunkResolver } from "../src/closure/symbol-reference.js";
import { tempDir } from "./helpers.js";

function resolverFixture(files: Record<string, string>, compilerOptions?: Record<string, unknown>) {
  const cwd = tempDir("tyxtest-import-provenance-");
  const texts = new Map(Object.entries(files));
  for (const [file, text] of texts) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  if (compilerOptions) fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions }));
  const inventory = new Map([...texts].map(([file, text]) => [file, indexableSymbols(file, text)]));
  const resolve = createImportedChunkResolver(cwd, texts, inventory);
  return (file: string, symbol: string) => resolve({ path: file, symbol });
}

test("selected direct imports resolve to exact defining declarations despite duplicate names elsewhere", () => {
  const resolve = resolverFixture({
    "src/commands/run.ts": "import { listSourceFiles } from '../closure/repo-files.js';\nimport { recordSuggestion } from '../surface/pending.js';\nexport function runCommand() { return listSourceFiles(); }",
    "src/closure/repo-files.ts": "export function listSourceFiles() { return []; }",
    "src/surface/pending.ts": "export function recordSuggestion() { return 'saved'; }",
    "src/unrelated.ts": "export function listSourceFiles() { return 'decoy'; }",
  }, { module: "Node16", moduleResolution: "Node16", target: "ES2022" });
  assert.deepEqual(resolve("src/commands/run.ts", "listSourceFiles"), { path: "src/closure/repo-files.ts", symbol: "listSourceFiles" });
  assert.deepEqual(resolve("src/commands/run.ts", "recordSuggestion"), { path: "src/surface/pending.ts", symbol: "recordSuggestion" });
  assert.deepEqual(resolve("src/commands/run.ts", "runCommand"), { path: "src/commands/run.ts", symbol: "runCommand" });
  assert.equal(resolve("src/unrelated.ts", "recordSuggestion"), null);
  assert.equal(resolve("src/nonexistent.ts", "recordSuggestion"), null);
});

test("import aliases, named/local/barrel re-exports and default aliases preserve concrete source identity", () => {
  const resolve = resolverFixture({
    "src/caller.ts": "import { publicName as localName, default as namedDefault } from './barrel.js';\nimport DefaultAlias from './named-default.js';\nexport function caller() { return localName(); }",
    "src/implementation.ts": "export function actualName() { return 'real'; }\nexport default function() { return 'anonymous'; }",
    "src/barrel.ts": "export { renamed as publicName } from './middle.js';\nexport { default } from './implementation.js';",
    "src/middle.ts": "import { actualName as local } from './implementation.js';\nexport { local as renamed };",
    "src/named-default.ts": "function actualDefault() { return 'named'; }\nexport default actualDefault;",
  });
  assert.deepEqual(resolve("src/caller.ts", "localName"), { path: "src/implementation.ts", symbol: "actualName" });
  assert.deepEqual(resolve("src/caller.ts", "namedDefault"), { path: "src/implementation.ts", symbol: "default" });
  assert.deepEqual(resolve("src/caller.ts", "DefaultAlias"), { path: "src/named-default.ts", symbol: "actualDefault" });
  assert.deepEqual(resolve("src/barrel.ts", "publicName"), { path: "src/implementation.ts", symbol: "actualName" });
  assert.deepEqual(resolve("src/middle.ts", "renamed"), { path: "src/implementation.ts", symbol: "actualName" });
});

test("named default functions/classes and arrow defaults resolve without whole-file fallback", () => {
  const resolve = resolverFixture({
    "src/caller.ts": "import Named from './named.js'; import Anonymous from './anonymous.js'; import Arrow from './arrow.js'; import Expression from './expression.js';",
    "src/named.ts": "export default function Actual() { return true; }",
    "src/anonymous.ts": "export default class { read() { return true; } }",
    "src/arrow.ts": "export default () => true;",
    "src/expression.ts": "function factory() { return true; }\nexport default factory();",
  });
  assert.deepEqual(resolve("src/caller.ts", "Named"), { path: "src/named.ts", symbol: "Actual" });
  assert.deepEqual(resolve("src/caller.ts", "Anonymous"), { path: "src/anonymous.ts", symbol: "default" });
  assert.deepEqual(resolve("src/caller.ts", "Arrow"), { path: "src/arrow.ts", symbol: "default" });
  assert.equal(resolve("src/caller.ts", "Expression"), null);
});

test("star export provenance rejects ambiguity and handles cycles without guessing", () => {
  const resolve = resolverFixture({
    "src/caller.ts": "import { same } from './ambiguous.js'; import { actual } from './cycle-a.js'; import { preferred } from './explicit.js';",
    "src/a.ts": "export function same() { return 'a'; }\nexport function preferred() { return 'a'; }",
    "src/b.ts": "export function same() { return 'b'; }\nexport function preferred() { return 'b'; }",
    "src/ambiguous.ts": "export * from './a.js'; export * from './b.js';",
    "src/cycle-a.ts": "export * from './cycle-b.js'; export * from './leaf.js';",
    "src/cycle-b.ts": "export * from './cycle-a.js';",
    "src/leaf.ts": "export function actual() { return true; }",
    "src/explicit.ts": "export * from './a.js'; export * from './b.js'; export { preferred } from './b.js';",
  });
  assert.equal(resolve("src/caller.ts", "same"), null);
  assert.deepEqual(resolve("src/caller.ts", "actual"), { path: "src/leaf.ts", symbol: "actual" });
  assert.deepEqual(resolve("src/caller.ts", "preferred"), { path: "src/b.ts", symbol: "preferred" });
  assert.equal(resolve("src/cycle-a.ts", "nonexistent"), null);
});

test("type-only, external, non-exported, namespace, ambient and duplicate import bindings are not canonicalized", () => {
  const resolve = resolverFixture({
    "src/caller.ts": "import type { value as typeOnly } from './leaf.js';\nimport { type value as specifierType } from './leaf.js';\nimport { hidden } from './leaf.js';\nimport { readFile } from 'node:fs';\nimport * as namespace from './leaf.js';\nimport { value as duplicated } from './leaf.js';\nimport { value as duplicated } from './other.js';\nimport { Signature } from './ambient.js';\nimport { value as reexportedType } from './type-export.js';",
    "src/leaf.ts": "export function value() { return true; }\nfunction hidden() { return false; }",
    "src/other.ts": "export function value() { return false; }",
    "src/ambient.d.ts": "export declare function Signature(): boolean;",
    "src/type-export.ts": "export type { value } from './leaf.js';",
  });
  for (const name of ["typeOnly", "specifierType", "hidden", "readFile", "namespace", "namespace.value", "duplicated", "Signature", "reexportedType", "invented"]) {
    assert.equal(resolve("src/caller.ts", name), null, name);
  }
});

test("TS-configured local aliases resolve only to sources inside the explicit inventory", () => {
  const resolve = resolverFixture({
    "src/caller.ts": "import { value as importedValue } from '@product/leaf';",
    "src/leaf.ts": "export const value = 'configured local source';",
  }, { baseUrl: ".", paths: { "@product/*": ["src/*"] }, moduleResolution: "bundler", module: "esnext" });
  assert.deepEqual(resolve("src/caller.ts", "importedValue"), { path: "src/leaf.ts", symbol: "value" });
});
