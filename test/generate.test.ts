import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateCommand } from "../src/commands/generate.js";
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
              entry: "src/login.ts",
              tests: [{ id: "submit-exists", text: "There is a submit button" }],
            },
          ],
        });
      }
      if (request.purpose === "index") {
        return JSON.stringify({
          files: [{ path: "src/login.ts", symbols: ["LoginForm"] }],
          notes: ["Watch the disabled state"],
        });
      }
      throw new Error(`unexpected purpose ${request.purpose}`);
    },
  };
  await generateCommand({ cwd, model, prompter: silentPrompter(), interactive: false, yes: true, env: {} });
  const markdown = fs.readFileSync(path.join(cwd, "tyxtest/login/surface.md"), "utf8");
  assert.match(markdown, /entry: src\/login\.ts/);
  assert.match(markdown, /\[submit-exists\] There is a submit button/);
  const index = JSON.parse(fs.readFileSync(path.join(cwd, "tyxtest/login/.index.json"), "utf8")) as {
    closure: Array<{ path: string }>;
    closureHash: string;
    notes: string[];
  };
  assert.equal(purposes.join(","), "generate,index");
  assert.ok(index.closure.some((file) => file.path === "src/login.ts"));
  assert.match(index.closureHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(index.notes, ["Watch the disabled state"]);
  assert.equal(JSON.stringify(index).includes("timestamp"), false);
});
