import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectClosure, collectTestContext, hashClosure } from "../src/closure/closure.js";
import { listSourceFiles, readFileBundle } from "../src/closure/repo-files.js";
import { tempDir } from "./helpers.js";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(): string {
  const cwd = tempDir("tyxtest-closure-");
  write(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        allowJs: true,
        strict: true,
        noEmit: true,
      },
    }),
  );
  write(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  write(path.join(cwd, "src/a.ts"), 'import { b } from "./b";\nexport const a = b;\n');
  write(path.join(cwd, "src/b.ts"), 'export { c } from "./c";\nexport const b = "b";\n');
  write(path.join(cwd, "src/c.ts"), 'export const c = "c";\n');
  write(path.join(cwd, "src/d.ts"), 'export const d = "unrelated";\n');
  write(path.join(cwd, "src/dyn.ts"), 'export const load = () => import("./c");\n');
  write(path.join(cwd, "src/with-lib.ts"), 'import "left-pad";\nimport "../node_modules/left-pad/index.js";\nimport { b } from "./b";\nexport const marker = b;\n');
  write(
    path.join(cwd, "node_modules/left-pad/package.json"),
    JSON.stringify({ name: "left-pad", version: "1.0.0", main: "index.js" }),
  );
  write(path.join(cwd, "node_modules/left-pad/index.js"), "module.exports = function leftPad() { return \"\"; };\n");
  return cwd;
}

test("closure hash is order independent and content sensitive", () => {
  const first = hashClosure([
    { path: "src/b.ts", hash: "bbb" },
    { path: "src/a.ts", hash: "aaa" },
  ]);
  const second = hashClosure([
    { path: "src/a.ts", hash: "aaa" },
    { path: "src/b.ts", hash: "bbb" },
  ]);
  assert.equal(first, second);
  assert.notEqual(first, hashClosure([{ path: "src/a.ts", hash: "changed" }, { path: "src/b.ts", hash: "bbb" }]));
});

test("TypeScript compiler API closure follows imports, skips node_modules, and honors depth", () => {
  const cwd = fixture();
  const full = collectClosure({ cwd, entries: ["src/a.ts"], depth: null });
  assert.deepEqual(
    full.files.map((file) => file.path),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );

  const entryOnly = collectClosure({ cwd, entries: ["src/a.ts"], depth: 0 });
  assert.deepEqual(
    entryOnly.files.map((file) => file.path),
    ["src/a.ts"],
  );

  const oneHop = collectClosure({ cwd, entries: ["src/a.ts"], depth: 1 });
  assert.deepEqual(
    oneHop.files.map((file) => file.path),
    ["src/a.ts", "src/b.ts"],
  );

  const dynamic = collectClosure({ cwd, entries: ["src/dyn.ts"], depth: null });
  assert.deepEqual(
    dynamic.files.map((file) => file.path),
    ["src/c.ts", "src/dyn.ts"],
  );

  const withLib = collectClosure({ cwd, entries: ["src/with-lib.ts"], depth: null });
  const libPaths = withLib.files.map((file) => file.path);
  assert.deepEqual(libPaths, ["src/b.ts", "src/c.ts", "src/with-lib.ts"]);
  assert.equal(libPaths.some((file) => file.includes("node_modules")), false);

  const before = full.closureHash;
  fs.writeFileSync(path.join(cwd, "src/d.ts"), 'export const d = "edited unrelated";\n');
  assert.equal(collectClosure({ cwd, entries: ["src/a.ts"], depth: null }).closureHash, before);
  fs.writeFileSync(path.join(cwd, "src/c.ts"), 'export const c = "edited";\n');
  assert.notEqual(collectClosure({ cwd, entries: ["src/a.ts"], depth: null }).closureHash, before);
});

test("previous snapshots never authorize upstream callers", () => {
  const cwd = fixture();
  write(path.join(cwd, "src/caller.ts"), 'import { b } from "./b"; export const caller = b;');
  const original = collectTestContext({ cwd, chunks: [{ path: "src/b.ts", symbol: "b" }] });
  write(path.join(cwd, "src/new-upstream.ts"), 'import { caller } from "./caller"; export const upstream = caller;');
  const refreshed = collectTestContext({ cwd, chunks: [{ path: "src/b.ts", symbol: "b" }], previous: original.files });
  assert.deepEqual(refreshed.files.map((file) => file.path), ["src/b.ts"]);
});

test("test context includes only selected paths and explicit context, never graph or snapshots", () => {
  const cwd = fixture();
  write(path.join(cwd, "src/caller.ts"), 'import { b } from "./b"; export const caller = b;');
  write(path.join(cwd, "src/transitive-caller.ts"), 'import { caller } from "./caller"; export const outer = caller;');
  write(path.join(cwd, "src/unrelated.ts"), 'import { c } from "./c"; export const unrelated = c;');
  write(path.join(cwd, "src/new-import.ts"), 'import { d } from "./d"; export const value = d;');
  const initial = collectTestContext({ cwd, chunks: [{ path: "src/b.ts", symbol: "b" }] });
  assert.ok(!initial.files.some((file) => file.path === "src/caller.ts"));
  assert.ok(!initial.files.some((file) => file.path === "src/transitive-caller.ts"));
  assert.ok(!initial.files.some((file) => file.path === "src/unrelated.ts"));
  write(path.join(cwd, "src/b.ts"), 'export { c } from "./c"; export const b = "changed"; import "./new-import";');
  write(path.join(cwd, "src/caller.ts"), "export const caller = true;");
  const next = collectTestContext({ cwd, chunks: [{ path: "src/b.ts", symbol: "b" }], context: ["src/caller.ts"], previous: initial.files });
  assert.ok(next.files.some((file) => file.path === "src/caller.ts"));
  assert.ok(!next.files.some((file) => file.path === "src/new-import.ts"));
  assert.ok(!next.files.some((file) => file.path === "src/d.ts"));
  assert.notEqual(next.closureHash, initial.closureHash);
});

test("selected chunks may cross semantic surface hierarchy without entries", () => {
  const cwd = fixture();
  write(path.join(cwd, "src/child.ts"), 'import { d } from "./d"; export const child = d;');
  const context = collectTestContext({ cwd, chunks: [{ path: "src/child.ts", symbol: "child" }] });
  assert.deepEqual(context.files.map((file) => file.path), ["src/child.ts"]);
});

test("inventory includes mts/cts and source bundles reject truncation", () => {
  const cwd = fixture();
  write(path.join(cwd, "src/extra.mts"), "export const extra = true;");
  write(path.join(cwd, "src/extra.cts"), "export const extraCjs = true;");
  assert.ok(listSourceFiles(cwd).includes("src/extra.mts"));
  assert.ok(listSourceFiles(cwd).includes("src/extra.cts"));
  assert.throws(() => readFileBundle(cwd, ["src/extra.mts"], 2), /refusing to index truncated/);
});

test("repository source inventory is not silently limited to four hundred files", () => {
  const cwd = tempDir("tyxtest-large-inventory-");
  for (let index = 0; index < 405; index += 1) {
    write(path.join(cwd, `src/file-${String(index).padStart(3, "0")}.ts`), `export const value = ${index};\n`);
  }
  const files = listSourceFiles(cwd);
  assert.equal(files.length, 405);
  assert.ok(files.includes("src/file-404.ts"));
});
