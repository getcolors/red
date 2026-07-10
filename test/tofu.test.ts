// Backend advices need no tofu binary — they only write backend.tf.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcsBackendAdvice, localBackendAdvice, s3BackendAdvice } from "../src/tofu.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-tofu-"));

test("local backend is the default", () => {
  const dir = tmp();
  const advice = localBackendAdvice(() => dir);
  const opts = { x: 1 };
  // before-advice passes opts through
  expect(advice(opts)).toEqual(opts);
  expect(readFileSync(`${dir}/backend.tf`, "utf8")).toBe(
    'terraform {\n  backend "local" {\n  }\n}\n',
  );
});

test("s3 backend advice writes attributes sorted", () => {
  const dir = tmp();
  s3BackendAdvice(() => dir, {
    bucket: "my-state",
    key: "red/node-1.tfstate",
    region: "eu-west-1",
    encrypt: true,
  })({});
  expect(readFileSync(`${dir}/backend.tf`, "utf8")).toBe(
    'terraform {\n' +
      '  backend "s3" {\n' +
      '    bucket = "my-state"\n' +
      "    encrypt = true\n" +
      '    key = "red/node-1.tfstate"\n' +
      '    region = "eu-west-1"\n' +
      "  }\n" +
      "}\n",
  );
});

test("backend config can be a function of opts", () => {
  const dir = tmp();
  gcsBackendAdvice(() => dir, (opts) => ({ bucket: "state", prefix: `red/${opts.node}` }))({
    node: "n1",
  });
  expect(readFileSync(`${dir}/backend.tf`, "utf8")).toBe(
    'terraform {\n  backend "gcs" {\n    bucket = "state"\n    prefix = "red/n1"\n  }\n}\n',
  );
});
