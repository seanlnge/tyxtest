import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateCommand } from "../src/commands/generate.js";
import { readIndexes } from "../src/surface/index-file.js";
import { readTests } from "../src/surface/surface.js";
import type { ModelClient, ModelRequest } from "../src/config/types.js";
import { tempDir } from "./helpers.js";

function silentPrompter() {
  return {
    async ask(): Promise<string> {
      throw new Error("generate --yes should not ask");
    },
    warn(): void {},
    log(): void {},
  };
}

test("generate refuses when surfaces already exist", async () => {
  const cwd = tempDir("tyxtest-generate-refuse-");
  const surface = path.join(cwd, "tyxtest", "login", "surface.md");
  fs.mkdirSync(path.dirname(surface), { recursive: true });
  fs.writeFileSync(surface, "---\nsurface: Login\n---\n- [keep] Keep this\n");
  const model: ModelClient = {
    async complete(): Promise<string> {
      throw new Error("model should not be called");
    },
  };
  await assert.rejects(
    () => generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} }),
    /already has surfaces/,
  );
});

test("generate writes surface.md and an index", async () => {
  const cwd = tempDir("tyxtest-generate-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/login.ts"), "export function LoginForm() {\n  return \"submit\";\n}\n");
  fs.writeFileSync(
    path.join(cwd, "tyxtest/tyxtest.config.json"),
    JSON.stringify({
      indexModel: { provider: "ollama", model: "index" },
      runnerModel: { provider: "ollama", model: "runner" },
    }),
  );
  const purposes: string[] = [];
  const model: ModelClient = {
    async complete(request: ModelRequest): Promise<string> {
      purposes.push(request.purpose);
      if (request.purpose === "generate") {
        return JSON.stringify({
          surfaces: [
            {
              slug: "login",
              name: "Login",
              description: "The login form",
              tests: [{ id: "submit-exists", text: "Submit button availability", body: "For valid credentials.\n\n- Invalid credentials show an error.\n  - The form remains editable.\n\n```md\n## This example heading is code\n```" }],
            },
          ],
        });
      }
      if (request.purpose === "index") {
        return JSON.stringify({
          tests: readTests(fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8"))
            .map((claim) => ({ testId: claim.id, chunks: [{ path: "src/login.ts", symbol: "LoginForm" }] })),
          notes: ["Watch the disabled state"],
        });
      }
      throw new Error(`unexpected purpose ${request.purpose}`);
    },
  };
  await generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} });
  const markdown = fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8");
  assert.match(markdown, /# Login/);
  assert.doesNotMatch(markdown, /^surface:/m);
  assert.doesNotMatch(markdown, /^---|^entry:/m);
  assert.doesNotMatch(markdown, /^description:/m);
  assert.match(markdown, /# Login\n\nThe login form/);
  assert.match(markdown, /## Submit button availability\n\nFor valid credentials\./);
  assert.match(markdown, /- Invalid credentials show an error\.\n  - The form remains editable\./);
  assert.match(markdown, /```md\n## This example heading is code\n```/);
  assert.equal(readTests(markdown).length, 1);
  assert.doesNotMatch(markdown, /\[submit-exists\]/);
  const index = readIndexes(cwd).get("login");
  assert.ok(index);
  assert.equal(purposes.join(","), "generate,index");
  assert.equal(index.closure, undefined);
  assert.equal(index.entry, undefined);
  assert.ok(index.tests?.[0]?.closure?.some((file) => file.path === "src/login.ts"));
  assert.match(index.tests?.[0]?.closureHash ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(index.notes, ["Watch the disabled state"]);
  assert.equal(JSON.stringify(index).includes("timestamp"), false);
});

test("generate supports discovery modes, heading depth, and literal prefixes", async () => {
  for (const [discovery, expected] of [
    [{ mode: "bullets", headingLevel: 2, prefix: null }, /- Save changes\n  Only after validation/],
    [{ mode: "headings", headingLevel: 4, prefix: null }, /#### Save changes\n\nOnly after validation/],
    [{ mode: "headings", headingLevel: 2, prefix: "Test:" }, /## Test: Save changes/],
    [{ mode: "bullets", headingLevel: 2, prefix: "Test:" }, /- Test: Save changes/],
    [{ mode: "headings", headingLevel: 2, prefix: "[test]" }, /## \\\[test\\\] Save changes/],
    [{ mode: "bullets", headingLevel: 2, prefix: "[test]" }, /- \\\[test\\\] Save changes/],
    [{ mode: "headings", headingLevel: 2, prefix: "Test: " }, /## Test: Save changes/],
  ] as const) {
    const markdownConfig = { testDiscovery: discovery };
    const cwd = tempDir("tyxtest-generate-markdown-mode-");
    fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), JSON.stringify({
      indexModel: { provider: "ollama", model: "index" }, runnerModel: { provider: "ollama", model: "runner" },
      markdown: markdownConfig,
    }));
    const model: ModelClient = {
      async complete(request): Promise<string> {
        if (request.purpose === "generate") return JSON.stringify({ surfaces: [{ name: "Editor", tests: [{ text: discovery.prefix === "Test: " ? "Test: Save changes" : "Save changes", body: "Only after validation\n\n    {\"indented\":true}" }] }] });
        if (request.purpose === "index") return JSON.stringify({ tests: readTests(fs.readFileSync(path.join(cwd, "tyxtest/editor/surface.md"), "utf8"), markdownConfig)
          .map((claim) => ({ testId: claim.id, chunks: [], unmappable: "This fixture has no product source files." })), notes: [] });
        throw new Error(`unexpected purpose ${request.purpose}`);
      },
    };
    await generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} });
    const markdown = fs.readFileSync(path.join(cwd, "tyxtest/editor/surface.md"), "utf8");
    assert.match(markdown, expected);
    assert.equal(readTests(markdown, markdownConfig).length, 1);
    assert.equal(readTests(markdown, markdownConfig)[0]?.text, "Save changes");
    assert.equal(readTests(markdown, markdownConfig)[0]?.notes, 'Only after validation\n\n    {"indented":true}');
  }
});

test("generate rejects body heading injection before writing any surfaces", async () => {
  for (const body of ["## Injected peer test", "Unintended surface\n==================", "Injected peer test\n------------------"]) {
  const cwd = tempDir("tyxtest-generate-heading-injection-");
  fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), JSON.stringify({
    indexModel: { provider: "ollama", model: "index" }, runnerModel: { provider: "ollama", model: "runner" },
  }));
  const model: ModelClient = {
    async complete(request): Promise<string> {
      if (request.purpose === "generate") return JSON.stringify({ surfaces: [
        { slug: "valid", tests: [{ text: "Valid", body: "Fine" }] },
        { slug: "injected", tests: [{ text: "Primary", body }] },
      ] });
      throw new Error("index must not run after invalid proposal");
    },
  };
  await assert.rejects(
    () => generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} }),
    /contains a heading/,
  );
  assert.equal(fs.existsSync(path.join(cwd, "tyxtest/valid/surface.md")), false);
  }
});

