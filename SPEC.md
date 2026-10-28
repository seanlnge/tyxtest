# tyxtest

Oct 25, 2026 · @Sean Lange

tyxtest is a JS/TS test framework where tests describe the product, not the implementation. Instead of asserting "the button in the form's bottom div calls submit on click," a tyxtest test says "there is a submit button in the form," and an LLM checks that claim against the source code. It runs alongside Vitest or Jest: unit tests verify code, tyxtest verifies the product.

## Surfaces

Tests are grouped by product surface, not by file. Each folder in `tyxtest/` is one surface, and nested folders are surfaces within it. Nesting provides semantic context to the indexer and runner, never a source-file allowlist. A product surface and each of its tests may span unrelated repository files. The folder is committed with the repo.

```
tyxtest/
  tyxtest.config.json
  .index.json
  login-page/
    surface.md
    login-form/
      surface.md
      submit-button/
        surface.md
```

`surface.md` is a normal product specification written by people. A Markdown H1 supplies its human-friendly title, followed by an introduction. Each H2 section is one test: its title and complete body, including paragraphs, lists, blockquotes, deeper headings, examples, and fenced code or schema blocks. No frontmatter or entry file is required. Legacy `surface:` and `description:` fields remain readable; `entry:` no longer scopes source files.

```markdown
# Login form

Email/password form on /login.

## There is a submit button in the form

The button is enabled only when the form is valid.

## Email is validated before submit

Invalid addresses must not reach the submission handler.

- The user sees an inline validation error.
- Their other form values remain intact.
```

Discovery uses a standard Markdown syntax tree, not model-generated boundaries. A test ends at the next heading of the same or higher level; deeper headings stay in its body. Headings inside code, HTML blocks/comments, lists, and blockquotes are not test boundaries. Setext headings follow ordinary Markdown semantics. Schemas and examples are model-facing specification content, not executed validators; ordinary prose states whether an example is exact or approximate.

The default is `markdown: { "testDiscovery": { "mode": "headings", "headingLevel": 2, "prefix": null } }`. Heading depth is configurable from 2 through 6. Bullet specs use `markdown.testDiscovery.mode: "bullets"`; heading mode does not reinterpret introductory lists as tests. Legacy flat `markdown.tests` and `markdown.testHeadingLevel` settings remain readable and normalize to this nested shape; mixing the old and new keys is an error.

An optional `prefix` filters visible heading or bullet labels by a case-sensitive literal string, not a regular expression. With `prefix: "Test:"`, `## Test: Export respects filters` is a test and `## Background` is ordinary documentation. A nonmatching peer or higher-level heading still ends the selected test; a nonmatching top-level bullet also ends a preceding bullet test. Supporting nested bullets are never separate tests. Introductory documentation before the first selected test remains the surface description. The selected label omits its prefix for display and identity; generated specs add and, when necessary, Markdown-escape it. `null` disables filtering; blank or multiline prefixes and prefix-only test labels are rejected. There is no arbitrary delimiter language, hidden-comment bookkeeping, or model-controlled splitting.

Tests use internal content hashes instead of visible ID prefixes. The identity keys caching and verdict history; changing a heading or any of its body invalidates its mapping and judgment without writing IDs back into the Markdown. Generation preserves rich bodies and validates rendered documents before writing, rejecting content that would introduce unintended test boundaries.

## Indexing

`tyxtest index` maps each test to the code that implements it, using the configured index model (the more capable one). The result goes in the shared `tyxtest/.index.json`: per-test chunks, context files, source hashes, and optional flows. Individual records occupy single compact JSON lines within a formatted container, keeping diffs small and unrelated records independently mergeable. Existing indexes remain readable and migrate when indexing writes the shared file.

1. **Establish product context.** Read the ordered ancestor titles, descriptions, and claims, plus the current surface's title and description. This disambiguates a claim such as "submit button" without restricting source paths. Parent surfaces do not have to be indexed first.
2. **Find each test's code.** Search repository source and assign evidence chunks by path and symbol, plus any context files needed to understand wiring, registration, or callers. No surface entry is resolved or written.
3. **Select all necessary evidence.** The indexer explicitly maps relevant caller, routing, registration, and dependency symbols. It selects full `context` files only when necessary. The runner never follows imports/callers or inherits snapshot contents. Source can span arbitrary files regardless of surface nesting.
4. **Persist each test independently.** Store its chunks, context, closure snapshot, and claim hash in its own record. Flow steps own their chunks and context too, without requiring step entries.

