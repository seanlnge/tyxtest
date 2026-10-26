import fs from "node:fs";
import path from "node:path";

import { loadConfig, requireModels } from "../config/config.js";
import { discoverSurfaces } from "../surface/discover.js";
import { loadEnvFile } from "../config/env.js";
import { indexCommand } from "./index-command.js";
import { asRecord, parseModelJson } from "../model/model-json.js";
import { normalizeRel } from "../util/paths.js";
import type { Prompter } from "./prompter.js";
import { createModelClient } from "../model/providers.js";
import { listSourceFiles, readFileBundle, routerFiles } from "../closure/repo-files.js";
import { backfillTestIds, writeSurface } from "../surface/surface.js";
import type { ModelClient, ModelSource, TyxtestConfig } from "../config/types.js";

interface GenerateQuestion {
  prompt: string;
  guess?: string;
}

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
  const config = options.config ?? loadConfig(options.cwd);
  const acceptProposal = options.yes === true || (!options.interactive && config.nonInteractive === "search");
  if (!options.interactive && !acceptProposal) {
    throw new Error(
      "tyxtest generate needs a terminal to accept the surface tree. Re-run with --yes to accept the proposal.",
    );
  }
  const env = loadEnvFile(options.cwd, options.env ?? process.env);
  const model = resolveModel(options.model, () => createModelClient(requireModels(config).indexModel, env));
  const files = listSourceFiles(options.cwd);
  const routes = routerFiles(files);
  const bundle = readFileBundle(options.cwd, (routes.length > 0 ? routes : files).slice(0, 20), 40_000);
  const response = await model.complete({
    purpose: "generate",
    system: [
      "You propose a product surface tree from what this software does for its users.",
      "For a web app, surfaces are screens. For a CLI, commands. For a library, its public API. For a server, its endpoints.",
      'Reply with JSON only: {"surfaces":[{"slug":"login-page","name":"Login page","description":"...","entry":"src/pages/login.tsx","tests":[{"id":"submit-exists","text":"There is a submit button"}],"children":[]}],"questions":[{"prompt":"Which component is the login form?","guess":"src/pages/login.tsx"}]}',
      "Ask questions only when a mapping or the intended behavior is ambiguous. Otherwise return an empty questions array.",
      "Every surface needs an entry path that exists in the file list and at least one test.",
    ].join(" "),
    prompt: `${readProjectBrief(options.cwd)}\n\nSource files:\n${files.join("\n") || "(none)"}\n\nSample source:\n${bundle || "(none)"}`,
  });

  const proposal = parseProposal(response);
  const flags = await askStuckQuestions({
    prompter: options.prompter,
    interactive: options.interactive,
    yes: acceptProposal,
    nonInteractive: config.nonInteractive,
    maxQuestions: config.maxQuestions,
    questions: proposal.questions,
  });
  if (flags.length > 0) options.prompter.log(flags.join("\n"));
  const accepted = await confirmTree(options.prompter, flatten(proposal.surfaces), acceptProposal);
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

function parseProposal(text: string): { surfaces: ProposedSurface[]; questions: GenerateQuestion[] } {
  const record = asRecord(parseModelJson(text), "Generate response");
  if (!Array.isArray(record.surfaces)) throw new Error("Generate response is missing surfaces.");
  const questions = Array.isArray(record.questions)
    ? record.questions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const question = item as Record<string, unknown>;
        if (typeof question.prompt !== "string" || question.prompt.trim() === "") return [];
        const parsed: GenerateQuestion = { prompt: question.prompt.trim() };
        if (typeof question.guess === "string" && question.guess.trim()) parsed.guess = question.guess.trim();
        return [parsed];
      })
    : [];
  return {
    surfaces: record.surfaces.filter((item): item is ProposedSurface => Boolean(item) && typeof item === "object"),
    questions,
  };
}

async function askStuckQuestions(options: {
  prompter: Prompter;
  interactive: boolean;
  yes: boolean;
  nonInteractive: TyxtestConfig["nonInteractive"];
  maxQuestions: number;
  questions: GenerateQuestion[];
}): Promise<string[]> {
  if (options.questions.length === 0) return [];
  const cap = options.maxQuestions;
  const askable = options.questions.slice(0, cap);
  const overflow = options.questions.slice(cap);
  const flags = overflow.map((question) => guessFlag(question, "over maxQuestions"));
  const ask = options.interactive && !options.yes && askable.length > 0;
  if (ask) {
    const body = askable
      .map((question, index) => `${index + 1}. ${question.prompt}${question.guess ? ` [${question.guess}]` : ""}`)
      .join("\n");
    await options.prompter.ask(`Answer these in one reply, or press enter to keep the guesses:\n${body}\n`);
    return flags;
  }
  if (!options.interactive && !options.yes && options.nonInteractive === "fail" && askable.length > 0) {
    throw new Error("generate has questions and nonInteractive is fail. Re-run locally or set nonInteractive to search.");
  }
  return [...askable.map((question) => guessFlag(question, "guess")), ...flags];
}

function guessFlag(question: GenerateQuestion, label: string): string {
  return `${label}: ${question.prompt}${question.guess ? ` → ${question.guess}` : ""}`;
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

function readProjectBrief(cwd: string): string {
  const packagePath = path.join(cwd, "package.json");
  let entryPoints = "(no package.json)";
  if (fs.existsSync(packagePath)) {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    entryPoints = JSON.stringify(
      {
        name: parsed.name,
        description: parsed.description,
        main: parsed.main,
        bin: parsed.bin,
        exports: parsed.exports,
      },
      null,
      2,
    );
  }
  const readmeName = ["README.md", "readme.md", "README"].find((name) => fs.existsSync(path.join(cwd, name)));
  const readme = readmeName ? fs.readFileSync(path.join(cwd, readmeName), "utf8").slice(0, 8_000) : "(no README)";
  return `Package entry points (main, bin, exports):\n${entryPoints}\n\nREADME:\n${readme}`;
}

function resolveModel(source: ModelSource | undefined, fallback: () => ModelClient): ModelClient {
  if (!source) return fallback();
  return typeof source === "function" ? source() : source;
}
