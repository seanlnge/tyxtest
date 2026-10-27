# Run stale indexes

`tyxtest run` never repairs the index. When a test's mapping is missing, outdated, or points at code that has moved, run says so, reports the test as `unsure` instead of silently trusting old evidence, and leaves the fix to `tyxtest index`.

## Run reports unsure for a test with no current mapping

A test is reported as `unsure` without any model call when any of these is true: its surface has no index record for the test, the stored `claimHash` no longer matches the test's current heading and body, the test has no mapped chunks, or its source context is empty. The explanation tells the user to run `tyxtest index`, and the warning `index stale: test "<heading>" in "<surface>" has no current evidence mapping. Run \`tyxtest index\` to refresh it.` is printed.

For current indexes with claim hashes, new and edited tests therefore stay `unsure` until they are indexed. Legacy mappings without a claim hash, and flow-only mappings, do not have the same hash check.

## Run reports unsure when the surface context changed

Each surface's index records a `contextHash` of its ancestor context. If it no longer matches, run prints `index stale: semantic context for "<surface>" changed. Run \`tyxtest index\` to refresh it.` and reports every test in that surface as `unsure`.

## Run refreshes selected source without expanding the index mapping

The runner reads selected declarations and explicit context fresh from disk. A previous closure snapshot never adds files to model input, and adding an unindexed caller or dependency does not widen a test's source. Renamed mapped paths can be resolved using Git's rename information without rewriting the Markdown or index. Missing selected code is reported as a stale mapping rather than replaced with unrelated source.

## Run reports unsure when the relocate check finds the feature elsewhere

When a test fails, `relocateCheck` is true, the test is not a flow, and at least one indexed evidence symbol can no longer be found in the test's source context, run asks the index model whether the feature exists elsewhere in the repository. If it answers with a path, the test is reported as `unsure` with the explanation `Proposed index update: <heading> now lives in <path>.` If it says the feature was not found, the `fail` stands. A failure whose evidence symbols are all still present is not sent to the index model.

## Run suggests reindexing in a pending file when working locally

When a test turns out to have a stale index (the relocate check found the feature elsewhere, or an escalation LLM sets `indexStale`), run prints the warning `<surface>/<testId>: index may be stale; run \`tyxtest index --pending\`.` and, on a local machine, adds a suggestion to the gitignored `tyxtest/.pending.json`. Recording the suggestion does not itself change a verdict; the relocate check's own `unsure` result is described above.

## Run does not write pending suggestions in CI

When the `CI` environment variable is set to anything other than empty, `0`, or `false`, run prints the same stale-index warning but does not write `tyxtest/.pending.json`. A run never writes committed files.
