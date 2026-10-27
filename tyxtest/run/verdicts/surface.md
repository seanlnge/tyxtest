# Run verdicts

How `tyxtest run` turns a test and its source context into `pass`, `fail`, or `unsure`: a decision model scores the claim, uncertain results escalate to an LLM, and a few safeguards keep citations honest.

## Run sends the test heading and full body to the models

For an ordinary test judgment, the model receives the surface name and its description (including ancestor surface context), the test heading as the claim, and the test's complete Markdown body as the specification. Paragraphs, lists, examples, and code or schema blocks in the body are included in verdict and evidence requests. Flow-step requests use the step text as the claim while retaining the original test body.

## Run judges each test against its own fresh source context

The runner reads the test's indexed declarations fresh from disk and sends those chunks plus any explicitly indexed context. It never adds static callers, imports, dependencies, or paths from a previous closure snapshot. Unmapped functions in an indexed file are excluded unless that entire file was explicitly selected as context. A flow step receives only its own selected chunks and context, together with any explicitly test-wide context.

## Run asks the decision model one pass-or-fail question per test

The decision runner gets one batched request containing a verdict question with the options `pass` then `fail` in that fixed order, followed by one yes-or-no evidence question for each of the test's chunks. The reported pass probability is its p(pass) answer, and it is compared with `thresholds.pass` and `thresholds.fail` from the configuration: p(pass) at or above the pass threshold (0.9 by default) is a pass, at or below the fail threshold (0.1 by default) is a fail, and anything between is unsure.

## Run shows the highest-scoring chunks as evidence

For a decisive attempt, the chunk or chunks with the highest yes score for the claim become the test's evidence, reported as `file:line` locations taken from tyxtest's own chunker rather than from model output.

## Run retries ordinary decision-model non-passes up to reruns times

An ordinary decision-model test is attempted once, then retried up to `reruns` more times (default 2, so up to three attempts) while the attempt is not a pass. The first pass stops the retries. LLM judgments and flow steps do not use this attempt loop.

## Run combines attempts with the verdict rule

The attempts are combined using `verdictRule`:

- `worst` (default): all attempts must agree to pass or fail; a mix of pass and fail, or any unsure, is unsure.
- `majority`: a strict majority of attempts must pass or fail; ties are unsure.
- `best`: any pass wins, and the result is a fail only if every attempt failed.

## Run escalates an unsure result to the escalation model once

When the combined result is unsure and `escalate` is true, one LLM judgment is requested with the same selected source bundle. That LLM is `escalateModel` when configured, otherwise the index model. Its single verdict is the test's result; rate-limited requests can be retried with backoff. Escalation does not widen the indexed evidence.

## Run reports unsure instead of escalating when escalation is off

With `escalate` set to false, a combined unsure result is reported as `unsure` without any LLM call. When every attempt landed between the thresholds the explanation lists the p(pass) values and says they are between the thresholds.

## Run downgrades an uncited LLM pass to unsure

An LLM judgment replies with a verdict, `file:line` citations, an explanation, and an `indexStale` flag. A `pass` is kept only if it has at least one citation and every citation points to an integer line within a selected source range actually supplied to the model; otherwise the verdict becomes `unsure`. Merely naming an existing file is not enough to authorize citations to omitted functions. All lines of an explicitly selected whole-file context are available as citation targets.

## Run falls back to the escalation model when the decision API fails

If the decision request throws an error, run asks the escalation model for one verdict instead, with the same selected source bundle, and records that the test fell back so the report can note it, provided `fallback` is true (the default). If `fallback` is false the error stops the run. Fallback does not add files or declarations to the evidence.

## Run supports LLM-only judgments

With a supported LLM runner configuration and `runnerModel.kind` set to `llm`, fresh judgments of valid mapped ordinary tests go directly to that LLM using their selected source bundle and the same citation check. Multi-step flows skip decision requests too: each valid mapped step is judged by the LLM with that step's selected source. Cache reuse and unchanged skips can avoid a fresh judgment. Missing or stale mappings remain `unsure` without inventing or widening evidence.

## Run checks a flow's step count against an at most limit

For an indexed multi-step flow, if the test heading contains `at most N` and the flow has more than N steps, the flow check fails with an explanation that the path has that many steps, before requesting step judgments. Optional triage can occur earlier. Otherwise each step is judged with its own selected source and evidence; a failed step normally makes the test fail, subject to the relocate check, while an unsure step makes it unsure and all passing steps make it pass.

## Run judges tests in parallel up to the concurrency limit

Tests are judged concurrently with at most `concurrency` tests in progress at a time (default 8), and model requests that fail with an HTTP 429 or "rate limit" error are retried with doubling delays, up to four attempts in total, before the error is raised.
