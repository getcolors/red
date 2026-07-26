// Backend advices need no tofu binary — they only write backend.tf.json.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime } from "../src/runtime.ts";
import {
  backendAdvice,
  backends,
  construct,
  constructsJson,
  gcsBackendAdvice,
  hclList,
  hclMap,
  localBackendAdvice,
  r2BackendAdvice,
  s3BackendAdvice,
  tofuStep,
} from "../src/tofu.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-tofu-"));
const backendConfig = (dir: string) =>
  JSON.parse(readFileSync(`${dir}/backend.tf.json`, "utf8"));

test("tofu commands receive the configured environment", async () => {
  const original = runtime.exec;
  const calls: any[] = [];
  runtime.exec = async (cmd, opts) => {
    calls.push([cmd, opts]);
    return { exit: 0, out: cmd.includes("output") ? "{}" : "", err: "" };
  };
  try {
    const result = await tofuStep({ "red/event": "create" }, { dir: "/tmp/tofu", env: { TOKEN: "secret" } });
    expect(result["red/exit"]).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls.every(([, opts]) => opts.env.TOKEN === "secret")).toBe(true);
  } finally { runtime.exec = original; }
});

test("local backend is the default", () => {
  const dir = tmp();
  const advice = localBackendAdvice(() => dir);
  const opts = { x: 1 };
  // before-advice passes opts through
  expect(advice(opts)).toEqual(opts);
  expect(backendConfig(dir)).toEqual({ terraform: { backend: { local: {} } } });
});

test("s3 backend advice writes attributes", () => {
  const dir = tmp();
  s3BackendAdvice(() => dir, {
    bucket: "my-state",
    key: "red/node-1.tfstate",
    region: "eu-west-1",
    encrypt: true,
  })({});
  expect(backendConfig(dir)).toEqual({
    terraform: {
      backend: {
        s3: {
          bucket: "my-state",
          encrypt: true,
          key: "red/node-1.tfstate",
          region: "eu-west-1",
        },
      },
    },
  });
});

test("backend config retains native JSON shapes", () => {
  const dir = tmp();
  backendAdvice(() => dir, "test", {
    enabled: true,
    retries: 3,
    nested: { endpoint: "https://example.test" },
    items: ["one", "two"],
    unset: null,
  })({});
  expect(backendConfig(dir)).toEqual({
    terraform: {
      backend: {
        test: {
          enabled: true,
          retries: 3,
          nested: { endpoint: "https://example.test" },
          items: ["one", "two"],
          unset: null,
        },
      },
    },
  });
});

test("backend config can be a function of opts", () => {
  const dir = tmp();
  gcsBackendAdvice(() => dir, (opts) => ({ bucket: "state", prefix: `red/${opts.node}` }))({
    node: "n1",
  });
  expect(backendConfig(dir)).toEqual({
    terraform: { backend: { gcs: { bucket: "state", prefix: "red/n1" } } },
  });
});

test("r2 backend and backend selection", () => {
  const dir = tmp();
  const advice = backends(
    (opts) => String(opts.backend),
    {
      r2: r2BackendAdvice(() => dir, {
        bucket: "state",
        key: "production/dns.tfstate",
        endpoint: "https://acct.r2.cloudflarestorage.com",
      }),
    },
  );
  advice({ backend: "r2" });
  expect(backendConfig(dir).terraform.backend.s3).toMatchObject({
    bucket: "state",
    region: "auto",
    endpoints: { s3: "https://acct.r2.cloudflarestorage.com" },
    skip_credentials_validation: true,
  });
  expect(() => advice({ backend: "nope" })).toThrow(/unsupported/);
});

test("HCL and constructs are deterministic and Green-byte-compatible", () => {
  expect(hclList(["example.com", "example.net"])).toBe('["example.com", "example.net"]');
  expect(hclMap({ b: "2", a: "1" })).toBe('{\n    "a" : "1",\n    "b" : "2"\n  }');
  const a = construct("resource", "dns_record", "once.tools/b", { ttl: 1, name: "b" });
  const b = construct("resource", "dns_record", "once.tools/a", { name: "a", ttl: 1 });
  expect(constructsJson([a, b])).toBe(constructsJson([b, a]));
  expect(constructsJson([])).toBe("{ }");
});
