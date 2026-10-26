import { loadEnvFile, isNonInteractive } from "../config/env.js";
import { generateCommand } from "./generate.js";
import { indexCommand } from "./index-command.js";
import type { Prompter } from "./prompter.js";
import { readlinePrompter } from "./prompter.js";
import { runCommand } from "./run.js";
import { setupCommand } from "./setup.js";

const HELP = `tyxtest — product-surface tests for TypeScript

Usage:
  tyxtest setup
  tyxtest generate [--yes]
  tyxtest index [--pending | --fix] [surface...]
  tyxtest run [-A] [--non-interactive] [--verbose] [--cached] [surface...]
  tyxtest <command> --help

setup     write tyxtest/tyxtest.config.json, ignore .env, mark .index.json merge=ours
generate  propose the first surface tree when tyxtest/ has no surfaces
index     map each surface onto its import closure and write .index.json. --pending applies suggestions; --fix reindexes all surfaces
run       judge each test on its fresh import closure, with indexed evidence. Jev retries every non-pass; uncertain aggregates escalate once. The escalation model does not rerun.

Config lives in tyxtest/tyxtest.config.json and names env vars. It must not contain API keys.
`;

const COMMAND_HELP: Record<string, string> = {
  setup: `tyxtest setup

Write tyxtest/tyxtest.config.json, add .env, .tyxtest/, and tyxtest/.pending.json to .gitignore, and mark tyxtest/**/.index.json merge=ours.

Asks for the index model, the runner model, and whether to generate the first surfaces. The config stores env var names, not API keys.
`,
  generate: `tyxtest generate [--yes]

Propose the first surface tree when tyxtest/ has no surfaces. Refuses to run once any surface exists.

  --yes   accept the proposal without prompting
`,
  index: `tyxtest index [--pending | --fix] [surface...]

Map each selected surface onto its import closure and write .index.json.

  --pending     reindex only surfaces listed in tyxtest/.pending.json
  --fix         reindex every surface, ignoring surface filters
  surface...    limit the run to these surface paths
`,
  run: `tyxtest run [-A] [--non-interactive] [--verbose] [--cached] [surface...]

Judge each test against its fresh import closure, including callers and dependencies outside the indexed evidence symbols. Indexed chunks select evidence, not the complete verdict context. Jev scores the claim and its evidence in one request. Every non-pass is retried up to reruns more times (default 2, three attempts), stopping early on pass. Attempts combine using verdictRule (default worst); an unsure aggregate escalates once. The escalation model does not rerun; its single verdict is the test result. An LLM also runs once when the decision API fails or when runnerModel.kind is llm. Runs do not write .index.json.

  -A, --all           judge every test, ignoring the cache and unchanged skips
  --non-interactive   do not prompt
  --verbose           include pass evidence in the final list
  --cached            show tests whose verdict was reused from the cache
  surface...          limit the run to these surface paths

Cached tests are hidden unless --cached is set or showCached is true in tyxtest.config.json.
fallback (default true) sends a test to the escalation model when the decision API fails. The escalation model defaults to the index model. The report notes that fallback at the end.
`,
};

function helpFor(command: string | undefined): string {
  if (!command) return HELP;
  return COMMAND_HELP[command] ?? HELP;
}

export async function main(argv: string[], deps: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompter?: Prompter;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  stdinIsTTY?: boolean;
} = {}): Promise<number> {
  const stdout = deps.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = deps.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const live = deps.stdout === undefined && process.stdout.isTTY === true;
  try {
    return await dispatch(argv, { ...deps, stdout, stderr, live });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    deps.prompter?.close?.();
  }
}

async function dispatch(
  argv: string[],
  deps: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    prompter?: Prompter;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    stdinIsTTY?: boolean;
    live?: boolean;
  },
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    deps.stdout(HELP);
    return 0;
  }
  if (command === "help") {
    deps.stdout(helpFor(rest[0]));
    return 0;
  }
  if (command === "--version" || command === "-v") {
    deps.stdout("1.0.0\n");
    return 0;
  }

  const flags = new Set(rest.filter((arg) => arg.startsWith("--") || arg === "-A"));
  const positionals = rest.filter((arg) => !arg.startsWith("--") && arg !== "-h" && arg !== "-A");
  if (flags.has("--help") || flags.has("-h") || rest.includes("-h")) {
    deps.stdout(helpFor(command));
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const env = loadEnvFile(cwd, deps.env ?? process.env);
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const interactive = flags.has("--non-interactive") ? false : !isNonInteractive(env, stdinIsTTY);
  const ownsPrompter = deps.prompter === undefined;
  const prompter = deps.prompter ?? readlinePrompter();
  try {
    if (command === "setup") {
      await setupCommand({ cwd, prompter, env, interactive });
      return 0;
    }
    if (command === "generate") {
      await generateCommand({ cwd, prompter, env, interactive, yes: flags.has("--yes") });
      return 0;
    }
    if (command === "index") {
        await indexCommand({ cwd, prompter, env, interactive, surfaces: positionals, pending: flags.has("--pending"), fix: flags.has("--fix") });
      return 0;
    }
    if (command === "run") {
      const outcome = await runCommand({
        cwd,
        env,
        interactive,
        surfaces: positionals,
        stdout: deps.stdout,
        stderr: deps.stderr,
        verbose: flags.has("--verbose"),
        live: deps.live === true,
        showCached: flags.has("--cached") ? true : undefined,
        all: flags.has("-A") || flags.has("--all"),
      });
      return outcome.exitCode;
    }

    deps.stderr(`Unknown command "${command}".`);
    deps.stdout(HELP);
    return 1;
  } finally {
    if (ownsPrompter) prompter.close?.();
  }
}
