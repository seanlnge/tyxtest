# Index storage

The index is one shared, committed file, `tyxtest/.index.json`. It is generated like a lockfile: deterministic, free of timestamps, and laid out so that normal line-based git merging works record by record.

## Index is a single shared file at tyxtest/.index.json

All surfaces are stored together in `tyxtest/.index.json`, not in one file per surface. The file is a JSON object with `"version": 2` and a `records` array. When the shared file is written, any older per-surface `.index.json` files found in surface folders are deleted.

## Index writes each record on its own line

The file is a formatted container, but every record is serialized as compact JSON on a single line, indented four spaces and separated by commas, between `"records": [` and the closing `]`. A change to one record is confined to that record's line. One test may own multiple records, and an ancestor-context change can also affect descendant surface records.

## Index records have a kind of meta, test, or flow

Every record has a `surface` (path relative to `tyxtest/`) and a `kind`:

- `meta` holds the surface's `notes` and its `contextHash`.
- `test` holds one test: `testId`, `chunks`, `context`, `closure`, `closureHash`, and `claimHash`.
- `flow` holds a multi-step test: `testId` and its `steps`, each with an `id`, `text`, `chunks`, and `context`.

No surface-level entry, closure, or source aggregate records are written.

## Index test records follow a fixed field layout

The line below is an example of a `test` record as it appears on a single line of the file. The field names and nesting are exact; the paths, symbol names, and hash values are illustrative.

```json
{"chunks":[{"path":"src/commands/run.ts","symbol":"runCommand"}],"claimHash":"9c1e...","closure":[{"hash":"b82c...","path":"src/cli.ts"},{"hash":"a41f...","path":"src/commands/run.ts"}],"closureHash":"77b0...","context":["src/cli.ts"],"kind":"test","surface":"run","testId":"3f9a1c0d5e72"}
```

Chunks are only a path and a symbol. The source text of a chunk is never stored in the index; it is read from the repository when needed.

## Index output is deterministic

Records are ordered by surface path, with the surface's `meta` record first, then its `test` records sorted by `testId`, then its `flow` records sorted by `testId`. Keys inside each record are sorted alphabetically. Chunks are sorted by path and symbol, and closure and context lists are sorted by path. Serializing identical index records produces identical lines; a new model mapping or changed source may produce different records even if the authored tests did not change. The file contains no timestamps.

## Index files can be read in version 1 or 2

An existing version 1 or version 2 file is read, and legacy per-surface index files are imported for any surface the shared file does not contain. Malformed JSON and objects with an unsupported version or missing `records` array are rejected with an "Invalid index file" error.
