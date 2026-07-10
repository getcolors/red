// Flat file-spec scaffolding DSL. A spec is a seq of maps, one per file:
//
//   { template: { name: "zk/main.tf", content: mainTf },  // a text import
//     target: "{{workdir}}/n/{{node.id}}/main.tf",        // rendered vs data
//     data: {...} }
//
// The module graph is the classpath: the package that owns a template
// imports it as text (`import mainTf from "./main.tf" with { type: "text" }`)
// and passes {name, content}; nothing is resolved at run time. On
// "red/event" "delete" the same specs name the targets to remove.

import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { render } from "selmer";
import type { Opts } from "./workflow.ts";
import { StepError } from "./workflow.ts";

export interface Template {
  name: string;
  content: string;
}

// Forwarded to selmer's render — tagOpen/tagClose/filterOpen/filterClose
// override delimiters (single characters, e.g. "<"/">" and "{"/"}" for
// Ansible files that reserve {{ }}/{% %} for Jinja2).
export interface RenderOpts {
  tagOpen?: string;
  tagClose?: string;
  filterOpen?: string;
  filterClose?: string;
  [key: string]: unknown;
}

export interface Spec {
  template: Template;
  target: string;
  data: Record<string, unknown>;
  opts?: RenderOpts;
}

// Render a template's content with `data`. Optional `opts` are forwarded to
// selmer's render (delimiter overrides and friends).
export function renderTemplate(
  template: Template,
  data: Record<string, unknown>,
  opts?: RenderOpts,
): string {
  if (typeof template?.content !== "string") {
    throw new StepError(`template not found: ${template?.name ?? Bun.inspect(template)} has no content — pass {name, content} with content from a text import`);
  }
  return render(template.content, data, opts);
}

function pruneEmptyDir(file: string): void {
  const parent = dirname(file);
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // parent missing or not a directory — nothing to prune
  }
}

function targetPath(spec: Spec): string {
  return render(spec.target, spec.data);
}

function deleteTarget(target: string): void {
  if (existsSync(target)) unlinkSync(target);
  pruneEmptyDir(target);
}

function createTarget(spec: Spec, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderTemplate(spec.template, spec.data, spec.opts));
}

// Materialize `specs` (create) or remove their targets (delete), driven by
// "red/event" in `opts`. Returns opts with "red/exit" 0 and the affected
// paths under "red.scaffold/written" or "red.scaffold/deleted".
export function scaffold(opts: Opts, specs: Spec[]): Opts {
  const all = [...specs];
  const targets = all.map(targetPath);
  if (opts["red/event"] === "delete") {
    for (const target of targets) deleteTarget(target);
    return { ...opts, "red/exit": 0, "red.scaffold/deleted": targets };
  }
  all.forEach((spec, i) => createTarget(spec, targets[i]!));
  return { ...opts, "red/exit": 0, "red.scaffold/written": targets };
}
