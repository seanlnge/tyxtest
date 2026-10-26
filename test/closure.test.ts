import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectClosure, computeSurfaceClosure, hashClosure } from "../src/closure.js";
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

test("child closure is scoped to the parent closure", () => {
  const cwd = fixture();
  const parent = collectClosure({ cwd, entries: ["src/a.ts"], depth: 1 });
  const scoped = computeSurfaceClosure({
    cwd,
    entry: "src/a.ts",
    depth: null,
    parentClosure: parent.files,
  });
  assert.deepEqual(
    scoped.files.map((file) => file.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.throws(
    () => computeSurfaceClosure({ cwd, entry: "src/d.ts", depth: null, parentClosure: parent.files }),
    /outside the parent surface closure/,
  );
});
