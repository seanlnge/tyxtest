# tyxtest

tyxtest checks product claims against a TypeScript codebase. A test says what the product does ("there is a submit button in the form"). By default a decision model scores that claim against its fresh import closure, not just the indexed evidence symbols. Chunks retain top-level executable code and the enclosing context needed to interpret split functions and classes. Indexed symbols select evidence, not the complete code used for a verdict. Write a claim as `- [id] the product does this` or as `- the product does this`. Indexing assigns a stable hash ID to claims without one and writes it into `surface.md`. Jev reruns every non-pass up to `reruns` times, stopping early on pass. An LLM runs once when the aggregated Jev verdict is unsure, when the decision API fails, when a failing test's evidence chunks are gone (`relocateCheck`, on by default), or when `runnerModel.kind` is `llm`. The escalation model does not rerun. A run never writes `.index.json`. Suggestions go to gitignored `tyxtest/.pending.json` and are applied with `tyxtest index --pending`. In CI that suggestion is a warning only.

Checks are static. tyxtest does not run the code, and it does not plug into Vitest or Jest.

Verdict caching includes a versioned judgment context: surface identity and description, claim, model configuration, judgment policy, indexed evidence, and flow semantics, as well as the live closure and lockfile hashes. Changing the model or pass threshold cannot reuse a verdict accepted under a different policy. LLM citations are checked against the current source snapshot supplied to the model, so an edited file does not require reindexing just to make its citations valid.

`chunkMaxTokens` is an evidence-splitting target, not a total-request token budget. A chunk retains its enclosing declaration or file when dropping that context would change its meaning, even if that exceeds the target. Verdicts receive each live closure file once; large closures can still exceed provider context limits.

## Develop

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run build
node dist/cli.js --help
```

`npm test` runs the mechanical harness: config guards, surface ID backfill, p(pass) thresholds, escalation, chunk evidence and identity, cache keys (including option order), unchanged-test skips, stale indexes (import drift, entry rename, deleted entry, relocate check), pending suggestions, flow step counts, concurrency, rate-limit backoff, generate's question cap, import-closure hashing, and setup's git files.

## Use

From a built checkout, point the command at a target repo (or run it from that repo after `npm link`):

```bash
node dist/cli.js setup
node dist/cli.js generate
node dist/cli.js index
node dist/cli.js run
node dist/cli.js run --help
```

`setup` writes `tyxtest/tyxtest.config.json`, adds `.env`, `.tyxtest/`, and `tyxtest/.pending.json` to `.gitignore`, and sets `tyxtest/**/.index.json merge=ours` in `.gitattributes`. Inside a git checkout it also sets the local `merge.ours.driver` so those index files do not conflict.

Put API keys in the environment (or in a gitignored `.env`). The config file stores the variable name in `apiKeyEnv`, never the key. Values that look like `sk-...` are rejected.

`generate` only runs when `tyxtest/` has no surfaces yet. It reads `package.json` entry points (`main`, `bin`, `exports`) and the README, then proposes surfaces: screens for a web app, commands for a CLI, the public API for a library, endpoints for a server. `index` writes each surface's `.index.json`. `run` prints a report and writes `.tyxtest/results.json` and `.tyxtest/junit.xml`. It does not rewrite the index. Before any model call, a closure whose import graph no longer matches the index is used fresh and reported as index stale, a renamed entry from `git diff -M` rewrites `entry:`, and a deleted entry is an error asking for a re-index. By default, runs reuse the verdict cache when its key is unchanged. Set `ignoreUnchanged: true` to opt into Git-based skipping for tests unaffected by changes from `baseRef` plus uncommitted changes. `tyxtest run -A` judges every selected test again and ignores both that skip and the verdict cache.

Decision runners use `typesafe` (Jev at `https://api.typesafe.ai/v1/systemone`, or Laya via `LAYA_BASE_URL`) and OpenAI Decisions. A Jev test sends the verdict and the evidence questions for that test's chunks in one request. Every non-pass is retried up to `reruns` more times (default 2, so three attempts); a pass stops early. `verdictRule` combines attempts: `worst` (default) requires agreement, `majority` requires a strict majority, and `best` lets any pass win. An unsure aggregate escalates once. LLM judgments receive the full test import closure rather than only the indexed chunks; flow-step escalations receive that step's closure. The escalation model does not rerun; its single verdict is the test result, and the report and the CI exit code use that verdict. The fallback after a decision API error and an LLM runner also each make one completion. `fallback` (default true) sends that test to the escalation model when the request fails. The escalation model defaults to the index model. The run notes the fallback at the end. Cached tests stay off the report unless `--cached` is set or `showCached` is true. The TypeSafe key belongs in `TYPESAFE_API_KEY`. Set `TYPESAFE_BASE_URL` to point the client at another System One host. LLM providers are `anthropic`, `openai`, and `ollama`. Ollama does not need a key. Set `OLLAMA_HOST` if it is not on `http://127.0.0.1:11434`. A model name of `jev` is sent as `jev-latest`.
