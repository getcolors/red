import { expect, test } from "bun:test";
import { z } from "zod";
import { schemaGate } from "../src/gates.ts";
import type { Opts } from "../src/workflow.ts";
import { adviceAdd, run, workflow } from "../src/workflow.ts";

const gateWf = (effects: string[]) =>
  adviceAdd(
    workflow({
      start: "t/a",
      wireFn: () => [
        (o: Opts) => {
          effects.push("ran");
          return o;
        },
      ],
    }),
    "t/a",
    "before-while",
    "test/schema",
    schemaGate(
      z.object({ "zk/servers": z.array(z.object({ id: z.number() })) }).loose(),
    ),
  );

test("valid opts pass through the gate untouched", async () => {
  const effects: string[] = [];
  const res = await run(gateWf(effects), {
    "zk/servers": [{ id: 1 }],
    "other/key": "survives",
  });
  expect(res["red/exit"]).toBe(0);
  expect(effects).toEqual(["ran"]);
  // the gate validates, never transforms: unrelated namespaces survive
  expect(res["other/key"]).toBe("survives");
});

test("invalid opts fail with exit 2 and a readable message; the step never runs", async () => {
  const effects: string[] = [];
  const res = await run(gateWf(effects), { "zk/servers": [{ id: "one" }] });
  expect(res["red/exit"]).toBe(2);
  expect(res["red/err"]).toMatch(/schema gate failed/);
  expect(res["red/err"]).toMatch(/zk\/servers/);
  expect(effects).toEqual([]);
});
