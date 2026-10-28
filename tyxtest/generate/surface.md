# Generate command

`tyxtest generate` creates the first set of tests for a codebase that has none. The index model reads the project's entry points and sources, proposes a tree of product surfaces with tests, the user reviews it, and tyxtest writes the `surface.md` files and indexes them.

## Generate refuses to run when surfaces already exist

If any `surface.md` is already discovered under `tyxtest/`, generate stops before loading the configuration or calling any model. It fails with a message that `tyxtest generate refuses to run because tyxtest/ already has surfaces` and that it only creates the first set of tests. Existing files are not changed.

## Generate needs a terminal unless the proposal is auto-accepted

When there is no interactive terminal, generate fails with a message to re-run with `--yes`, unless `--yes` was passed or the configuration sets `nonInteractive` to `search`. Either of those two conditions accepts the proposal without prompting.

## Generate sends the project brief and sources to the index model

The request to the index model contains the `package.json` fields `name`, `description`, `main`, `bin`, and `exports`, up to the first 8,000 characters of the README (`README.md`, `readme.md`, or `README`), the list of repository source files, and a sample of source text. The sample is taken from router-style files (for example `app/**/page.tsx`, `pages/**`, `src/routes/**`, or `router.ts`) when any exist, otherwise from the first source files, and is limited to 20 files.

## Generate proposes surfaces and tests as a tree

The model replies with JSON describing surfaces, each with a slug, a name, a description, tests (heading text plus a Markdown body), optional child surfaces, and optional questions. Child surfaces are placed in a subfolder of their parent surface's folder. Folder names are slugs: lowercase letters and digits separated by single hyphens, at most 60 characters.

## Generate shows the proposed tree before writing anything

The proposal is printed as an indented tree: one line per surface with its path and name, and one line per test heading beneath it. In an interactive session the user is then asked whether to accept, drop, or edit the proposal; the default is accept. Choosing drop removes the listed surfaces (and their children). Choosing edit goes surface by surface, letting the user keep a surface, drop it, or edit its tests, where each test can be kept, dropped, or given a new heading. An unrecognized choice is an error. When the proposal is auto-accepted, the tree is printed and written without a prompt.

## Generate asks stuck questions in one capped batch

Questions the model returns are put to the user together in a single prompt, limited to `maxQuestions` (default 5) with the model's guess shown next to each. Questions beyond the cap are not asked; they are flagged in the output as `over maxQuestions` along with the guess. When `maxQuestions` is 0 nothing is asked. When the proposal is auto-accepted (`--yes` or `nonInteractive: "search"`), nothing is asked either and each question within the cap is logged as a `guess:` flag with the model's guess.

## Generate revises the proposal once when a question is answered

If the batched answer is not blank, it is sent back to the index model together with the original proposal to produce a revised proposal, and any questions still unresolved are flagged. A blank answer keeps the model's guesses and makes no second model call. There is no further question loop.

## Generate writes surface files with a title, description, and test sections

Each accepted surface is written to `tyxtest/<path>/surface.md`. The file starts with the surface name as an H1, then the description if there is one, then each test as a heading at the configured test heading level (H2 by default) followed by its Markdown body. When a discovery prefix is configured, it is added to each heading automatically, and with bullet mode each test becomes a top-level bullet with its body indented beneath it.

No entry fields, frontmatter, ID markers, or hidden comments are written.

## Generate validates every surface before writing any

Before any file is written, generate rejects colliding normalized surface paths and validates accepted surface titles and retained test headings as nonempty single lines. It also checks that rendering preserves the number of tests and their bodies, rejecting unintended heading boundaries. Empty proposed test headings are discarded during flattening rather than rejected.

## Generate fails when every surface is dropped

If the accepted tree is empty after the user drops surfaces, generate fails with "No surfaces left to write." and writes nothing.

## Generate indexes the surfaces it writes

After writing, generate logs how many surfaces it wrote (`wrote N surface` or `wrote N surfaces`) and then runs the same indexing as `tyxtest index` over the new surfaces, using the same configuration and model, so the shared `tyxtest/.index.json` is created without a separate command.

## Orders a pizza

The command immediately orders a pizza once complete
