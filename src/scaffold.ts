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
// Rendering is handled by red's small Selmer-compatible renderer.

import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { render, type RenderOpts } from "./renderer.ts";
import type { Opts } from "./workflow.ts";
import { StepError } from "./workflow.ts";

export type { RenderOpts } from "./renderer.ts";

export interface Template {
  name: string;
  content: string;
}

// Forwarded to the renderer — tagOpen/tagClose/filterOpen/filterClose
// override delimiters (single characters, e.g. "<"/">" and "{"/"}" for
// Ansible files that reserve {{ }}/{% %} for Jinja2).
export const PRESERVE_JINJA_DELIMITERS: RenderOpts = {
  tagOpen: "<", tagClose: ">", filterOpen: "{", filterClose: "}",
};

export type Spec = {
  target: string;
  data?: Record<string, unknown>;
  opts?: RenderOpts;
} & ({ template: Template; content?: never } | { content: string; template?: never });

export function contentSpec(target: string, content: string): Spec {
  return { target, content, data: {} };
}

// Render a template's content with `data`. Optional `opts` are forwarded to
// the renderer (delimiter overrides and friends).
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
  return render(spec.target, spec.data ?? {});
}

function deleteTarget(target: string): void {
  if (existsSync(target)) unlinkSync(target);
  pruneEmptyDir(target);
}

function createTarget(spec: Spec, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "content" in spec
    ? spec.content!
    : renderTemplate(spec.template, spec.data ?? {}, spec.opts));
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