The index prompt includes exact selectable path/symbol pairs from the same chunking semantics used by the runner, including anonymous defaults, file-execution chunks and supported focus aliases, with approximate rendered character/token sizes. Import bindings are not declaration definitions. The indexer must explicitly select necessary helper functions, literal/schema constants, caller arguments/default role choices, and decision/LLM/flow branches. Prefer concise sufficient chunk sets with empty context, not full files in place of independently mappable declarations. A few chunks or roughly 5k tokens is a preference, not a truncation limit.

Before symbol validation, selected imported or forwarded export bindings are canonicalized through exact TypeScript module/import/export provenance when it resolves unambiguously to a selectable declaration within the source inventory. Named aliases, supported defaults and barrel re-exports retain the defining declaration's path/symbol, with a logged normalization. This is resolution of the same explicitly selected value, never automatic dependency/caller expansion or a global-name guess. Type-only/external/ambiguous bindings, unsupported namespaces, absent provenance and values without a selectable declaration are not normalized; they remain subject to bounded repair. No whole-file fallback is introduced.

Every claim requires a nonempty ordinary mapping or a flow whose steps each have nonempty valid evidence. Nonempty context or whole-file execution chunks require response-only `wholeFileReason` justification and produce cost warnings. Invalid references, missing coverage, malformed responses, and model-indicated `missingDependencies` trigger at most one extra full-source repair completion per surface. Validation determines the problematic claim ids; only those claims appear in the repair test list, while the stable source/inventory/semantic prefix is retained. Valid first-response mappings are immutable during repair. Only requested ids are merged, replacing both ordinary and flow counterparts to permit switching; attempts to alter other claims or unknown ids are ignored. The full merged result is revalidated before persistence. A malformed initial response with no attributable claim ownership repairs all claims. Unresolved errors abort before the final index write; pending suggestions are cleared only after successful persistence. A genuinely undiscoverable implementation may instead be explicitly marked `unmappable` with a reason; it persists as an empty mapping with an index note and coverage diagnostic. Run still submits the test to its configured runner, explicitly stating that no related implementation was discoverable, without invented evidence or per-chunk evidence questions. Decision verdicts use the normal thresholds without an empty-mapping override; LLM passes retain citation validation. Empty mappings bypass Git unchanged-source skipping but retain verdict caching. Missing selected source is still a stale mapping and remains unsure. These quality fields are model-response metadata, not additions to the stored schema. Symbol validation is mechanical and cannot guarantee semantic sufficiency by itself.

`run` automatically prepares new/edited authored claims before judging. Preparation indexes only missing or changed claim ids for each selected surface, preserving trusted unchanged tests/flows and pruning deleted claims without model calls. A tracked surface/ancestor semantic-context change refreshes all claims in that affected selected surface. Internal preparation targets exact surfaces, never expanding a single planned surface to unrelated descendants. Peer claims can supply context-only prose without becoming mapping targets or changing own-surface semantic hashes. Explicit `index`, `--fix`, and `--pending` retain full-surface semantics. Ordinary source edits are read fresh without reindexing; missing mapped source remains stale/unsure until explicitly repaired. Preparation can write the committed shared index, but judging current maps and all authored Markdown remain read-only.

Authored synchronization precedes cache/Git-skip decisions and forces refreshed claims to be judged on that run. Matching explicit-unmappable/empty maps do not trigger another index request. Existing legacy hashless ids, including flow-only records, retain their persisted compatibility behavior; newly written maps have claim hashes. Unchanged and deletion-only runs do not resolve an index client or require an unused index credential. Required indexing failures stop before judging or cache/report writes, and the shared index/pending transaction stays atomic across selected surfaces. Only successfully refreshed/deleted ids have pending suggestions cleared. Preparation logs its counts on stderr before live progress and reports provider usage separately as `index-model tokens`; phase-separated per-run baselines avoid attributing indexing to runner/fallback clients, including aliased injected clients.

