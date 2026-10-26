# tyxtest

tyxtest checks product claims against a TypeScript codebase. A test says what the product does ("there is a submit button in the form"). By default a decision model scores that claim against chunks of the import closure. An LLM runs only when the probability is between the pass and fail thresholds, or when `runnerModel.kind` is `llm`.

Checks are static. tyxtest does not run the code, and it does not plug into Vitest or Jest.

## Develop

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run build
node dist/cli.js --help
```

`npm test` runs the mechanical harness: config guards, surface ID backfill, p(pass) thresholds, escalation, chunk evidence, cache keys (including option order), unchanged-test skips, import-closure hashing, and setup's git files.

## Use

From a built checkout, point the command at a target repo (or run it from that repo after `npm link`):

```bash
node dist/cli.js setup
node dist/cli.js generate
node dist/cli.js index
node dist/cli.js run
```

`setup` writes `tyxtest/tyxtest.config.json`, adds `.env` and `.tyxtest/` to `.gitignore`, and sets `tyxtest/**/.index.json merge=ours` in `.gitattributes`. Inside a git checkout it also sets the local `merge.ours.driver` so those index files do not conflict.

Put API keys in the environment (or in a gitignored `.env`). The config file stores the variable name in `apiKeyEnv`, never the key. Values that look like `sk-...` are rejected.

`generate` only runs when `tyxtest/` has no surfaces yet. It reads `package.json` entry points (`main`, `bin`, `exports`) and the README, then proposes surfaces: screens for a web app, commands for a CLI, the public API for a library, endpoints for a server. `index` writes each surface's `.index.json`. `run` prints a report and writes `.tyxtest/results.json` and `.tyxtest/junit.xml`. It does not rewrite the index. With `ignoreUnchanged` (the default), a test runs only when its closure, its `surface.md`, or the lockfile differs from `baseRef` plus uncommitted changes.

Decision runners use `typesafe` (Jev, or Laya via `LAYA_BASE_URL`) and OpenAI Decisions. LLM providers are `anthropic`, `openai`, and `ollama`. Ollama does not need a key. Set `OLLAMA_HOST` if it is not on `http://127.0.0.1:11434`. A model name of `jev` is sent as `jev-latest`.
