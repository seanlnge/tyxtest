import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/commands/main.js";

test("each command prints help and does not start the command", async () => {
  for (const command of ["setup", "generate", "index", "run"]) {
    let out = "";
    const code = await main([command, "--help"], {
      stdout: (message) => {
        out += message;
      },
      stderr: () => {},
      stdinIsTTY: false,
    });
    assert.equal(code, 0);
    assert.match(out, new RegExp(`tyxtest ${command}`));
    assert.doesNotMatch(out, /Index model provider/);
  }
});

test("run -A is recognized and does not become a surface name", async () => {
  let out = "";
  const code = await main(["run", "-A", "--help"], {
    stdout: (message) => {
      out += message;
    },
    stderr: () => {},
    stdinIsTTY: false,
  });
  assert.equal(code, 0);
  assert.match(out, /-A, --all/);
});

test("help run and run -h print the run flags", async () => {
  for (const argv of [
    ["help", "run"],
    ["run", "-h"],
  ]) {
    let out = "";
    const code = await main(argv, {
      stdout: (message) => {
        out += message;
      },
      stderr: () => {},
      stdinIsTTY: false,
    });
    assert.equal(code, 0);
    assert.match(out, /--cached/);
    assert.match(out, /-A, --all/);
    assert.match(out, /--verbose/);
    assert.match(out, /Every non-pass is retried/);
    assert.match(out, /an unsure aggregate escalates once/);
    assert.match(out, /The escalation model does not rerun/);
    assert.match(out, /own fresh source context/);
    assert.match(out, /Indexed chunks select evidence, not the complete verdict context/);
    assert.match(out, /markdown\.testDiscovery\.prefix/);
    assert.match(out, /Nonmatching peer headings still end tests/);
    assert.match(out, /nesting supplies semantic context and never restricts source files/);
  }
});

test("index help documents --fix", async () => {
  let out = "";
  const code = await main(["index", "--help"], {
    stdout: (message) => { out += message; },
    stderr: () => {},
    stdinIsTTY: false,
  });
  assert.equal(code, 0);
  assert.match(out, /--fix/);
  assert.match(out, /shared tyxtest\/\.index\.json/);
  assert.match(out, /single-line records/);
  assert.match(out, /No entry file is required/);
  assert.match(out, /product context, not file restrictions/);
});

test("setup help describes normal index merging instead of installing an ours driver", async () => {
  let out = "";
  const code = await main(["setup", "--help"], {
    stdout: (message) => { out += message; },
    stderr: () => {},
    stdinIsTTY: false,
  });
  assert.equal(code, 0);
  assert.match(out, /remove the old index merge=ours rule/);
  assert.match(out, /line-based merging/);
});
