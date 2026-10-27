# Run output

What `tyxtest run` prints: a tree of surfaces and tests, a summary footer with counts, elapsed time and token usage, and a list of findings for tests that need attention.

## Run output nests surfaces under their parent folders

Surfaces are printed as a directory tree that follows the folder structure under `tyxtest/`: a nested surface such as `index/apply-pending-suggestions` appears indented two spaces beneath `index`, not as a flat path. Each directory line ends with `/`, and each test is listed as a `- ` line beneath its own surface. A parent folder is printed whenever any of its descendants has visible tests, even if the parent has no tests of its own.

## Run output shows each surface's H1 title

Directory lines show the human-friendly H1 title from the surface's `surface.md` (for example `Index command/`), not the folder name. If a surface has no H1, its legacy frontmatter `surface:` name is used when present, otherwise its folder name. A folder with no `surface.md` is shown by its folder name.

## Run output lists tests by heading without ids

Each test line shows its verdict and its heading text only. The internal hash id and any configured discovery prefix are not shown. In the plain (non-live) report the line reads `- <verdict> <heading>`, with ` (cached)` after the verdict for reused verdicts that are being shown and `skipped (unchanged)` in place of a verdict for skipped tests.

## Run output shows live progress on an interactive terminal

When standard output is a terminal, each test row is shown with a spinner until its verdict arrives. Then the row shows the verdict, with `pass` in green, `unsure` in yellow, and `fail` in red, followed by the test's own duration in blue square brackets such as `[1.2 s]`. Long rows are truncated with an ellipsis to the terminal width, which defaults to 80 columns.

## Run footer colors the verdict counts

The first footer line has the form `N pass, N fail, N unsure`, with the pass count in green, the fail count in red, and the unsure count in yellow. When any tests were skipped, `, N skipped (unchanged)` follows. Colors appear only on an interactive terminal that supports color and when `NO_COLOR` is not set; output that is piped or captured is plain text.

## Run footer shows total elapsed time in blue brackets

The first footer line ends with the total elapsed time for the whole run in square brackets, colored blue when color is on, in the same style as the per-test durations. Times under one second are shown as whole milliseconds (`[850 ms]`), longer times as seconds with one decimal (`[12.4 s]`).

## Run footer reports runner and fallback token usage

The footer adds two lines, `runner tokens:` and `fallback-model tokens:`, each showing `<n> input, <n> output, <n> total` for the tokens used during this run. The runner line counts the decision or LLM runner. The fallback line counts the escalation model, which defaults to the index model, and shows zero when no escalation model client different from the runner was used. When the provider does not report usage, the line reads `unavailable`.

## Run footer states what blocks CI

The footer adds `fail blocks CI` when any test failed, and `unsure blocks CI` when any test is unsure and `unsureBlocks` is true.

## Run output lists findings for failures and unsure tests

After the footer, run lists findings for tests whose verdict is `fail` or `unsure`. Each finding starts with the verdict, the surface path, and the heading, then shows the cited `file:line` locations, then the explanation if there is one. Passing tests are left out of this list unless `--verbose` is set, and even then a passing test with neither evidence nor an explanation is not listed.

## Run output notes tests that fell back to another model

If any tests were answered by the fallback model after the decision API failed, the report ends with a line such as `1 test fell back to openai/gpt-6-luna after the decision API failed`, or `N tests fell back to ...` when there are several.
