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
import { readTests, writeSurface } from "../surface/surface.js";
import type { MarkdownConfig, ModelClient, ModelRequest, ModelSource, TyxtestConfig } from "../config/types.js";

interface GenerateQuestion {
  prompt: string;
  guess?: string;
}

interface ProposedSurface {
  slug?: string;
  name?: string;
  description?: string;
  tests?: Array<{ id?: string; text?: string; body?: string; notes?: string }>;
  children?: ProposedSurface[];
}

interface FlatSurface {
  relativeDir: string;
  name: string;
  description: string;
  tests: Array<{ id?: string; text: string; body: string }>;
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
  const bundle = readFileBundle(options.cwd, (routes.length > 0 ? routes : files).slice(0, 20), Infinity);
  const request: ModelRequest = {
    purpose: "generate",
    system: [
      "You propose a product surface tree from what this software does for its users.",
      "For a web app, surfaces are screens. For a CLI, commands. For a library, its public API. For a server, its endpoints.",
      'Reply with JSON only: {"surfaces":[{"slug":"login-page","name":"Login page","description":"...","tests":[{"text":"Submit button availability","body":"The button is enabled only when the form is valid.\\n\\n- Invalid credentials show an error."}],"children":[]}],"questions":[{"prompt":"Which form behavior is important?","guess":"..."}]}',
      `Each test's text is a short, single-line heading without a discovery prefix; the renderer adds the configured prefix ${JSON.stringify(config.markdown.testDiscovery.prefix)}. Its body is raw Markdown prose and may contain paragraphs, nested lists, and fenced code blocks. Do not put headings at or above level ${config.markdown.testDiscovery.headingLevel} in a test body.`,
      "Ask questions only when intended behavior is ambiguous. Otherwise return an empty questions array.",
      "Each surface describes user-visible behavior and contains one or more tests. Surfaces may cover arbitrary files; do not scope them to a single entry file.",
    ].join(" "),
    prompt: `${readProjectBrief(options.cwd)}\n\nSource files:\n${files.join("\n") || "(none)"}\n\nSample source:\n${bundle || "(none)"}`,
  };

