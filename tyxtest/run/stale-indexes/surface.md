# Run stale indexes

`tyxtest run` automatically prepares mappings for new or edited authored tests and changed product context. It still refuses to invent evidence when a current mapping is explicitly unmappable or refers to missing source; those source-mapping problems remain visible instead of silently widening the input.

## Run does not repeatedly index a current unmappable test

A persisted test record whose claim hash and product-context hash are current can explicitly have no mapped implementation. Run sends the test to the configured runner with no code chunks and an explicit statement that no related implementation was discoverable, without asking the index model again on every invocation. The decision model's verdict uses the normal thresholds without requiring evidence chunks or forcing `unsure`; no per-chunk evidence questions are sent. Empty mappings are not skipped by Git's unchanged-source filter, though verdict caching still applies. A mapping whose selected declarations have disappeared instead remains `unsure` and is not replaced with unrelated code. The user can explicitly reindex when implementation or evidence is available.

New or edited claims are different: missing records and changed heading/body hashes trigger automatic indexing before judgment. Legacy mappings without a claim hash, and existing flow-only mappings, retain their documented compatibility behavior rather than being repeatedly reindexed solely for lacking newer metadata.

## Run refreshes affected mappings when the surface context changed

Each surface's index records a `contextHash` of its semantic surface and ancestor context. When that meaning changes, current code selections cannot simply be assumed to refer to the same product behavior. Run refreshes all affected claims of each selected surface before judging them, without requiring that its parent surface already have an index. Unselected surfaces retain their records.

## Run refreshes selected source without expanding the index mapping

The runner reads selected declarations and explicit context fresh from disk. A previous closure snapshot never adds files to model input, and adding an unindexed caller or dependency does not widen a test's source. Renamed mapped paths can be resolved using Git's rename information without rewriting the Markdown or index. Missing selected code is reported as a stale mapping rather than replaced with unrelated source.

## Run reports unsure when the relocate check finds the feature elsewhere

When a test fails, `relocateCheck` is true, the test is not a flow, and at least one indexed evidence symbol can no longer be found in the test's source context, run asks the index model whether the feature exists elsewhere in the repository. If it answers with a path, the test is reported as `unsure` with the explanation `Proposed index update: <heading> now lives in <path>.` If it says the feature was not found, the `fail` stands. A failure whose evidence symbols are all still present is not sent to the index model.

## Run suggests reindexing in a pending file when working locally

When a test turns out to have a stale index (the relocate check found the feature elsewhere, or an escalation LLM sets `indexStale`), run prints the warning `<surface>/<testId>: index may be stale; run \`tyxtest index --pending\`.` and, on a local machine, adds a suggestion to the gitignored `tyxtest/.pending.json`. Recording the suggestion does not itself change a verdict; the relocate check's own `unsure` result is described above.

## Run does not write pending suggestions in CI

When the `CI` environment variable is set to anything other than empty, `0`, or `false`, run prints the same source-staleness warning but does not write `tyxtest/.pending.json`. CI does not disable automatic preparation of new or changed authored-test mappings, which may update the shared index; judgments never rewrite authored Markdown or unrelated mappings.
