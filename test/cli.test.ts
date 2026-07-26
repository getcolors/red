import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parName, readPars, runCli } from "../src/cli.ts";
import type { Opts } from "../src/workflow.ts";
import { workflow } from "../src/workflow.ts";

let n = 0;
function stateFile(content: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "red-state-")), `state-${n++}.yml`);
  writeFileSync(f, content);
  return f;
}

const probeWf = () =>
  workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [
            (o: Opts) => ({
              ...o,
              seen: [...(o.seen ?? []), ["a", o["red/event"], o.x]],
            }),
            "t/b",
          ];
        case "t/b":
          return [(o: Opts) => ({ ...o, seen: [...o.seen, "b"] })];
      }
    },
  });

test("event and state flow into the workflow", async () => {
  const res = await runCli(probeWf(), ["create", "-f", stateFile("x: 1")]);
  expect(res["red/exit"]).toBe(0);
  expect(res.seen).toEqual([["a", "create", 1], "b"]);
});

test("arbitrary events are allowed", async () => {
  const res = await runCli(probeWf(), ["provision", "-f", stateFile("x: 2")]);
  expect(res.seen).toEqual([["a", "provision", 2], "b"]);
});

test("slices via --start and --end", async () => {
  // --end is an inclusive boundary
  const ended = await runCli(probeWf(), ["create", "-f", stateFile("x: 1"), "--end", "t/a"]);
  expect(ended.seen).toEqual([["a", "create", 1]]);
  // --start skips earlier steps (t/a never ran, so seen starts empty)
  const started = await runCli(probeWf(), [
    "create",
    "-f",
    stateFile("x: 1\nseen: []"),
    "--start",
    "t/b",
  ]);
  expect(started.seen).toEqual(["b"]);
});

test("--dry-run stamps the key", async () => {
  const wf = workflow({
    start: "t/a",
    wireFn: () => [(o: Opts) => ({ ...o, dry: o["red/dry-run"] })],
  });
  expect((await runCli(wf, ["create", "-f", stateFile("{}"), "--dry-run"])).dry).toBe(true);
  expect((await runCli(wf, ["create", "-f", stateFile("{}")])).dry).toBeUndefined();
});

test("usage errors exit 2", async () => {
  // missing event
  const noEvent = await runCli(probeWf(), []);
  expect(noEvent["red/exit"]).toBe(2);
  expect(noEvent["red/err"]).toMatch(/Usage/);
  // missing state file
  const noFile = await runCli(probeWf(), ["create", "-f", "/nonexistent/red.yml"]);
  expect(noFile["red/exit"]).toBe(2);
  expect(noFile["red/err"]).toMatch(/not found/);
  // unknown flag
  const badFlag = await runCli(probeWf(), ["create", "--bogus"]);
  expect(badFlag["red/exit"]).toBe(2);
});

test("RED_PAR overlays flat keys with type coercion", () => {
  expect(parName("compute-prevent-destroy")).toBe("RED_PAR_COMPUTE_PREVENT_DESTROY");
  expect(
    readPars(
      { "compute-prevent-destroy": true, port: 1 },
      { RED_PAR_COMPUTE_PREVENT_DESTROY: "false", RED_PAR_PORT: "587", RED_PAR_TOKEN: "x" },
    ),
  ).toMatchObject({ "compute-prevent-destroy": false, port: 587, token: "x" });
});

test("namespaced keys and YAML 1.2 semantics survive the load", async () => {
  const wf = workflow({
    start: "t/a",
    wireFn: () => [(o: Opts) => ({ ...o, probe: [o["zk/workdir"], o.answer] })],
  });
  const res = await runCli(wf, ["create", "-f", stateFile("zk/workdir: work\nanswer: no")]);
  // zk/workdir parses unquoted; `no` is the string "no", not false
  expect(res.probe).toEqual(["work", "no"]);
});