`tyxtest index` explicitly rebuilds selected surface mappings and removes obsolete records. `run` automatically performs incremental authored-test synchronization first; explicit indexing remains useful for full rebuilds and stale source mappings that authored synchronization does not repair.

### Index terminology

- A **record** is an ordinary JSON object in the index's `records` array. `kind` distinguishes surface metadata, a test mapping, or a flow. One record occupies one line; a record is not itself a hash or a dependency relationship.
- **Chunks** are path/symbol references identifying a test's selected evidence. Their live source text is not stored in the index.
- **Context** explicitly authorizes sending a full source file, including wiring that cannot be selected more precisely. Step context is step-local; test context applies to every step.
- **Closure** is a snapshot of mapped source paths and file hashes for index bookkeeping. It is not a JavaScript lexical closure or authorization to include more code. Runtime cache input hashes cover rendered selected chunks and explicit context instead of snapshot hashes.
- **`claimHash`** fingerprints a test's heading and full Markdown body. It detects authored changes independently of source changes. It is not the short internal `testId`.
- **`contextHash`** fingerprints the semantic surface/ancestor context, so a changed parent meaning cannot silently reuse an older mapping or verdict.

Version-1 `closure` and `source` record kinds represented surface-level entry graphs. Legacy aggregate `closure`, `files`, `entry`, and flow snapshots never become explicit context on read or write. Without usable chunk mappings, legacy tests require reindexing. Existing version-2 explicit context is preserved, even when broad. The index model must select relevant callers and runtime wiring explicitly, preferably as precise chunks.

## Running and verdicts

`tyxtest run` sends each test to a decision model by default (Jev, Laya, or OpenAI Decisions), with only its fresh indexed chunks and explicit full context files, semantic ancestor context, and full test Markdown body. A decision model picks from fixed options and returns calibrated probabilities; it can't generate text. Jev costs $0.042 per million input tokens and answers in about 0.2s, so most tests never reach an LLM.

Native TypeSafe batches serialize selected code, semantic context and the full specification once per ordinary test or flow-step scope. Verdict and evidence questions explicitly reference their `state.scopeN`; evidence questions target a particular file/symbol/original source span, with other chunks serving only as context rather than substitute evidence. Each step scope contains only its selected chunks/context plus explicit test-wide context. Unique wire keys are allocated per batch from explicit shared object identity, not string extraction, label matching, or heuristic source deduplication, and no scope state is retained across test jobs. Question keys, choice criteria/option order and returned probability alignment are unchanged. Complete `DecisionRequest.state` text remains available for mocks and other providers, with optional typed `sharedState` scope/target metadata used only by native TypeSafe. Unstructured System One, OpenAI and Laya requests preserve their existing format. The cache judgment-policy version changes because evidence questions can now use the shared selected context; selected-input hashing, source ranges, line-shift citations, and no-fallback-caching remain unchanged.

1. **Chunk.** The TS compiler API rebuilds only mapped syntax chunks from fresh source. Git-renamed mapped paths are resolved without rewriting the index. Oversized split chunks retain their enclosing declaration; conditions, signatures, and execution ordering must not be silently removed. Original source line ranges accompany snippets. Missing symbols produce stale/unsure results, never whole-file fallback. A whole-file execution chunk must itself be explicitly selected by filename. `chunkMaxTokens` is a splitting target, not permission to truncate source.
2. **Verdict.** The decision model returns p(pass) against exactly the selected chunks and explicit context, never automatic callers, imports, dependencies, or prior snapshots. Option order is fixed and part of the cache key, since probabilities can shift when the order changes.
3. **Evidence.** The model scores each chunk with a yes/no question: "does this chunk implement the claim?" The highest-scoring chunks are the evidence. Evidence is stored as symbol + content hash (e.g. `LoginForm.tsx#handleSubmit@a3f9`), not line numbers, and resolved to file:line only for display. Shifted lines don't break a citation, and a hash mismatch means the evidence itself changed. Locations come from tyxtest's chunker, not model output, so a citation can't be hallucinated.
4. **Threshold.** p(pass) maps to a verdict:

| p(pass) | Verdict | CI effect |
| --- | --- | --- |
| 0.9 or higher | pass | none |
| 0.1 or lower | fail | blocks |
| Between | escalate to LLM | depends on LLM result |

