# tyxtest

tyxtest checks product specifications against a TypeScript codebase. Each Markdown test section describes what the product does, with paragraphs, lists, examples, and code or schema blocks when useful. Tests own their evidence chunks and explicit source context, which can span arbitrary repository files. Nested surface folders provide product meaning, not file boundaries; no surface entry file is required. The indexer selects relevant symbols, including callers and wiring when needed. The runner sends only those fresh selected chunks and explicitly selected full context files, never automatic imports, callers, dependencies, or snapshot contents. Split chunks retain their enclosing declaration. Internal hash IDs stay out of the Markdown.

Jev reruns every non-pass up to `reruns` times, stopping early on pass. An LLM runs once when the aggregated Jev verdict is unsure, when the decision API fails, or when `runnerModel.kind` is `llm` (once per step for flows). Missing mapped evidence is stale/unsure before judgment and requires reindexing. The escalation model does not rerun. A run never writes `.index.json`. Suggestions go to gitignored `tyxtest/.pending.json` and are applied with `tyxtest index --pending`. In CI that suggestion is a warning only.

Checks are static. tyxtest does not run the code, and it does not plug into Vitest or Jest.

Verdict caching includes a versioned judgment context: surface identity and description, full test specification, model configuration, judgment policy, indexed evidence, and flow semantics, as well as the selected evidence content and lockfile hashes. Unmapped functions in a mapped file do not invalidate the cache when selected code is unchanged; cached citations follow line-only shifts using the fresh selected source spans. Changing the model or pass threshold cannot reuse a verdict accepted under a different policy. LLM citations must fall within a supplied chunk's original source lines or an explicit full context file, not merely somewhere in a mapped file.

`chunkMaxTokens` is an evidence-splitting target, not a total-request token budget. A split chunk retains its enclosing declaration when dropping that context would change its meaning, even if that exceeds the target. A file-context chunk must itself be explicitly mapped by filename. Missing symbols produce a stale/unsure result and require reindexing; they never fall back to a whole file. Deliberately large selections can still exceed provider context limits.

## Develop

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run build
node dist/cli.js --help
```

`npm test` runs the mechanical harness: config guards, Markdown titles/descriptions/notes and internal claim identities, p(pass) thresholds, escalation, per-test chunk/context maps, ancestor semantics, cache keys (including option order), unchanged-test skips, stale mappings and source changes, pending suggestions, flow step counts, concurrency, rate-limit backoff, generate's question cap, source-context hashing, and setup's git files.

## Use

From a built checkout, point the command at a target repo (or run it from that repo after `npm link`):

```bash
node dist/cli.js setup
node dist/cli.js generate
node dist/cli.js index
node dist/cli.js run
node dist/cli.js run --help
```

`setup` writes `tyxtest/tyxtest.config.json`, adds `.env`, `.tyxtest/`, and `tyxtest/.pending.json` to `.gitignore`, and removes the old index `merge=ours` rule so the shared index uses normal line-based merging.

Put API keys in the environment (or in a gitignored `.env`). The config file stores the variable name in `apiKeyEnv`, never the key. Values that look like `sk-...` are rejected.

`generate` only runs when `tyxtest/` has no surfaces yet. It reads package metadata and the README, then proposes surfaces: screens for a web app, commands for a CLI, the public API for a library, endpoints for a server. `index` writes the shared `tyxtest/.index.json`, keeping individual test and artifact records on single lines for compact, reviewable diffs. `run` prints a report and writes `.tyxtest/results.json` and `.tyxtest/junit.xml`. It does not rewrite the index or authored Markdown. Selected source is read fresh before judgment, including Git-renamed mapped files, without expanding the selection. By default, runs reuse the verdict cache when its key is unchanged. Set `ignoreUnchanged: true` to opt into Git-based skipping for tests unaffected by changes from `baseRef` plus uncommitted changes. `tyxtest run -A` judges every selected test again and ignores both that skip and the verdict cache.

Give each `surface.md` a human-friendly H1, followed by an introduction and H2 test sections. Frontmatter is not required. The H1 supplies the title shown in the nested run report. Existing frontmatter names and descriptions remain readable, but legacy `entry:` fields no longer limit source selection. Each test includes its complete Markdown body, not just a sentence.

````markdown
# Product export

Customers can export their product catalog.

## Exported records match the public schema

Every exported record must validate against this schema:

```json
{
  "type": "object",
  "required": ["id", "name"],
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" }
  }
}
```

Additional properties are allowed.

## Export respects active filters

Only products matching the current search and category filters are exported.
````

Tests end at the next heading of the same or higher level. Deeper headings, paragraphs, nested lists, blockquotes, and code blocks remain part of the test. Heading-like text inside code, HTML comments, lists, or blockquotes does not create tests. Discovery uses a Markdown parser, not a model. Code blocks are specification context sent to the models, not executed validators: state in prose whether a schema is exact or an example is approximate.

The default configuration is:

```json
{
  "markdown": {
    "testDiscovery": {
      "mode": "headings",
      "headingLevel": 2,
      "prefix": null
    }
  }
}
```

`markdown.testDiscovery.mode` accepts `"headings"` or `"bullets"`. `headingLevel` accepts 2 through 6 and selects the heading depth in heading mode. In bullet mode, top-level unordered bullets define tests and their indented content supplies supporting notes. Heading mode never guesses that prose bullets are tests.

`prefix` is an optional, case-sensitive literal filter on the visible test label, not a regular expression or an alternative delimiter. Set it to `"Test:"` to select only marked sections:

```markdown
## Background