  let proposal = parseProposal(await model.complete(request));
  let revised = false;
  const answers = await askStuckQuestions({
    prompter: options.prompter,
    interactive: options.interactive,
    yes: acceptProposal,
    nonInteractive: config.nonInteractive,
    maxQuestions: config.maxQuestions,
    questions: proposal.questions,
  });
  if (answers.answer.trim()) {
    revised = true;
    const askable = proposal.questions.slice(0, config.maxQuestions);
    const overflow = proposal.questions.slice(config.maxQuestions);
    proposal = parseProposal(await model.complete({
      ...request,
      prompt: `${request.prompt}\n\nOriginal proposal:\n${JSON.stringify(proposal.surfaces)}\n\nQuestions asked (answers correspond to these only):\n${JSON.stringify(askable)}\n\nUser's batched answer to those asked questions:\n${answers.answer}\n\nQuestions not asked because of maxQuestions (do not treat them as answered):\n${JSON.stringify(overflow)}\n\nRevise the proposal using this context. Return the same JSON schema, including any remaining ambiguities in questions.`,
    }));
  }
  const flags = revised
    ? [...answers.flags, ...proposal.questions.map((question) => guessFlag(question, "unresolved"))]
    : answers.flags;
  if (flags.length > 0) options.prompter.log(flags.join("\n"));
  const accepted = await confirmTree(options.prompter, flatten(proposal.surfaces), acceptProposal);
  if (accepted.length === 0) throw new Error("No surfaces left to write.");
  const destinations = new Set<string>();
  for (const surface of accepted) {
    const normalizedDir = surface.relativeDir.toLowerCase();
    if (destinations.has(normalizedDir)) {
      throw new Error(`Proposed surfaces collide at normalized path "${surface.relativeDir}". Rename or remove the conflicting surfaces before accepting.`);
    }
    destinations.add(normalizedDir);
  }
  for (const surface of accepted) {
    validateSurface(surface, config.markdown);
  }
  for (const surface of accepted) {
    writeSurface(path.join(options.cwd, "tyxtest", surface.relativeDir, "surface.md"), renderSurface(surface, config.markdown));
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
        tests.push({ id: test.id, text: next || test.text, body: test.body });
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
}): Promise<{ flags: string[]; answer: string }> {
  if (options.questions.length === 0) return { flags: [], answer: "" };
  const cap = options.maxQuestions;
  const askable = options.questions.slice(0, cap);
  const overflow = options.questions.slice(cap);
  const flags = overflow.map((question) => guessFlag(question, "over maxQuestions"));
  const ask = options.interactive && !options.yes && askable.length > 0;
  if (ask) {
    const body = askable
      .map((question, index) => `${index + 1}. ${question.prompt}${question.guess ? ` [${question.guess}]` : ""}`)
      .join("\n");
    const answer = await options.prompter.ask(`Answer these in one reply, or press enter to keep the guesses:\n${body}\n`);
    return { flags, answer };
  }
  if (!options.interactive && !options.yes && options.nonInteractive === "fail" && askable.length > 0) {
    throw new Error("generate has questions and nonInteractive is fail. Re-run locally or set nonInteractive to search.");
  }
  return { flags: [...askable.map((question) => guessFlag(question, "guess")), ...flags], answer: "" };
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
      tests: (node.tests ?? []).flatMap((test) => {
        if (typeof test.text !== "string" || test.text.trim() === "") return [];
        return [{
          id: typeof test.id === "string" ? test.id.trim() : undefined,
          text: test.text.trim(),
          body: (typeof test.body === "string" ? test.body : typeof test.notes === "string" ? test.notes : "")
            .replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, ""),
        }];
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

function renderSurface(surface: FlatSurface, markdown: MarkdownConfig): string {
  const discovery = markdown.testDiscovery;
  const lines = [`# ${surface.name}`, ""];
  if (surface.description) lines.push(surface.description, "");
  for (const test of surface.tests) {
    const prefix = discovery.prefix;
    const title = prefix !== null && test.text.startsWith(prefix) ? test.text.slice(prefix.length).trim() : test.text;
    const label = prefix === null ? title : `${prefix.replace(/[\\`*_[\]{}()#+.!<>|~&-]/g, "\\$&")}${/\s$/.test(prefix) ? "" : " "}${title}`;
    if (discovery.mode === "bullets") {
      lines.push(`- ${label}`);
      if (test.body) lines.push(...test.body.split(/\r?\n/).map((line) => `  ${line}`));
    } else {
      lines.push(`${"#".repeat(discovery.headingLevel)} ${label}`, "");
      if (test.body) lines.push(test.body, "");
    }
  }
  lines.push("");
  return lines.join("\n");
}

function validateSurface(surface: FlatSurface, markdown: MarkdownConfig): void {
  if (!surface.name.trim() || /[\r\n]/.test(surface.name)) {
    throw new Error(`Surface title in "${surface.relativeDir}" must be a non-empty single line.`);
  }
  for (const test of surface.tests) {
    if (!test.text.trim() || /[\r\n]/.test(test.text)) {
      throw new Error(`Test heading in "${surface.relativeDir}" must be a non-empty single line.`);
    }
  }
  const rendered = renderSurface(surface, markdown);
  const parsed = readTests(rendered, markdown);
  if (parsed.length !== surface.tests.length || parsed.some((test, index) => (test.notes ?? "") !== surface.tests[index]!.body)) {
    throw new Error(`Rendered body in "${surface.relativeDir}" contains a heading boundary or changes the proposed tests; refusing to write surfaces.`);
  }
}

function formatTree(surfaces: FlatSurface[]): string {
  const lines = ["Proposed surfaces:", ""];
  for (const surface of surfaces) {
    const pad = "  ".repeat(surface.relativeDir.split("/").length - 1);
    lines.push(`${pad}${surface.relativeDir} — ${surface.name}`);
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
