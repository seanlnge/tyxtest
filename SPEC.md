# tyxtest

Oct 25, 2026 · @Sean Lange

tyxtest is a JS/TS test framework where tests describe the product, not the implementation. Instead of asserting "the button in the form's bottom div calls submit on click," a tyxtest test says "there is a submit button in the form," and an LLM checks that claim against the source code. It runs alongside Vitest or Jest: unit tests verify code, tyxtest verifies the product.

## Surfaces

Tests are grouped by product surface, not by file. Each folder in `tyxtest/` is one surface, and nested folders are surfaces within it. The folder is committed with the repo.

```
tyxtest/
  tyxtest.config.json
  login-page/
    surface.md
    .index.json
    login-form/
      surface.md
      .index.json
      submit-button/
        surface.md
        .index.json
```

`surface.md` is written by people. Frontmatter names the surface and can point to its entry file. Each bullet is one test with a stable ID:

```markdown
---
surface: Login form
description: Email/password form on /login
entry: src/pages/login.tsx
---
- [submit-exists] There is a submit button in the form
- [email-validated] Email is validated before submit
```

If a test has no ID, tyxtest generates a slug and writes it back. The ID keys caching and verdict history, so rewording a test reruns only that test.

## Indexing

`tyxtest index` maps each surface to the code that implements it, using the configured index model (the more capable one). The result goes in that surface's `.index.json`: the files and symbols it touches, notes on what to watch for, and hashes of everything it depends on.

1. **Find the entry.** If `entry:` is set, use it. If not, behavior depends on `entryMode`:
   - `ask-plain` (default): the CLI asks a plain-language question ("Where does the login form live?") and the model resolves the answer to files.
   - `ask-entry`: the CLI asks for a file path.
   - `required`: missing `entry:` is an error.
2. **Write the entry back** to `surface.md` frontmatter, so the mapping shows up as a reviewable diff in the PR.
3. **Scope children to parents.** A child surface is searched only within its parent's code, so "submit button" can't match a button in some other form.
4. **Build the closure.** The TS compiler API resolves the static import graph from the entry files. The full closure is stored in the index.

Re-indexing happens when a test changes, when code in the closure changes, or when someone runs `tyxtest index` to accept notes the runner proposed. Runs never write the index.

## Running and verdicts

`tyxtest run` sends each test to a decision model by default (Jev, Laya, or OpenAI Decisions), along with only the code in its closure. A decision model picks from fixed options and returns calibrated probabilities; it can't generate text. Jev costs $0.042 per million input tokens and answers in about 0.2s, so most tests never reach an LLM.

1. **Chunk.** The TS compiler API splits the closure into chunks by syntax, retaining named and anonymous exports, declarations, and top-level executable statements. Chunks are rebuilt every run and never stored, so code that grows or moves within the closure needs no handling. Oversized chunks are split only with their enclosing context preserved; conditions, signatures, and execution ordering must not be silently removed. `chunkMaxTokens` is a splitting target, not permission to truncate source: an indivisible or context-heavy chunk can exceed it.
2. **Verdict.** The decision model returns p(pass) for the test against its full fresh import closure, including callers and dependencies outside the indexed evidence symbols. The index selects evidence candidates, not the entire judgment context. Option order is fixed and part of the cache key, since probabilities can shift when the order changes.
3. **Evidence.** The model scores each chunk with a yes/no question: "does this chunk implement the claim?" The highest-scoring chunks are the evidence. Evidence is stored as symbol + content hash (e.g. `LoginForm.tsx#handleSubmit@a3f9`), not line numbers, and resolved to file:line only for display. Shifted lines don't break a citation, and a hash mismatch means the evidence itself changed. Locations come from tyxtest's chunker, not model output, so a citation can't be hallucinated.
4. **Threshold.** p(pass) maps to a verdict:

| p(pass) | Verdict | CI effect |
| --- | --- | --- |
| 0.9 or higher | pass | none |
| 0.1 or lower | fail | blocks |
| Between | escalate to LLM | depends on LLM result |

Escalated tests go to `escalateModel` if one is set, otherwise to the index model. Escalation should be rare, so no separate model is required. The escalation model returns `pass`, `fail`, or `unsure` with file:line citations, which the harness checks against the live source snapshot provided in that judgment, not old index hashes; an uncited `pass` becomes `unsure`. A non-pass gets 2 reruns: all 3 fail is a **fail** (blocks), and any fail short of that is **unsure** (warns).

With `escalate: false`, nothing escalates: a test between the thresholds is reported as `unsure` (warns), and no LLM is called during runs.

Escalated LLM judgments receive the full import closure for the test, not only its indexed evidence chunks. Flow-step escalations receive that step's closure.

Tests run in parallel, up to `concurrency` at a time (default 8). Per-chunk evidence calls within a test also run in parallel, and requests back off on provider rate limits.

Setting `runnerModel.kind` to `llm` skips the decision model and sends every test down the LLM path. Thresholds, rerun count, verdict rule, and whether `unsure` blocks are configurable. Output is printed by tyxtest's reporter and also emitted as JUnit/JSON for CI.