Escalated tests go to `escalateModel` if one is set, otherwise to the index model. Escalation should be rare, so no separate model is required. The escalation model returns `pass`, `fail`, or `unsure` with file:line citations, which the harness checks against the live source snapshot provided in that judgment, not old index hashes; an uncited `pass` becomes `unsure`. A non-pass gets 2 reruns: all 3 fail is a **fail** (blocks), and any fail short of that is **unsure** (warns).

With `escalate: false`, nothing escalates: a test between the thresholds is reported as `unsure` (warns), and no LLM is called during runs.

LLM judgments, escalations, and fallbacks use the same selected source as decision verdicts. Citations to omitted lines, including unmapped symbols in a mapped file, are rejected. Deliberately oversized selections surface a sanitized provider diagnostic or configured fallback without truncation or a TypeSafe long-context-header retry. Fallback verdicts are not cached.

Tests run in parallel, up to `concurrency` at a time (default 8). Per-chunk evidence calls within a test also run in parallel, and requests back off on provider rate limits.

Setting `runnerModel.kind` to `llm` skips the decision model and sends every test down the LLM path. Thresholds, rerun count, verdict rule, and whether `unsure` blocks are configurable. Output is printed by tyxtest's reporter and also emitted as JUnit/JSON for CI.

The reporter nests surfaces under their parent directories and displays their human-friendly H1 titles. It shows evidence only for `fail` and `unsure`. A passing test prints one line with its claim, without an internal ID prefix; `--verbose` shows its evidence too. The footer colors pass, fail, and unsure counts green, red, and yellow, includes total elapsed time in blue brackets, and reports runner and fallback model token usage when available from the provider.

## Flow tests

Some tests span several surfaces, e.g. "from landing, the user reaches Stripe checkout in at most 5 clicks." One decision model call can't follow a multi-hop path, so `tyxtest index` detects these and decomposes them. No special syntax is needed; a flow test lives in the surface that contains every step (here, the landing page flow).

1. **Index time.** The index model traces the path once and stores it as steps in `.index.json`: landing has a CTA to /pricing, pricing has a plan button to /checkout, checkout's button creates a Stripe session and redirects.
2. **Run time.** Each step is an ordinary decision or LLM check with only its own chunks/context plus explicit test-wide context. Step verdicts, evidence, escalations and fallbacks never inherit other steps' code or snapshots. The harness counts steps itself, so the model never does arithmetic.
3. **Step fails.** The path may have changed, e.g. a new modal was added. The index model re-traces it, the same way the relocate check works for a single surface.
4. **Cache.** The test's input hash covers every step's selected chunks and context, so a mapped change anywhere on the path invalidates it without expanding any step's prompt.

Limits:

- tyxtest stops at external boundaries. It can verify that the code redirects to Stripe, not what Stripe renders.
- Exact counts are fuzzy statically. Conditional modals, gates, and optional fields make "exactly 5" ambiguous; "at most 5" is checkable as path length.
- Runtime state is only visible when it's plain in code, e.g. an explicit auth check.

## Caching and git

Verdicts are cached per test, keyed by surface identity and description + test ID and full Markdown body + selected evidence hash + lockfile hash + indexed evidence identities + a versioned judgment-policy fingerprint. The fingerprint includes models, thresholds, retry/escalation policy, context settings, option order, and flow step semantics. A changed model, stricter threshold, or revised flow cannot reuse a verdict accepted under an older policy. Display-only settings do not invalidate verdicts. When the judgment inputs are unchanged, the last verdict is reused and the model isn't called.

An unmapped function or unrelated file edit does not invalidate the verdict when selected evidence is unchanged. Selected symbol text, identity, and full explicit context content participate in the input hash. Line-only shifts update cached citations from fresh source spans without a paid judgment. Merely importing a changed file does not select it. `node_modules` is covered by the lockfile hash, not walked.

Optional triage (`triage: true`, off by default): on a cache miss, the decision model scores whether the current selected evidence could change the test's claim. It receives only the selected fresh source, semantic context and full test body, not whole-file diffs that could leak omitted code. Below the triage threshold, a cached verdict with the same surface, claim, mapping and judgment policy can be reused. Triage must not bypass policy invalidation. A wrong skip is a false green, so this is opt-in.

