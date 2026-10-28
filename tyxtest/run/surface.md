# Run command

`tyxtest run` prepares mappings for new or changed authored tests, then checks each product claim against its fresh indexed chunks and explicitly selected context. It asks the configured models to judge the claim, prints a report, and writes JSON and JUnit results. It does not automatically follow source imports or callers and never rewrites the Markdown specifications.

## Run checks claims statically and never executes the product

Judging parses source files and sends only the indexed declarations and explicit context to the models. The command does not import, start, or execute the code under test, so runtime failures such as crashes or bad configuration values are not detected.

## Run keeps current mappings and authored Markdown unchanged during judgment

When selected authored-test mappings are already current, run does not rewrite `tyxtest/.index.json`. Its preparation phase can update the shared index to add or refresh authored claims and remove deleted claims; subsequent judgments never rewrite mappings or any `surface.md`. Normal report files are `.tyxtest/results.json` and `.tyxtest/junit.xml`, with the verdict cache in `.tyxtest/verdict-cache.json` and local source-reindex suggestions in `tyxtest/.pending.json`.

## Run writes JSON and JUnit results

After the report, run writes `.tyxtest/results.json` and `.tyxtest/junit.xml` and prints their relative paths on lines starting `JSON:` and `JUnit:`.

`results.json` contains a `tests` array (one entry per judged or skipped test) and a `summary` object with `pass`, `fail`, `unsure`, and `skipped` counts. In the JUnit file each test is a `testcase` whose `name` is the test's internal id and whose `classname` is its surface path. A `fail` becomes a `failure` element, and an `unsure` also becomes one when `unsureBlocks` is true; otherwise an `unsure` is recorded as `system-out`. A skipped test is marked `skipped`.

## Run uses blocking verdicts for the completed-run exit status

After judgments complete successfully, the exit code is 1 when any test is `fail`, or when any test is `unsure` and `unsureBlocks` is true. Otherwise it is 0, including when some tests are `unsure` or skipped. Operational errors, such as invalid configuration or a failed command, can independently cause a non-zero CLI exit; they are not completed-run verdicts.

## Run limits work to the surfaces named on the command line

Positional arguments are surface paths; a surface is judged if its path equals an argument or is nested beneath one. With no arguments every surface is judged. If there are no surfaces, run fails with "No tyxtest surfaces found."; if the arguments match none, it fails with "No matching surfaces."

## Run automatically indexes new and edited tests before judging them

Before looking up verdict caches or applying Git-based skips, run indexes selected claims that lack a mapping or whose stored claim hash does not match their current heading and body. A new surface is indexed the same way, with no separate `tyxtest index` command, including noninteractive and CI runs. Existing current claims and flow mappings are retained rather than sent to the index model again just because one test was added.

Successful preparation persists validated mappings before their first judgment. Indexing failures or missing index-model credentials stop the run clearly before judgment rather than hiding an unindexed test behind a cached success. Fresh unchanged mappings require no indexing call, and deleted claim records can be pruned without calling a model. Only selected run surfaces are synchronized.

## Run reuses cached verdicts

A verdict is reused without any model call when its cache key is unchanged. The key covers the test's id, heading, and body, the content and identities of its selected chunks and explicit context, the lockfile hash, the fixed option order, and a fingerprint of the models, thresholds, retry and escalation settings, and surface context. Editing an unmapped function or an unrelated file does not change this selected-code hash. Line-only shifts can reuse a verdict while updating its citation locations. The cache is stored in `.tyxtest/verdict-cache.json`.

Cached tests are left out of the report unless `--cached` is passed or `showCached` is true in the configuration; when shown they are marked `(cached)`.

## Run all ignores the cache and unchanged skips

`tyxtest run -A` (or `--all`) judges every selected test again. It skips both the verdict cache lookup and the Git-based unchanged filter.

## Run can skip tests that Git shows as unchanged

When `ignoreUnchanged` is true, run compares the working tree to `baseRef` (default `origin/main`) and also counts untracked files. New or refreshed authored mappings are prepared and judged before cache or unchanged filtering can hide them. A current mapping whose selected code is missing remains `unsure`. Otherwise, a test is considered for judgment only if the diff touches a file explicitly selected by its mapping, its `surface.md` or an ancestor's `surface.md`, or a lockfile. Other tests get the verdict `skipped` with the explanation `skipped (unchanged)`. A considered test may still reuse a cached verdict if its selected code has not changed; unrelated callers and imports do not become model input.

If Git cannot diff against `baseRef`, run fails with a message to set `baseRef` or turn `ignoreUnchanged` off.
