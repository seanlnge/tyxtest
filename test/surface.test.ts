import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { backfillSurfaceFile, backfillTestIds, readSurfaceDescription, readSurfaceTitle, readTests, testIdFor } from "../src/surface/surface.js";
import { discoverSurfaces, surfaceContextFor } from "../src/surface/discover.js";
import { tempDir } from "./helpers.js";

test("literal bullet markers work with Markdown escapes, legacy IDs, and every unordered marker", () => {
  const options = { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: "[test]" } } as const;
  const markdown = "# Surface\n\nIntro.\n\n- Documentation item\n+ [test] Claim\n  Detail\n- Documentation after test\n";
  const selected = readTests(markdown, options);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.text, "Claim");
  assert.equal(selected[0]?.notes, "Detail");
  assert.deepEqual(readTests("- \\[test\\] Claim\n  Detail\n", options), selected);
  assert.equal(readTests("- [legacy-id] [test] Claim\n", options)[0]?.id, "legacy-id");
  assert.match(readSurfaceDescription(markdown, options) ?? "", /Documentation item/);
  assert.equal(readTests("+ Claim\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } })[0]?.text, "Claim");
  assert.throws(() => readTests("- [test]\n", options), /empty label/);
});

test("prefixes filter visible heading labels and reject prefix-only labels with trailing separators", () => {
  const options = { testDiscovery: { mode: "headings", headingLevel: 2, prefix: "Test: " } } as const;
  assert.equal(readTests("# Surface\n\n## **Test:** Claim\n", options)[0]?.text, "Claim");
  assert.throws(() => readTests("# Surface\n\n## Test:\n", options), /empty label/);
  const wrapped = "# Surface\n\nIntro.\n\nTest:\nClaim\n------\n\nBody.\n";
  assert.equal(readSurfaceDescription(wrapped, options), "Intro.");
  assert.equal(readTests(wrapped, options)[0]?.text, "Claim");
});

test("heading bodies preserve meaningful code indentation and normalize blank boundaries and newlines", () => {
  const markdown = '# Export\n\n## Output example\n \t \n    {"indented":true}\n\n```json\n{"type":"object"}\n```\n  \n';
  const cases = readTests(markdown);
  assert.equal(cases[0]?.notes, '    {"indented":true}\n\n```json\n{"type":"object"}\n```');
  assert.deepEqual(readTests(markdown.replace(/\n/g, "\r\n")), cases);
  assert.equal(readSurfaceDescription("# Title\n\n    code example\n\n## Claim\n"), "    code example");
});

test("empty test headings fail clearly and readable image headings use alt text", () => {
  assert.throws(() => readTests("# Surface\n\n##\n\nBody\n"), /readable text/);
  assert.equal(readTests("# Surface\n\n## ![Payment form](form.png)\n")[0]?.text, "Payment form");
});

test("wrapped Setext headings keep single-line human-readable labels", () => {
  const markdown = "Product\nexport\n======\n\nExported records\nmatch the schema\n----------------\n\nFull specification.\n";
  assert.equal(readSurfaceTitle(markdown), "Product export");
  assert.equal(readTests(markdown)[0]?.text, "Exported records match the schema");
  assert.equal(readTests(markdown)[0]?.notes, "Full specification.");
});

test("explicit bullet mode excludes tests from the surface introduction", () => {
  const markdown = "# Surface\n\nIntroductory paragraph.\n\n- A legacy claim\n  Supporting notes\n";
  assert.equal(readSurfaceDescription(markdown, { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } }), "Introductory paragraph.");
  assert.equal(readSurfaceDescription(markdown.replace("Introductory paragraph.", "## Background\n\nIntroductory paragraph."), { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } }), "## Background\n\nIntroductory paragraph.");
  assert.match(readSurfaceDescription(markdown) ?? "", /A legacy claim/);
  assert.equal(readTests(markdown).length, 0);
});