By default, `tyxtest run` uses the verdict cache rather than Git to decide whether a test needs a model call. When its cache key is unchanged, the prior verdict is reused. Set `ignoreUnchanged: true` to opt into Git-based skipping against `baseRef` (default `origin/main`) plus uncommitted changes. In that mode a test runs only if one of these changed:

- A selected chunk's file or an explicit context file (the content cache can still reuse unchanged selected evidence)
- Its `surface.md`
- The lockfile

Every other test is reported as `skipped (unchanged)`. This opt-in mode works in CI without a persisted verdict cache, since the diff alone decides what runs.

## Stale indexes

Staleness is detected mechanically, before any model runs. Escalation is for uncertain verdicts, not stale maps.

- Selected source edits are reflected in each test's fresh input hash; unmapped imports/callers do not expand model evidence or invalidate the content cache.
- Mapped files or symbols that are missing require refreshing the affected mapping; authored Markdown is never rewritten to repair an entry.
- Added or edited claims/notes, and changed semantic ancestor context, invalidate the relevant mappings rather than silently reusing stale evidence.
- Missing mapped evidence is stale/unsure before judgment and requires reindexing, without borrowing unrelated replacement code.

The relocate check (`relocateCheck`, on by default) separates a real regression from a stale map. The index model asks whether the feature exists elsewhere in the codebase. If it does, tyxtest proposes an index update and reports the test as `unsure`. If it doesn't, the `fail` stands. It only calls an LLM on that failure pattern, so it's rare.

Escalation also checks the index. In the same call, the escalation model answers whether the index looks wrong or incomplete for that test, so this costs no extra call. If it does, tyxtest records a reindex suggestion. Most escalations mean a claim is hard to judge, not that the map is stale, so escalated tests aren't reindexed by default.

Authored-spec preparation can update the committed shared index, including in CI. The judgment phase does not rewrite mappings or authored Markdown. Source-mapping suggestions go to `tyxtest/.pending.json`, which is gitignored:

- **Locally:** `tyxtest index --pending` reindexes only the flagged tests. You commit the result like any other index change.
- **In CI:** the suggestion appears as a run warning, e.g. "login-form/submit-exists: index may be stale; run `tyxtest index --pending`."

Git behavior:

- `surface.md` is authored and merges like normal code.
- `tyxtest/.index.json` is generated and treated like a lockfile: one shared file, deterministic records, no timestamps, and one compact line per test or artifact. Normal line-based merging preserves edits to different records; setup removes the old `merge=ours` rule, which could discard unrelated records. `tyxtest index --fix` regenerates the index after a merge.
- In CI or any non-interactive run, missing/new/edited authored mappings are indexed automatically before judging. This requires the index model's configuration and credential only when a model request is needed; errors fail clearly rather than reusing cached success. `nonInteractive` does not disable this preparation or force search-mode unsure verdicts; it retains its generation behavior.

## Config

`tyxtest/tyxtest.config.json` is committed and never holds secrets. It names the env var a key lives in, never the key itself. Locally, keys come from `.env`; in CI, they come from repo secrets.

```json
{
  "markdown": { "testDiscovery": { "mode": "headings", "headingLevel": 2, "prefix": null } },
  "indexModel":  { "provider": "anthropic", "model": "<strong model>", "apiKeyEnv": "TYXTEST_INDEX_KEY" },
  "runnerModel": { "kind": "decision", "provider": "typesafe", "model": "jev", "apiKeyEnv": "TYXTEST_RUN_KEY" },
  "escalate": true,
  "escalateModel": null,
  "thresholds": { "pass": 0.9, "fail": 0.1 },
  "ignoreUnchanged": true,
  "baseRef": "origin/main",
  "maxQuestions": 5,
  "nonInteractive": "fail",
  "reruns": 2,
  "verdictRule": "worst",
  "unsureBlocks": false,
  "triage": false,
  "relocateCheck": true,
  "chunkMaxTokens": 4000,
  "concurrency": 8
}
```

