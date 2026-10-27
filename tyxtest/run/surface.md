# Run command

`tyxtest run` checks each product claim against its fresh indexed chunks and explicitly selected context, asks the configured models to judge the claim, prints a report, and writes JSON and JUnit results. It does not automatically follow imports or callers. It is read-only with respect to the index and the Markdown specifications.

## Run checks claims statically and never executes the product

Judging parses source files and sends only the indexed declarations and explicit context to the models. The command does not import, start, or execute the code under test, so runtime failures such as crashes or bad configuration values are not detected.

## Run never writes the index

`tyxtest run` does not write `tyxtest/.index.json` or edit any `surface.md`. The files it can create or update are `.tyxtest/results.json`, `.tyxtest/junit.xml`, the verdict cache `.tyxtest/verdict-cache.json`, and, on a local machine, `tyxtest/.pending.json` when it suggests a reindex.

## Run writes JSON and JUnit results

After the report, run writes `.tyxtest/results.json` and `.tyxtest/junit.xml` and prints their relative paths on lines starting `JSON:` and `JUnit:`.

`results.json` contains a `tests` array (one entry per judged or skipped test) and a `summary` object with `pass`, `fail`, `unsure`, and `skipped` counts. In the JUnit file each test is a `testcase` whose `name` is the test's internal id and whose `classname` is its surface path. A `fail` becomes a `failure` element, and an `unsure` also becomes one when `unsureBlocks` is true; otherwise an `unsure` is recorded as `system-out`. A skipped test is marked `skipped`.

## Run uses blocking verdicts for the completed-run exit status

After judgments complete successfully, the exit code is 1 when any test is `fail`, or when any test is `unsure` and `unsureBlocks` is true. Otherwise it is 0, including when some tests are `unsure` or skipped. Operational errors, such as invalid configuration or a failed command, can independently cause a non-zero CLI exit; they are not completed-run verdicts.

## Run limits work to the surfaces named on the command line

Positional arguments are surface paths; a surface is judged if its path equals an argument or is nested beneath one. With no arguments every surface is judged. If there are no surfaces, run fails with "No tyxtest surfaces found."; if the arguments match none, it fails with "No matching surfaces."

## Run normally fails for a surface that has no index

If a surface has no index records, run fails with `Surface "<path>" is not indexed. Run \`tyxtest index\` locally.`

When run is non-interactive (for example `--non-interactive`, or the `CI` variable is set) and the configuration sets `nonInteractive` to `search`, it instead asks the index model to pick the files for each test of that surface and judges them, and every such verdict is reported as `unsure` and is not cached.

## Run reuses cached verdicts

A verdict is reused without any model call when its cache key is unchanged. The key covers the test's id, heading, and body, the content and identities of its selected chunks and explicit context, the lockfile hash, the fixed option order, and a fingerprint of the models, thresholds, retry and escalation settings, and surface context. Editing an unmapped function or an unrelated file does not change this selected-code hash. Line-only shifts can reuse a verdict while updating its citation locations. The cache is stored in `.tyxtest/verdict-cache.json`.

Cached tests are left out of the report unless `--cached` is passed or `showCached` is true in the configuration; when shown they are marked `(cached)`.

## Run all ignores the cache and unchanged skips

`tyxtest run -A` (or `--all`) judges every selected test again. It skips both the verdict cache lookup and the Git-based unchanged filter.

## Run can skip tests that Git shows as unchanged

When `ignoreUnchanged` is true, run compares the working tree to `baseRef` (default `origin/main`) and also counts untracked files. Tests with stale or missing mappings are reported unsure before the skip check. Otherwise, a test is considered for judgment only if the diff touches a file explicitly selected by its mapping, its `surface.md` or an ancestor's `surface.md`, or a lockfile. Other tests get the verdict `skipped` with the explanation `skipped (unchanged)`. A considered test may still reuse a cached verdict if its selected code has not changed; unrelated callers and imports do not become model input.

If Git cannot diff against `baseRef`, run fails with a message to set `baseRef` or turn `ignoreUnchanged` off.