test("generate keeps revised test bodies", async () => {
  const cwd = tempDir("tyxtest-generate-revision-body-");
  fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), JSON.stringify({
    indexModel: { provider: "ollama", model: "index" }, runnerModel: { provider: "ollama", model: "runner" },
  }));
  let generated = 0;
  const model: ModelClient = {
    async complete(request): Promise<string> {
      if (request.purpose === "generate") {
        generated += 1;
        return JSON.stringify({
          surfaces: [{ slug: "editor", tests: [{ text: "Save changes", body: generated === 1 ? "Old body" : 'Revised body\n\n```json\n{"saved":true}\n```' }] }],
          questions: generated === 1 ? [{ prompt: "Should saving be conditional?" }] : [],
        });
      }
      throw new Error("index must not run after revision");
    },
  };
  const answers = ["Only when valid", "accept"];
  const prompter = {
    async ask(): Promise<string> { return answers.shift() ?? ""; },
    warn(): void {},
    log(): void {},
  };
  await assert.rejects(
    () => generateCommand({ cwd, model, prompter, interactive: true, env: {} }),
    /index must not run/,
  );
  const markdown = fs.readFileSync(path.join(cwd, "tyxtest/editor/surface.md"), "utf8");
  assert.match(markdown, /Revised body/);
  assert.doesNotMatch(markdown, /Old body/);
  assert.equal(readTests(markdown).length, 1);
});

test("generate rejects normalized root and nested slug collisions before writing surfaces", async () => {
  const duplicateSlugs = ["foo-bar", "Foo Bar"].map((slug) => ({ slug, tests: [{ text: "Exists" }] }));
  for (const nested of [false, true]) {
    const cwd = tempDir("tyxtest-generate-collision-");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "tyxtest"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src/login.ts"), "export const login = true;\n");
    fs.writeFileSync(path.join(cwd, "tyxtest/tyxtest.config.json"), JSON.stringify({
      indexModel: { provider: "ollama", model: "index" },
      runnerModel: { provider: "ollama", model: "runner" },
    }));
    const valid = { slug: "valid", tests: [{ text: "Valid sibling" }] };
    const surfaces = nested ? [{ ...valid, children: duplicateSlugs }] : [valid, ...duplicateSlugs];
    const model: ModelClient = {
      async complete(request): Promise<string> {
        if (request.purpose === "generate") return JSON.stringify({ surfaces });
        throw new Error("index must not run after collision");
      },
    };
    await assert.rejects(
      () => generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} }),
      /collide at normalized path/,
    );
    for (const relative of ["valid/surface.md", "valid/foo-bar/surface.md", "foo-bar/surface.md"]) {
      assert.equal(fs.existsSync(path.join(cwd, "tyxtest", relative)), false, `${relative} must not be partially written`);
    }
  }
});