test("a claim without an id gets a stable internal hash without changing markdown", () => {
  const input = `---
surface: Login form
description: Email/password form on /login
entry: src/pages/login.tsx
---
- [submit-exists] There is a submit button in the form
- Email is validated before submit
`;
  const result = backfillTestIds(input, { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(result.changed, false);
  assert.equal(result.markdown, input);
  assert.deepEqual(
    result.tests.map((item) => item.id),
    ["submit-exists", testIdFor("Email is validated before submit")],
  );
});

test("duplicate claims get distinct hash ids and prose stays put", () => {
  const input = `---
surface: Login form
---

Intro line.

- [there-is-a-submit-button] Kept
- There is a submit button
- There is a submit button
- !!!
`;
  const result = backfillTestIds(input, { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(result.changed, false);
  assert.match(result.markdown, /Intro line\./);
  assert.match(result.markdown, /\[there-is-a-submit-button\] Kept/);
  const hashed = testIdFor("There is a submit button");
  assert.deepEqual(result.tests.map((item) => item.id), [
    "there-is-a-submit-button",
    hashed,
    `${hashed}-2`,
    testIdFor("!!!"),
  ]);
});

test("reading a surface does not write hash ids into the file", () => {
  const cwd = tempDir("tyxtest-surface-");
  const file = path.join(cwd, "tyxtest", "login", "surface.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = "---\nsurface: Login\n---\n- There is a submit button\n";
  fs.writeFileSync(file, original);
  const written = backfillSurfaceFile(file, { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(written.changed, false);
  assert.equal(written.tests[0]?.id, testIdFor("There is a submit button"));
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("heading mode uses complete top-level Markdown heading blocks as tests", () => {
  const markdown = `# Checkout

Intro paragraph.

- Intro list, not a test

## Submit payment

The payment is submitted.

- A receipt is shown
  - It includes the total


### Schema detail

\`\`\`ts
interface Input {\n  // fake heading below\n  value: string\n}\n## Fake test\n\`\`\`

## Submit payment

Second distinct body.

> ## Quoted heading is not a test

<!--\n## Commented heading is not a test\n-->

## Searchable\n
<section>\n## HTML-block heading is not a test\n</section>
`;
  const tests = readTests(markdown);
  assert.deepEqual(tests.map(({ text }) => text), ["Submit payment", "Submit payment", "Searchable"]);
  assert.match(tests[0]!.notes!, /A receipt is shown/);
  assert.match(tests[0]!.notes!, /### Schema detail/);
  assert.match(tests[0]!.notes!, /interface Input/);
  assert.match(tests[0]!.notes!, /## Fake test/);
  assert.notEqual(tests[0]!.id, tests[1]!.id);
  assert.equal(readTests(markdown.replace("Second distinct body.", "Changed body."))[1]!.id === tests[1]!.id, false);
});

test("heading boundaries honor configured level, setext headings, and nested containers", () => {
  const markdown = `# Surface\nIntro\n\nTest One\n========\nbody\n\n### Nested section\nkept\n\n## Boundary\nnext\n\n> ## Quote only\n\n- A prose list\n`;
  const tests = readTests(markdown);
  assert.deepEqual(tests.map(({ text }) => text), ["Boundary"]);
  const level3 = readTests(markdown, { testDiscovery: { mode: "headings", headingLevel: 3, prefix: null } });
  assert.deepEqual(level3.map(({ text }) => text), ["Nested section"]);
  assert.equal(level3[0]!.notes, "kept");
  assert.equal(readTests("# Title\n- A bullet\n").length, 0);
});

test("heading prefixes are literal, case-sensitive, and preserve identity after removal", () => {
  const markdown = "# Surface\n\n## Docs\nIgnored docs.\n\n## [a.+] Pay\nBody.\n\n## [A.+] Other\n\n## Tail\n";
  const options = { testDiscovery: { mode: "headings" as const, headingLevel: 2 as const, prefix: "[a.+] " } };
  const selected = readTests(markdown, options);
  assert.deepEqual(selected.map((item) => item.text), ["Pay"]);
  assert.equal(selected[0]?.notes, "Body.");
  assert.equal(selected[0]?.id, readTests("# Surface\n\n## Pay\nBody.\n", { ...options, testDiscovery: { ...options.testDiscovery, prefix: null } })[0]?.id);
  assert.throws(() => readTests("## [a.+]\n", { ...options, testDiscovery: { ...options.testDiscovery, prefix: "[a.+]" } }), /empty label/);
  assert.equal(readSurfaceDescription(markdown, options), "## Docs\nIgnored docs.");
  assert.equal(readTests("# S\n\n```md\n## [a.+] Fake\n```\n", options).length, 0);
});

test("bullet prefixes filter only top-level claims and descriptions stop at the first match", () => {
  const markdown = "# Surface\n\nIntro list:\n\n- Documentation item\n- [old-id] test: [a.+] Claim\n  - test: [a.+] nested\n  Note\n- Documentation after\n- test: [a.+] Next\n";
  const options = { testDiscovery: { mode: "bullets" as const, headingLevel: 2 as const, prefix: "test: [a.+] " } };
  assert.deepEqual(readTests(markdown, options).map((item) => [item.id, item.text, item.notes]), [
    [testIdFor("Claim\n- test: [a.+] nested\nNote"), "Claim", "- test: [a.+] nested\nNote"],
    [testIdFor("Next"), "Next", undefined],
  ]);
  assert.equal(readTests(markdown, options)[0]?.notes, "- test: [a.+] nested\nNote");
  assert.equal(readSurfaceDescription(markdown, options), "Intro list:\n\n- Documentation item");
  assert.throws(() => readTests("- test: [a.+]\n", { ...options, testDiscovery: { ...options.testDiscovery, prefix: "test: [a.+]" } }), /empty label/);
  assert.equal(readTests("- Test: [a.+] Wrong case\n", options).length, 0);
});

test("bullet parsing and legacy IDs require explicit bullet mode", () => {
  const markdown = "# Title\n- [old-id] Claim\n  Note\n";
  assert.equal(readTests(markdown).length, 0);
  assert.deepEqual(readTests(markdown, { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } }).map((item) => item.text), ["Claim"]);
});

test("legacy bracket IDs are removed from claim text; indented notes affect identity", () => {
  const legacy = readTests("---\nsurface: Old\ndescription: Legacy prose\n---\n# Old\n- [old-id] Claim\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(legacy[0]?.text, "Claim");
  assert.equal(legacy[0]?.id, "old-id");
  const withNote = readTests("# Title\n- Claim\n  Only for signed-in users\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.deepEqual(withNote[0], {
    id: testIdFor("Claim\nOnly for signed-in users"),
    text: "Claim",
    notes: "Only for signed-in users",
  });
  assert.notEqual(withNote[0]?.id, readTests("# Title\n- Claim\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } })[0]?.id);
});

test("description prose and fenced headings are not claims or test notes", () => {
  const tests = readTests("# Title\nDescription paragraph.\n\n```md\n# Not a title\n- not a test\n```\n\n- Real claim\n  ```txt\n  detail\n  ```\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(tests.length, 1);
  assert.equal(tests[0]?.text, "Real claim");
  assert.equal(tests[0]?.notes, "```txt\ndetail\n```" );
});

test("nested bullets and formatted code stay in notes; fences close by matching length", () => {
  const tests = readTests([
    "  - orphan note",
    "- Claim",
    "  - nested note",
    "  ````ts",
    "    const value = 1;",
    "  ```",
    "    still inside the four-backtick fence",
    "  ````",
    "```md",
    "- documentation example, not a test",
    "```",
    "- Next claim",
  ].join("\n"), { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(tests.length, 2);
  assert.equal(tests[0]?.text, "Claim");
  assert.equal(tests[0]?.notes, "- nested note\n````ts\n  const value = 1;\n```\n  still inside the four-backtick fence\n````");
  assert.equal(tests[1]?.text, "Next claim");
});

test("unindented fenced documentation after a test is not attached as notes", () => {
  const tests = readTests("- Claim\n```md\n- documentation only\n```\n- Next\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.deepEqual(tests.map(({ text, notes }) => ({ text, notes })), [
    { text: "Claim", notes: undefined },
    { text: "Next", notes: undefined },
  ]);
});

test("single-space and tab-indented continuations are notes rather than tests", () => {
  const tests = readTests("- Claim\n - One-space detail\n\t- Tab detail\n", { testDiscovery: { mode: "bullets", headingLevel: 2, prefix: null } });
  assert.equal(tests.length, 1);
  assert.equal(tests[0]?.notes, "- One-space detail\n- Tab detail");
});

test("surface title reads H1 after frontmatter and ignores fenced headings", () => {
  assert.equal(readSurfaceTitle("---\ndescription: x\n---\n\n```md\n# Example\n```\n# Actual title\n"), "Actual title");
  assert.equal(readSurfaceTitle("---\ndescription: x\n---\n```\n# Not a title\n```"), undefined);
  assert.equal(readSurfaceDescription("# Title\n\nA human description.\n\n- Claim\n"), "A human description.\n\n- Claim");
  const nestedFence = "````md\n```\n# Still an example\n````\n# Actual title\nDescription.\n- Claim\n";
  assert.equal(readSurfaceTitle(nestedFence), "Actual title");
  assert.equal(readSurfaceDescription(nestedFence), "Description.\n- Claim");
  assert.equal(readSurfaceTitle("# C# support\n"), "C# support");
  assert.equal(readSurfaceTitle("# C#\n"), "C#");
  assert.equal(readSurfaceTitle("# Actual title ###\n"), "Actual title");
});

test("discovery prefers H1 names and falls back to legacy surface metadata", () => {
  const cwd = tempDir("tyxtest-discover-title-");
  for (const [dir, markdown] of [
    ["new", "---\nentry: src/new.ts\n---\n# Human title\n\nNew desc\n"],
    ["old", "---\nsurface: Legacy title\n---\n- [claim] Claim\n"],
  ]) {
    const file = path.join(cwd, "tyxtest", dir, "surface.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
  }
  const surfaces = discoverSurfaces(cwd);
  assert.equal(surfaces.find((surface) => surface.relativeDir === "new")?.name, "Human title");
  assert.equal(surfaces.find((surface) => surface.relativeDir === "new")?.description, "New desc");
  assert.equal(surfaces.find((surface) => surface.relativeDir === "old")?.name, "Legacy title");
});

test("body descriptions retain paragraphs and fenced examples when bullets are prose", () => {
  const description = "First paragraph.\n\nSecond paragraph.\n\n```md\n- example, not a test\n```";
  const markdown = `# Title\n\n${description}\n\n- Actual claim\n`;
  assert.equal(readSurfaceDescription(markdown), `${description}\n\n- Actual claim`);
  assert.equal(readTests(markdown).length, 0);
});

test("surface title and intro ignore fake headings in HTML comments, blocks, and containers", () => {
  const markdown = `<!--\n# Comment fake\n-->\n\n<div>\n# HTML fake\n</div>\n\n# Real title\n\nIntro paragraph.\n\n- An intro list\n\n## Test\nbody\n`;
  assert.equal(readSurfaceTitle(markdown), "Real title");
  assert.equal(readSurfaceDescription(markdown), "Intro paragraph.\n\n- An intro list");
});

test("surface context follows semantic ancestors and paths, independently of source entries and current claims", () => {
  const cwd = tempDir("tyxtest-semantic-context-");
  const parent = path.join(cwd, "tyxtest/account/surface.md");
  const child = path.join(cwd, "tyxtest/account/personal/settings/surface.md");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(parent, "# Account\n\nA personal customer account.\n\n## Settings are private\n\nOnly the owner may change them.\n");
  fs.writeFileSync(child, "# Settings\n\nPersonal account preferences.\n\n## Email can be changed\n\nOnly the owner can change it.\n");
  const context = () => {
    const surfaces = discoverSurfaces(cwd);
    return surfaceContextFor(surfaces.find((surface) => surface.relativeDir === "account/personal/settings")!, surfaces);
  };
  const original = context();
  assert.match(original.text, /A personal customer account/);
  assert.match(original.text, /Only the owner may change them/);
  assert.match(original.text, /account\/personal\/settings/);
  assert.doesNotMatch(original.text, /Email can be changed/);
  fs.appendFileSync(child, "- Notifications can be changed\n");
  assert.equal(context().hash, original.hash);
  fs.appendFileSync(parent, "\n## Changes require authentication\n");
  assert.notEqual(context().hash, original.hash);
});