The reporter shows evidence only for `fail` and `unsure`. A passing test prints one line with its ID; `--verbose` shows its evidence too.

## Flow tests

Some tests span several surfaces, e.g. "from landing, the user reaches Stripe checkout in at most 5 clicks." One decision model call can't follow a multi-hop path, so `tyxtest index` detects these and decomposes them. No special syntax is needed; a flow test lives in the surface that contains every step (here, the landing page flow).

1. **Index time.** The index model traces the path once and stores it as steps in `.index.json`: landing has a CTA to /pricing, pricing has a plan button to /checkout, checkout's button creates a Stripe session and redirects.
2. **Run time.** Each step is an ordinary decision model check with its own evidence. The harness counts steps itself, so the model never does arithmetic.
3. **Step fails.** The path may have changed, e.g. a new modal was added. The index model re-traces it, the same way the relocate check works for a single surface.
4. **Closure.** The test's closure is the union of every step's closure, so a change anywhere on the path reruns it.

Limits:

- tyxtest stops at external boundaries. It can verify that the code redirects to Stripe, not what Stripe renders.
- Exact counts are fuzzy statically. Conditional modals, gates, and optional fields make "exactly 5" ambiguous; "at most 5" is checkable as path length.
- Runtime state is only visible when it's plain in code, e.g. an explicit auth check.

## Caching and git

Verdicts are cached per test, keyed by surface identity and description + test ID and text + closure hash + lockfile hash + indexed evidence identities + a versioned judgment-policy fingerprint. The fingerprint includes models, thresholds, retry/escalation policy, context settings, option order, and flow step semantics. A changed model, stricter threshold, or revised flow cannot reuse a verdict accepted under an older policy. Display-only settings do not invalidate verdicts. When the judgment inputs are unchanged, the last verdict is reused and the model isn't called.

The closure covers the full import graph, not just the files listed in the index. If someone edits `Button.tsx` and `LoginForm.tsx` imports it, every surface that uses it reruns. `node_modules` is covered by the lockfile hash, not walked. Depth is unlimited by default and can be capped in config.

Optional triage (`triage: true`, off by default): on a cache miss, the decision model scores whether the diff could change the test's claim. Below the triage threshold, a cached verdict with the same surface, claim, and judgment policy can be reused. Triage must not bypass policy invalidation. A wrong skip is a false green, so this is opt-in.

By default, `tyxtest run` uses the verdict cache rather than Git to decide whether a test needs a model call. When its cache key is unchanged, the prior verdict is reused. Set `ignoreUnchanged: true` to opt into Git-based skipping against `baseRef` (default `origin/main`) plus uncommitted changes. In that mode a test runs only if one of these changed:

- A file in its closure
- Its `surface.md`
- The lockfile

Every other test is reported as `skipped (unchanged)`. This opt-in mode works in CI without a persisted verdict cache, since the diff alone decides what runs.

## Stale indexes

Staleness is detected mechanically, before any model runs. Escalation is for uncertain verdicts, not stale maps.

| Change | Detection | Handling |
| --- | --- | --- |
| Code in the closure edited | Git diff hits the closure | Test reruns; index still valid |
| Import added or removed | Run-time closure recompute differs from the index | Run uses the fresh closure (TS compiler API, no model) and warns "index stale" |
| Entry file renamed or moved | `git diff -M` reports the rename | `entry:` updated automatically, with a warning |
| Entry file deleted | Path doesn't exist | Error: re-index the surface |
| Feature moved to another file still in the closure | Nothing to detect | Works unchanged |
| Feature moved outside the closure | Test fails and its evidence chunks are gone | Relocate check |

The relocate check (`relocateCheck`, on by default) separates a real regression from a stale map. The index model asks whether the feature exists elsewhere in the codebase. If it does, tyxtest proposes an index update and reports the test as `unsure`. If it doesn't, the `fail` stands. It only calls an LLM on that failure pattern, so it's rare.

Escalation also checks the index. In the same call, the escalation model answers whether the index looks wrong or incomplete for that test, so this costs no extra call. If it does, tyxtest records a reindex suggestion. Most escalations mean a claim is hard to judge, not that the map is stale, so escalated tests aren't reindexed by default.

Runs never write committed files. Suggestions go to `tyxtest/.pending.json`, which is gitignored:

- **Locally:** `tyxtest index --pending` reindexes only the flagged tests. You commit the result like any other index change.
- **In CI:** the suggestion appears as a run warning, e.g. "login-form/submit-exists: index may be stale; run `tyxtest index --pending`."

Git behavior:

- `surface.md` is authored and merges like normal code.
- `.index.json` is generated and treated like a lockfile: one small file per surface, sorted keys, no timestamps. `.gitattributes` sets `merge=ours` so git never blocks; `tyxtest index --fix` regenerates the file after a merge.
- In CI or any non-interactive run, an unindexed surface fails with "run `tyxtest index` locally." A PR that adds a surface has to include its index, the same way a dependency change includes the lockfile. `nonInteractive: "search"` opts into an agentic search instead, with verdicts marked `unsure`.

