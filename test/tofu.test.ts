// Backend advices need no tofu binary — they only write backend.tf.json.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendAdvice,
  gcsBackendAdvice,
  localBackendAdvice,
  s3BackendAdvice,
} from "../src/tofu.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-tofu-"));
const backendConfig = (dir: string) =>
  JSON.parse(readFileSync(`${dir}/backend.tf.json`, "utf8"));

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