This is ordinary surface documentation.

## Test: Export respects active filters

Only matching products are exported.

## Implementation notes

This is separate documentation, not part of the preceding test.
```

A nonmatching heading of the same or higher level still ends the previous test. In bullet mode the equivalent is `- Test: Export respects active filters`; nonmatching top-level bullets end the previous test too. Selected labels omit the prefix for display and identity. The generator adds the prefix automatically, escaping Markdown punctuation when needed. Use `null` to select all tests in the chosen mode. No hidden HTML markers or model-controlled splitting is involved.

Previously saved `markdown.tests` and `markdown.testHeadingLevel` settings are accepted and normalized to the new shape. Do not mix them with `testDiscovery`; newly written configuration uses only the nested settings.

For a test in `checkout/payment/`, the indexer sees the checkout and payment surface descriptions and ancestor claims. That tells it which payment is meant, but the mapped chunks can come from UI, API, validation, and routing files anywhere in the repository. Each test receives only its selected chunks and explicit context. The indexer must select relevant wiring to detect disconnections. Flow steps receive their own chunks/context plus explicit test-wide context, not other steps' evidence.

## Index Records

The index is a JSON container of typed records, not one source scope per surface:

- A **record** is one object in `records`, serialized on one line. Its `kind` identifies what it stores, such as surface metadata, a test map, or a flow.
- A **chunk** identifies selected evidence by source path and symbol. Source text is read fresh, not copied into the index.
- **Context** explicitly selects full source files, such as wiring or registration code. Prefer precise symbols in `chunks` when the whole file is unnecessary.
- A **closure** snapshot records mapped source paths and file hashes for index bookkeeping; it is not a JavaScript lexical closure or permission to send those files. Runtime cache hashing uses the selected rendered chunks and explicit context instead of snapshot file hashes.
- **`claimHash`** fingerprints the test heading plus its complete Markdown body. It detects edited specifications, not source changes, and is different from the short internal `testId`.
- **`contextHash`** fingerprints the semantic surface/ancestor context. Changing what a parent surface means requires refreshing affected test maps.

Version-1 surface-level `closure`/`source` records represented the old entry-based design. Legacy aggregate `closure`, `files`, `entry`, and flow snapshots remain bookkeeping only; reading or writing them never turns them into explicit `context`. Legacy records without usable chunks require reindexing. Existing version-2 explicit context selections remain explicit and may legitimately be broad; the runner does not silently remove them.

## Running

After adding or editing claims or their notes, run `tyxtest index` to refresh their mappings. Indexing synchronizes the current claims and removes obsolete records. `run` remains read-only: missing or outdated test mappings require reindexing rather than silently treating an old map as current.

The indexer receives an exact declaration inventory with approximate rendered sizes and must select actual defining symbols, not names imported into another file. It prefers concise, sufficient chunk sets with `context: []`, explicitly including necessary helpers, constants, caller arguments/defaults, and flow/LLM branches. A few chunks or roughly 5k tokens is a preference, never permission to omit relevant source. Full-file context and file-execution chunks require a model-provided `wholeFileReason` explaining why declaration chunks are insufficient; the CLI warns about whole-file selections and their size.

If a selected name is an actual imported or forwarded export binding in the specified file, indexing follows its exact TypeScript module/import/export provenance to a selectable declaration inside the source inventory and logs the normalized path/symbol. This resolves that same explicit selection, including supported aliases/defaults/barrel exports; it does not add dependencies or copy caller code. Duplicate names elsewhere are irrelevant. Names without provenance, ambiguous export chains, type-only or external bindings, unsupported namespace selections, and values requiring whole-file fallback remain invalid and use the bounded repair path. Stored code identity and citations point at the real declaration, not its caller-side alias.

Every current claim must have valid chunks, valid flow-step evidence, or an explicit `unmappable` explanation. Invalid symbols, missing claim/step maps, or model-indicated `missingDependencies` get at most one additional full-source repair request per surface. The repair test list contains only problematic claims; valid first-response mappings are retained and cannot be overwritten by the repair. Malformed initial responses without claim ownership request all claims again. Requested claim replacements can switch between ordinary and flow mappings, and the whole merged result must validate before persistence. Unresolved problems fail the indexing command without persisting any new maps or clearing pending suggestions. Explicitly undiscoverable implementations persist as empty maps with coverage diagnostics and index notes, so runs report unsure rather than inventing evidence. These response-only quality fields do not change the stored index schema. Mechanical validation proves that selected symbols exist, not that their semantics completely establish the claim; verdict verification remains necessary.

Decision runners use `typesafe` (Jev at `https://api.typesafe.ai/v1/systemone`, or Laya via `LAYA_BASE_URL`) and OpenAI Decisions. A Jev test sends the verdict and the evidence questions for that test's chunks in one request. Every non-pass is retried up to `reruns` more times (default 2, so three attempts); a pass stops early. `verdictRule` combines attempts: `worst` (default) requires agreement, `majority` requires a strict majority, and `best` lets any pass win. An unsure aggregate escalates once. Decision, triage, LLM, escalation, and fallback judgments all use only the selected fresh evidence and the semantic surface context plus full test body. Flow judgments, escalations, and fallbacks stay isolated per step. The escalation model does not rerun. `fallback` (default true) uses the escalation model when the request fails, with one completion per ordinary test or flow step. The escalation model defaults to the index model. The run notes the fallback at the end. Cached tests stay off the report unless `--cached` is set or `showCached` is true. The TypeSafe key belongs in `TYPESAFE_API_KEY`. Set `TYPESAFE_BASE_URL` to point the client at another System One host. LLM providers are `anthropic`, `openai`, and `ollama`. Ollama does not need a key. Set `OLLAMA_HOST` if it is not on `http://127.0.0.1:11434`. A model name of `jev` is sent as `jev-latest`.

Native TypeSafe requests share one complete code/specification scope between the verdict and its evidence questions. The selected source, semantic surface context, and full test body appear once in System One's object state; each question names its scope, and evidence questions name the exact file, symbol, and original source span. Flow steps have separate scopes with only their own selection plus explicit test-wide context. Scopes never merge across test jobs. This removes repeated evidence-question source without truncating or expanding selected code. `DecisionRequest.state` remains complete logical/debug text for injected clients and other providers; optional `sharedState` metadata explicitly identifies reusable scope objects and chunk targets. OpenAI, Laya, and unstructured requests keep their existing wire behavior. The judgment-policy version invalidates older cached verdicts, including triage reuse.

If TypeSafe rejects a deliberately large selected request with `max_tokens_exceeded`, tyxtest surfaces the error or uses configured fallback, without a long-context-header retry, silent truncation, or evidence expansion. Reports include a sanitized failure category and fallback verdicts are not cached, so the next run can retry the decision model. Older caches produced under the previous policy are invalidated. `node --import tsx test/measure-indexed-inputs.ts` measures actual native serialization at a fully offline fetch boundary in a disposable project copy; it does not overwrite real results or cache, and character counts are not provider token usage.