## Config

`tyxtest/tyxtest.config.json` is committed and never holds secrets. It names the env var a key lives in, never the key itself. Locally, keys come from `.env`; in CI, they come from repo secrets.

```json
{
  "indexModel":  { "provider": "anthropic", "model": "<strong model>", "apiKeyEnv": "TYXTEST_INDEX_KEY" },
  "runnerModel": { "kind": "decision", "provider": "typesafe", "model": "jev", "apiKeyEnv": "TYXTEST_RUN_KEY" },
  "escalate": true,
  "escalateModel": null,
  "thresholds": { "pass": 0.9, "fail": 0.1 },
  "ignoreUnchanged": true,
  "baseRef": "origin/main",
  "entryMode": "ask-plain",
  "maxQuestions": 5,
  "nonInteractive": "fail",
  "reruns": 2,
  "verdictRule": "worst",
  "unsureBlocks": false,
  "triage": false,
  "relocateCheck": true,
  "closureDepth": null,
  "chunkMaxTokens": 4000,
  "concurrency": 8
}
```

| Key | Default | Options |
| --- | --- | --- |
| `indexModel` | user-set | Any LLM provider. `apiKeyEnv` falls back to the provider's standard var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Local providers like Ollama need no key. |
| `runnerModel.kind` | `decision` | `decision` (Jev, Laya, OpenAI Decisions), `llm` |
| `escalate` | true | true, false. When false, tests between the thresholds report `unsure`. |
| `escalateModel` | off (uses `indexModel`) | Any LLM provider; used for tests between the thresholds |
| `thresholds` | pass 0.9, fail 0.1 | Any p(pass) cutoffs |
| `ignoreUnchanged` | false | true, false. When true, runs only tests affected by the git diff. |
| `baseRef` | `origin/main` | Any git ref |
| `entryMode` | `ask-plain` | `ask-plain`, `ask-entry`, `required` |
| `maxQuestions` | 5 | Any integer. Max questions generate asks per run; 0 never asks. |
| `nonInteractive` | `fail` | `fail`, `search` |
| `reruns` | 2 | Any integer; applies to escalated tests |
| `verdictRule` | `worst` | `worst` (all attempts must agree), `majority` (strict majority; ties are unsure), `best` (any pass wins; fail only when all attempts fail) |
| `unsureBlocks` | false | true, false |
| `triage` | false | true, false |
| `relocateCheck` | true | true, false. Uses the index model when a failing test's code has moved. |
| `closureDepth` | unlimited | Integer hop limit. Chunk size cap: chunkMaxTokens, default 4,000. Parallel tests: concurrency, default 8. |
| `guards.literalKeyCheck` | on | Errors if a config value looks like a literal key (`sk-...`) |
| `guards.gitignoreEnv` | on | `tyxtest setup` adds `.env` to `.gitignore` |

## Setup and test generation

`npx tyxtest setup` installs tyxtest and configures it. If it's already installed, `tyxtest setup` does the same. Setup asks for:

1. Index model and runner model (a decision model by default). The escalation model is optional.
2. The env var name for each key. Setup checks that the var is set and warns if it isn't.
3. `entryMode`.
4. Whether to generate tests now.

It then creates `tyxtest/` and `tyxtest.config.json`, adds `.env` to `.gitignore`, and adds the `.gitattributes` merge rule for `.index.json`. If you answer yes to step 4, it runs `tyxtest generate`.

`tyxtest generate` creates the first set of tests for a codebase with none. It only runs when `tyxtest/` has no surfaces and refuses otherwise.

1. The index model reads the project's entry points (`package.json` `main`, `bin`, and `exports`, plus the README) and works out what the software does for its users. It proposes a surface tree with tests for each surface. For a web app, surfaces are screens; for a CLI, commands; for a library, its public API; for a server, its endpoints.
2. The CLI shows the proposed tree. You accept, edit, or drop surfaces before anything is written.
3. tyxtest writes each `surface.md` with `entry:` and test IDs filled in, then runs `tyxtest index` on the result.

`generate` asks questions only when it's stuck: an ambiguous mapping (two components could be "the login form") or a feature whose intended behavior isn't clear from the code. Questions are batched into one prompt after the scan, capped at `maxQuestions` (default 5). A nonblank answer is sent back to the index model to revise the proposal before acceptance; a blank answer keeps the guesses. There is no additional question loop. Past the cap, it takes its best guess and flags it in the review step. Non-interactive runs follow `nonInteractive`. Normalized surface paths must be unique, and all accepted entries are validated before any surface is written, so a colliding proposal cannot overwrite accepted tests.

## Scope

v1 is a standalone CLI (`tyxtest setup`, `tyxtest generate`, `tyxtest index`, `tyxtest run`) for JS/TS codebases. It does not:

- Run the code. Checks are static, so runtime breakage (a crash, a bad config value) is left to unit and E2E tests.
- Replace Vitest or Jest, or plug into them.
- Support languages without a TS compiler API module graph.
