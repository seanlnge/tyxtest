# Apply pending suggestions

`tyxtest index --pending` reindexes only the surfaces a previous run flagged as possibly stale, then clears those suggestions. Runs record suggestions in the gitignored `tyxtest/.pending.json`; this command is how a developer turns them into a committed index change.

## Suggestions are stored in tyxtest/.pending.json with a fixed shape

Runs write suggestions to `tyxtest/.pending.json`. The block below shows the exact shape: an object with a `suggestions` array, written as two-space-indented JSON with object keys in alphabetical order. `surface` is the surface path relative to `tyxtest/`, `testId` is the test's internal id, `reason` is a short label, and `detail` is optional explanatory text. The values in the example are illustrative.

```json
{
  "suggestions": [
    {
      "detail": "Proposed index update: Run does not rewrite surface indexes now lives in src/commands/run.ts.",
      "reason": "index may be stale",
      "surface": "run",
      "testId": "3f9a1c0d5e72"
    }
  ]
}
```

> The file is local scratch state and is listed in `.gitignore`. Suggestions are sorted by the combined `surface/testId` string, and a suggestion with the same surface, test, and reason as an earlier one replaces it.

## Index pending only processes surfaces listed in the pending suggestions

With `--pending`, only surfaces that appear in `tyxtest/.pending.json` are reindexed. Surface arguments narrow that set further, and the surfaces that are not flagged keep their existing index records unchanged.

## Index pending reindexes the whole flagged surface

Every test in a flagged surface is sent to the index model again, not only the tests named in a suggestion. The model also receives a "Pending suggestions" section listing each flagged test's id and its `detail` (or `reason` when no detail was recorded).

## Index pending avoids model calls when there are no suggestions

If the pending file is missing, empty, or cannot be parsed as the expected JSON, the command logs "No pending index suggestions." and makes no model call. It still drops index records for surfaces that no longer exist.

## Successful indexing clears the pending suggestions for that surface

After a flagged surface is indexed, its suggestions are removed from `tyxtest/.pending.json`. Suggestions for other surfaces are kept, and when none remain the file is deleted.

## Index pending cannot be combined with fix

Passing both `--pending` and `--fix` fails with "Use either --fix or --pending, not both." and indexes nothing.
