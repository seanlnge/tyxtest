import fs from "node:fs";
import path from "node:path";

import { loadConfig, requireModels } from "./config.js";
import { discoverSurfaces } from "./discover.js";
import { loadEnvFile } from "./env.js";
import { indexCommand } from "./index-command.js";
import { asRecord, parseModelJson } from "./model-json.js";
import { normalizeRel } from "./paths.js";
import type { Prompter } from "./prompter.js";
import { createModelClient } from "./providers.js";
import { listSourceFiles, readFileBundle, routerFiles } from "./repo-files.js";
import { backfillTestIds, writeSurface } from "./surface.js";
import type { ModelClient, ModelSource, TyxtestConfig } from "./types.js";

interface ProposedSurface {
  slug?: string;
  name?: string;
  description?: string;
  entry?: string;
  tests?: Array<{ id?: string; text?: string }>;
  children?: ProposedSurface[];
}

interface FlatSurface {
  relativeDir: string;
  name: string;
  description: string;
  entry: string;
  tests: Array<{ id?: string; text: string }>;
}

export async function generateCommand(options: {
  cwd: string;
  prompter: Prompter;
  interactive: boolean;
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: TyxtestConfig;
  model?: ModelSource;
}): Promise<void> {
  if (discoverSurfaces(options.cwd).length > 0) {
    throw new Error(
      "tyxtest generate refuses to run because tyxtest/ already has surfaces. It only creates the first set of tests.",
    );
  }
  if (!options.interactive && !options.yes) {
    throw new Error(
      "tyxtest generate needs a terminal to accept the surface tree. Re-run with --yes to accept the proposal.",
    );
  }

  const config = options.config ?? loadConfig(options.cwd);
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const model = resolveModel(options.model, () => createModelClient(requireModels(config).indexModel, env));
  const files = listSourceFiles(options.cwd);
  const routes = routerFiles(files);
  const bundle = readFileBundle(options.cwd, (routes.length > 0 ? routes : files).slice(0, 30), 80_000);
  const response = await model.complete({
    purpose: "generate",
    system: [
      "You propose a product surface tree for a TypeScript codebase.",
      'Reply with JSON only: {"surfaces":[{"slug":"login-page","name":"Login page","description":"...","entry":"src/pages/login.tsx","tests":[{"id":"submit-exists","text":"There is a submit button"}],"children":[]}]}',
      "Every surface needs an entry path that exists in the file list and at least one test.",
    ].join(" "),
    prompt: `Source files:\n${files.join("\n") || "(none)"}\n\nRouter and page files:\n${bundle || "(none found)"}`,
  });

  const accepted = await confirmTree(options.prompter, flatten(parseProposal(response)), options.yes === true);
  if (accepted.length === 0) throw new Error("No surfaces left to write.");
  for (const surface of accepted) {
    if (!surface.entry) throw new Error(`Proposed surface "${surface.relativeDir}" has no entry file.`);
    if (!fs.existsSync(path.join(options.cwd, surface.entry))) {
      throw new Error(`Entry file not found: ${surface.entry}`);
    }
    const filled = backfillTestIds(renderSurface(surface));
    writeSurface(path.join(options.cwd, "tyxtest", surface.relativeDir, "surface.md"), filled.markdown);
  }
  options.prompter.log(`wrote ${accepted.length} surface${accepted.length === 1 ? "" : "s"}`);
  await indexCommand({
    cwd: options.cwd,
    prompter: options.prompter,
    interactive: options.interactive,
    env,
    config,
    model,
  });
}

async function confirmTree(prompter: Prompter, surfaces: FlatSurface[], yes: boolean): Promise<FlatSurface[]> {
  prompter.log(formatTree(surfaces));
  if (yes) return surfaces;
  const answer = (
    (await prompter.ask("Accept, drop, or edit the proposed surfaces? (accept/drop/edit) [accept]:")) || "accept"
  ).toLowerCase();
  if (answer === "accept" || answer === "yes" || answer === "y") return surfaces;
  if (answer === "drop") {
    const dropped = new Set(
      (await prompter.ask("Surface paths to drop, comma-separated:"))
        .split(",")
        .map((item) => normalizeRel(item.trim()))
        .filter(Boolean),
    );
    return surfaces.filter(
      (surface) =>
        !dropped.has(surface.relativeDir) && ![...dropped].some((item) => surface.relativeDir.startsWith(`${item}/`)),
    );
  }
  if (answer === "edit") {
    const kept: FlatSurface[] = [];
    for (const surface of surfaces) {
      const choice = (
        (await prompter.ask(`${surface.relativeDir}: keep, drop, or edit tests? (keep/drop/edit) [keep]:`)) || "keep"
      ).toLowerCase();
      if (choice === "drop") continue;
      if (choice !== "edit") {
        kept.push(surface);
        continue;
      }
      const tests = [];
      for (const test of surface.tests) {
        const next = (
          await prompter.ask(`Test ${test.id ? `[${test.id}] ` : ""}${test.text} (enter to keep, drop, or new text):`)
        ).trim();
        if (next.toLowerCase() === "drop") continue;
        tests.push({ id: test.id, text: next || test.text });
      }
      kept.push({ ...surface, tests });
    }
    return kept;
  }
  throw new Error(`Unknown choice "${answer}". Use accept, drop, or edit.`);
}

function parseProposal(text: string): ProposedSurface[] {
  const record = asRecord(parseModelJson(text), "Generate response");
  if (!Array.isArray(record.surfaces)) throw new Error("Generate response is missing surfaces.");
  return record.surfaces.filter((item): item is ProposedSurface => Boolean(item) && typeof item === "object");
}

function flatten(nodes: ProposedSurface[], parent = ""): FlatSurface[] {
  const flat: FlatSurface[] = [];
  for (const node of nodes) {
    const name = (node.name || node.slug || "surface").trim();
    const slug = slugPart(node.slug || name);
    const relativeDir = parent ? `${parent}/${slug}` : slug;
    flat.push({
      relativeDir,
      name,
      description: node.description?.trim() || "",
      entry: node.entry ? normalizeRel(node.entry) : "",
      tests: (node.tests ?? []).flatMap((test) => {
        if (typeof test.text !== "string" || test.text.trim() === "") return [];
        return [{ id: typeof test.id === "string" ? test.id.trim() : undefined, text: test.text.trim() }];
      }),
    });
    if (node.children?.length) flat.push(...flatten(node.children, relativeDir));
  }
  return flat;
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "surface";
}

function renderSurface(surface: FlatSurface): string {
  const lines = ["---", `surface: ${surface.name}`];
  if (surface.description) lines.push(`description: ${surface.description}`);
  if (surface.entry) lines.push(`entry: ${surface.entry}`);
  lines.push("---", "");
  for (const test of surface.tests) {
    const id = test.id && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(test.id) ? test.id : "";
    lines.push(id ? `- [${id}] ${test.text}` : `- ${test.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatTree(surfaces: FlatSurface[]): string {
  const lines = ["Proposed surfaces:", ""];
  for (const surface of surfaces) {
    const pad = "  ".repeat(surface.relativeDir.split("/").length - 1);
    lines.push(`${pad}${surface.relativeDir} — ${surface.name}`);
    if (surface.entry) lines.push(`${pad}  entry: ${surface.entry}`);
    for (const test of surface.tests) {
      lines.push(`${pad}  - ${test.id ? `[${test.id}] ` : ""}${test.text}`);
    }
  }
  return lines.join("\n");
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
