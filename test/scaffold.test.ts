import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// the module graph is the classpath: templates travel as text imports
import ansibleHello from "../test-resources/redtest/ansible-hello.yml" with { type: "text" };
import hello from "../test-resources/redtest/hello.txt" with { type: "text" };
import { renderTemplate, scaffold } from "../src/scaffold.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-scaffold-"));

test("scaffold create and delete", () => {
  const dir = tmp();
  const specs = [
    {
      template: { name: "redtest/hello.txt", content: hello },
      target: `${dir}/{{who}}/hello.txt`,
      data: { who: "world", name: "red" },
    },
  ];
  const created = scaffold({ "red/event": "create" }, specs);
  // create renders the template into the rendered target
  expect(created["red/exit"]).toBe(0);
  expect(created["red.scaffold/written"]).toEqual([`${dir}/world/hello.txt`]);
  expect(readFileSync(`${dir}/world/hello.txt`, "utf8")).toBe("Hello red!\n");

  // create is idempotent
  scaffold({ "red/event": "create" }, specs);
  expect(readFileSync(`${dir}/world/hello.txt`, "utf8")).toBe("Hello red!\n");

  // delete removes targets and prunes emptied directories
  const deleted = scaffold({ "red/event": "delete" }, specs);
  expect(deleted["red/exit"]).toBe(0);
  expect(existsSync(`${dir}/world/hello.txt`)).toBe(false);
  expect(existsSync(`${dir}/world`)).toBe(false);
});

test("custom delimiters pass Jinja2 through", () => {
  const dir = tmp();
  const specs = [
    {
      template: { name: "redtest/ansible-hello.yml", content: ansibleHello },
      target: `${dir}/play.yml`,
      data: { group: "web" },
      opts: { tagOpen: "<", tagClose: ">", filterOpen: "{", filterClose: "}" },
    },
  ];
  const created = scaffold({ "red/event": "create" }, specs);
  expect(created["red/exit"]).toBe(0);
  const content = readFileSync(`${dir}/play.yml`, "utf8");
  // Selmer-style <{group}> is rendered
  expect(content).toMatch(/hosts: web/);
  // Jinja2 {{ }} passes through unchanged
  expect(content).toMatch(/\{\{ ansible_var \}\}/);
});

test("renderer supports escaping, safe, loops, sort, and missing values", () => {
  const template = {
    name: "inline",
    content:
      "{{missing}}" +
      "{{unsafe}}|{{unsafe|safe}}\n" +
      "{% for s in servers | sort(attribute='id') %}{{s.id}}={{s.name}};{% endfor %}",
  };
  expect(
    renderTemplate(template, {
      unsafe: "<tag>&",
      servers: [
        { id: 2, name: "b" },
        { id: 1, name: "a" },
      ],
    }),
  ).toBe("&lt;tag&gt;&amp;|<tag>&\n1=a;2=b;");
});

test("a template without content throws with context", () => {
  expect(() =>
    scaffold({ "red/event": "create" }, [
      {
        template: { name: "nope/missing.txt", content: undefined as unknown as string },
        target: "/tmp/x",
        data: {},
      },
    ]),
  ).toThrow(/template not found/);
});
