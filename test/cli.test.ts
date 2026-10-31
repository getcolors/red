import { expect, test } from "bun:test";
import { loadYaml, parName, readPars } from "../src/cli.ts";

test("COLORS_PAR overlays flat keys with type coercion", () => {
  expect(parName("compute-prevent-destroy")).toBe("COLORS_PAR_COMPUTE_PREVENT_DESTROY");
  expect(
    readPars(
      { "compute-prevent-destroy": true, port: 1 },
      { COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false", COLORS_PAR_PORT: "587", COLORS_PAR_TOKEN: "x" },
    ),
  ).toMatchObject({ "compute-prevent-destroy": false, port: 587, token: "x" });
});

test("no colour keeps a prefix of its own", () => {
  expect(
    readPars({}, {
      GREEN_PAR_DO_TOKEN: "tok",
      RED_PAR_DO_TOKEN: "tok",
      BLUE_PAR_DO_TOKEN: "tok",
      ONCE_PAR_DO_TOKEN: "tok",
    }),
  ).toEqual({});
});

test("YAML 1.2 scalars preserve configuration types", () => {
  expect(loadYaml("app/workdir: work\nanswer: no\nleading: 012\noctal: 0o12\nhex: 0x10\ntime: 1:30\ndate: 2026-10-31\nscientific: 1e3\nflag: false\n")).toEqual({
    "app/workdir": "work", answer: "no", leading: 12, octal: 10,
    hex: 16, time: "1:30", date: "2026-10-31", scientific: 1000, flag: false,
  });
  expect(loadYaml("")).toEqual({});
  expect(() => loadYaml("x: [")).toThrow();
});

test("configuration helpers do not mutate input and ignore unrelated environment entries", () => {
  const original = { flag: true, count: 1 };
  const env = { COLORS_PAR_FLAG: "false", COLORS_PAR_COUNT: "2", COLORS_PAR_: "ignored", PATH: "/bin", COLORS_PAR_MISSING: undefined };
  expect(readPars(original, env)).toEqual({ flag: false, count: 2 });
  expect(original).toEqual({ flag: true, count: 1 });
});