| Key | Default | Options |
| --- | --- | --- |
| `markdown.testDiscovery.mode` | `headings` | `headings`, `bullets`. Only explicitly configured bullets become tests in bullet mode. |
| `markdown.testDiscovery.headingLevel` | 2 | Integer 2 through 6. Deeper headings remain inside each test body. |
| `markdown.testDiscovery.prefix` | null | Optional case-sensitive literal label prefix, such as `Test:`. Omitted from displayed test names. |
| `indexModel` | user-set | Any LLM provider. `apiKeyEnv` falls back to the provider's standard var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Local providers like Ollama need no key. |
| `runnerModel.kind` | `decision` | `decision` (Jev, Laya, OpenAI Decisions), `llm` |
| `escalate` | true | true, false. When false, tests between the thresholds report `unsure`. |
| `escalateModel` | off (uses `indexModel`) | Any LLM provider; used for tests between the thresholds |
| `thresholds` | pass 0.9, fail 0.1 | Any p(pass) cutoffs |
| `ignoreUnchanged` | false | true, false. When true, runs only tests affected by the git diff. |
| `baseRef` | `origin/main` | Any git ref |
| `maxQuestions` | 5 | Any integer. Max questions generate asks per run; 0 never asks. |
| `nonInteractive` | `fail` | `fail`, `search` |
| `reruns` | 2 | Any integer; applies to escalated tests |
| `verdictRule` | `worst` | `worst` (all attempts must agree), `majority` (strict majority; ties are unsure), `best` (any pass wins; fail only when all attempts fail) |
| `unsureBlocks` | false | true, false |
| `triage` | false | true, false |
| `relocateCheck` | true | true, false. Uses the index model when a failing test's code has moved. |
| `chunkMaxTokens` | 4000 | Evidence-splitting target, not a source-context truncation limit. |
| `concurrency` | 8 | Maximum concurrent tests. |
| `guards.literalKeyCheck` | on | Errors if a config value looks like a literal key (`sk-...`) |
| `guards.gitignoreEnv` | on | `tyxtest setup` adds `.env` to `.gitignore` |

## Setup and test generation

`npx tyxtest setup` installs tyxtest and configures it. If it's already installed, `tyxtest setup` does the same. Setup asks for:

1. Index model and runner model (a decision model by default). The escalation model is optional.
2. The env var name for each key. Setup checks that the var is set and warns if it isn't.
3. Whether to generate tests now.

It then creates `tyxtest/` and `tyxtest.config.json`, adds `.env` to `.gitignore`, and removes the obsolete `merge=ours` rule so the shared index merges line by line. If you answer yes to step 3, it runs `tyxtest generate`.

`tyxtest generate` creates the first set of tests for a codebase with none. It only runs when `tyxtest/` has no surfaces and refuses otherwise.

1. The index model reads the project's entry points (`package.json` `main`, `bin`, and `exports`, plus the README) and works out what the software does for its users. It proposes a surface tree with tests for each surface. For a web app, surfaces are screens; for a CLI, commands; for a library, its public API; for a server, its endpoints.
2. The CLI shows the proposed tree. You accept, edit, or drop surfaces before anything is written.
3. tyxtest writes each `surface.md` with an H1 title, a prose description, and H2 test sections with complete Markdown bodies (or the explicitly configured bullet mode), then runs `tyxtest index` on the result. Neither entries nor internal claim hashes are written into the Markdown.

`generate` asks questions only when it's stuck: an ambiguous mapping (two components could be "the login form") or a feature whose intended behavior isn't clear from the code. Questions are batched into one prompt after the scan, capped at `maxQuestions` (default 5). A nonblank answer is sent back to the index model to revise the proposal before acceptance; a blank answer keeps the guesses. There is no additional question loop. Past the cap, it takes its best guess and flags it in the review step. Non-interactive generation follows `nonInteractive`; normal `run` authored preparation always indexes automatically. Normalized surface paths must be unique and are validated before any surface is written, so a colliding proposal cannot overwrite accepted tests.

## Scope

v1 is a standalone CLI (`tyxtest setup`, `tyxtest generate`, `tyxtest index`, `tyxtest run`) for JS/TS codebases. It does not:

- Run the code. Checks are static, so runtime breakage (a crash, a bad config value) is left to unit and E2E tests.
- Replace Vitest or Jest, or plug into them.
- Support languages without a TS compiler API module graph.
