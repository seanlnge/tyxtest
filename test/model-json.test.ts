import assert from "node:assert/strict";
import test from "node:test";

import { parseModelJson } from "../src/model/model-json.js";

test("model JSON preserves fenced schemas and Markdown examples inside strings", () => {
  const value = { surfaces: [{ tests: [{ text: "Export format", body: 'Validate this schema:\n\n```json\n{"type":"object"}\n```\n\n```md\n## Example, not a test\n```' }] }] };
  const serialized = JSON.stringify(value);
  assert.deepEqual(parseModelJson(serialized), value);
  assert.deepEqual(parseModelJson(`\`\`\`json\n${serialized}\n\`\`\``), value);
  assert.deepEqual(parseModelJson(`\`\`\`\n${serialized}\n\`\`\``), value);
});

test("invalid model JSON still produces a clear error", () => {
  assert.throws(() => parseModelJson("not an object"), /did not return a JSON object/);
  assert.throws(() => parseModelJson('{"invalid":}'), /invalid JSON/);
});
