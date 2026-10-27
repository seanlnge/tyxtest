# Index command

`tyxtest index` maps every test to the code that implements it. The configured index model reads the test's heading and full Markdown body together with the repository source, and the result is written to the shared `tyxtest/.index.json`. Runs never write that file, so indexing is how new or edited tests become runnable.

## Index maps each test across the whole repository

The model maps each test to the concrete declarations needed to judge it: functions, components, classes, constants, and relevant caller or wiring symbols. Chunks may come from any JavaScript or TypeScript source file in the repository; nested surface folders never restrict the files. Dependencies and helpers needed to interpret a claim must be selected explicitly. Whole-file context is reserved for cases where the entire file is genuinely necessary, not used instead of mapping individual declarations.

## Index gives the model each test's heading and full body

The indexing request lists every test with its internal id, its heading, and its complete Markdown body (paragraphs, lists, examples, and code blocks), so notes and schemas reach the model along with the heading. It also contains the repository's source file inventory and the full text of every source file.

## Index gives the model the ancestor surfaces as context

The request includes the surface name and the chain of surfaces from the topmost ancestor down to the current one, each with its path, title, and description. Each ancestor also contributes the headings and bodies of its own tests. This tells the model what "payment" or "submit button" means for a nested surface without limiting which files it may map. Repository inventory and source may precede this context to enable prompt caching; their position does not change the required semantic context.

## Index stores a closure for each test

For each test, tyxtest records the mapped source-file paths and content hashes as a sorted closure snapshot, together with a `closureHash` and the heading-and-body `claimHash`. Only files explicitly referenced by the test's selected chunks and context, including its flow steps, belong to this snapshot. It does not expand static callers or imports. A stored snapshot is bookkeeping, not permission for the runner to send additional source. The surface's `contextHash` (a hash of the ancestor context text) is stored once in the surface's own record.

## Index records multi-step flows with their own chunks

If the model returns a flow for a test (a path made of steps), the steps are stored with their own chunks and context, and each step's chunks and context are included in that test's closure. Flows are kept only for tests that currently exist in the surface.

## Index replaces the mapping of every selected surface

Reindexing a surface rebuilds its records from the tests currently in its `surface.md`. Records for tests that were edited, renamed, or deleted are replaced or removed, and a surface that has no tests is stored as a surface record with no test records and no model call.

## Index prunes surfaces that no longer exist

Every time indexing writes the shared file, records for surfaces that no longer have a `surface.md` are dropped, even if those surfaces were not selected.

## Index limits work to the surfaces named on the command line

Except with `--fix`, positional arguments are surface paths. A surface is selected if its path equals an argument or is nested beneath it, so `tyxtest index index` also reindexes `index/apply-pending-suggestions`. With no arguments every surface is selected. If no surface matches, indexing fails with "No matching surfaces."

## Index fix reindexes every surface

`tyxtest index --fix` reindexes all surfaces and ignores any surface arguments, which regenerates the whole shared file after a merge. `--fix` cannot be combined with `--pending`; using both is an error.

## Index fails when there are no surfaces

After model configuration succeeds, if `tyxtest/` contains no `surface.md`, indexing fails with "No tyxtest surfaces found." Before failing it empties an existing index so records for deleted surfaces do not linger.

## Index logs each surface it indexes

After each surface is indexed, the command logs a line of the form `indexed <surface path>`.
