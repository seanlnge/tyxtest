import { loadEnvFile, isNonInteractive } from "./env.js";
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
  tyxtest index [--fix] [surface...]
  tyxtest run [--non-interactive] [surface...]

setup     write tyxtest/tyxtest.config.json, ignore .env, mark .index.json merge=ours
generate  propose the first surface tree when tyxtest/ has no surfaces
index     map each surface onto its import closure and write .index.json
run       judge each test and write JSON + JUnit under .tyxtest/

Config lives in tyxtest/tyxtest.config.json and names env vars. It must not contain API keys.
`;

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
  try {
    return await dispatch(argv, { ...deps, stdout, stderr });
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
  },
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    deps.stdout(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    deps.stdout("1.0.0\n");
    return 0;
  }

  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const positionals = rest.filter((arg) => !arg.startsWith("--"));
  const cwd = deps.cwd ?? process.cwd();
  const env = loadEnvFile(cwd, deps.env ?? process.env);
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const interactive = flags.has("--non-interactive") ? false : !isNonInteractive(env, stdinIsTTY);
  const prompter = deps.prompter ?? readlinePrompter();

  if (command === "setup") {
    await setupCommand({ cwd, prompter, env, interactive });
    return 0;
  }
  if (command === "generate") {
    await generateCommand({ cwd, prompter, env, interactive, yes: flags.has("--yes") });
    return 0;
  }
  if (command === "index") {
    await indexCommand({ cwd, prompter, env, interactive, surfaces: positionals });
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
    });
    return outcome.exitCode;
  }

  deps.stderr(`Unknown command "${command}".`);
  deps.stdout(HELP);
  return 1;
}
