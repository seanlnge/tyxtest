# Setup command

`tyxtest setup` initializes tyxtest in a repository. It asks which models to use, writes the committed configuration file, and updates the repository's git files so secrets stay out of version control and the shared index merges line by line.

## Setup writes tyxtest/tyxtest.config.json

After the prompts are answered, setup writes `tyxtest/tyxtest.config.json` as two-space-indented JSON with a trailing newline, creating the `tyxtest/` folder if needed.

The file contains the chosen `indexModel`, `runnerModel`, and optional `escalateModel` (`null` when none was chosen), plus these defaults:

- `escalate: true`, `fallback: true`, `relocateCheck: true`, `triage: false`
- `thresholds` of `pass: 0.9` and `fail: 0.1`
- `ignoreUnchanged: false`, `baseRef: "origin/main"`, `nonInteractive: "fail"`
- `reruns: 2`, `verdictRule: "worst"`, `unsureBlocks: false`
- `maxQuestions: 5`, `chunkMaxTokens: 4000`, `concurrency: 8`
- `guards` with `literalKeyCheck` and `gitignoreEnv` both `true`

## Setup writes default heading-mode test discovery

The written configuration contains `markdown.testDiscovery` with `mode: "headings"`, `headingLevel: 2`, and `prefix: null`. A newly set up repository therefore treats every H2 section of a `surface.md` as one test.

## Setup stores environment variable names, never API keys

For each model whose provider is not `ollama`, setup asks for the name of the environment variable that holds its key and saves only that name as `apiKeyEnv`. The key value is never read into the config file. Ollama models get no `apiKeyEnv`.

The configuration is also checked by the literal-key guard before it is written, so any string value that looks like `sk-` followed by at least eight key characters makes setup fail instead of writing it.

## Setup rejects an invalid environment variable name

If the answer for a key variable is not a valid environment variable name (a letter or underscore followed by letters, digits, or underscores), setup fails with an error naming the invalid value and writes no configuration.

## Setup defaults each key variable to the provider's standard name

When the user presses enter at the key-variable prompt, setup uses the provider's standard variable: `ANTHROPIC_API_KEY` for anthropic, `OPENAI_API_KEY` for openai, and `TYPESAFE_API_KEY` for typesafe.

For providers with no standard variable (laya), the default depends on the role: `TYXTEST_INDEX_KEY` for the index model, `TYXTEST_RUN_KEY` for the runner model, and `TYXTEST_ESCALATE_KEY` for the escalation model.

## Setup warns when a named key variable is not set

If the environment variable the user names is not set in the current environment, setup prints a warning of the form `NAME is not set. Add it to .env locally or to the CI secrets.` and continues. The warning does not stop setup.

## Setup accepts only supported providers

The provider answers are normalized to lowercase and must be one of `anthropic`, `openai`, `ollama`, `typesafe`, or `laya`. Any other value makes setup fail with an "Unsupported provider" error.

## Setup defaults the runner to a decision model

The runner kind defaults to `decision` (a `llm` answer is also accepted; anything else is an error). For a decision runner the provider defaults to `typesafe` and the model name to `jev`. For an `llm` runner the provider defaults to `anthropic` and a model name must be supplied.

## Setup makes the escalation model optional

If the escalation provider prompt is left blank, no escalation model is configured and the config stores `escalateModel: null`. If a provider is given, setup also requires a model name and saves the escalation model with `kind: "llm"`.

## Setup adds ignore entries to .gitignore

Setup appends `.env`, `.tyxtest/`, and `tyxtest/.pending.json` to the repository's `.gitignore`, creating the file if it does not exist. Entries that are already present are not added a second time, and existing content is preserved.

## Setup removes the obsolete index merge rule from .gitattributes

Setup removes the `merge=ours` attribute from rules for `tyxtest/.index.json` or the old per-surface `tyxtest/**/.index.json` patterns, regardless of its position among other attributes. Unrelated attributes on the same rule, such as `text` or `eol=lf`, are preserved; a rule left with no attributes is removed. The old `# tyxtest index files merge like a lockfile` comment is also removed so the shared index uses normal line-based merging. Other rules are kept, and the file is deleted only if nothing remains.

## Setup offers to generate tests only when the user agrees

Setup finishes by asking "Generate tests now?" with a default of no. Only the answers `y`, `yes`, `true`, or `1` (case-insensitive) run `tyxtest generate` afterward; any other answer ends setup after the files are written.
