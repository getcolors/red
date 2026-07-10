// Event-aware Ansible steps: any non-"delete" event (conventionally
// "create") runs the create playbook, "delete" runs the delete playbook —
// both via `ansible-playbook` over SSH. After a successful run the PLAY
// RECAP is parsed and merged into opts under a namespaced key
// ("ansible/recap" by default). The inventory is not hardwired: attach
// `inventoryAdvice` as a `before` advice to write an INI inventory from a
// function of opts before the step runs, the way red/tofu attaches backends.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtime, type ExecResult } from "./runtime.ts";
import { scaffold, type Spec } from "./scaffold.ts";
import type { Opts } from "./workflow.ts";

// Event -> playbook file, relative to the step's dir.
export const defaultPlaybooks = { create: "create.yml", delete: "delete.yml" };

export interface Playbooks {
  create?: string;
  delete?: string;
}

// The playbook `ansibleStep` runs for opts' "red/event": "delete" selects
// the delete entry, every other event the create entry.
export function playbook(opts: Opts, playbooks?: Playbooks): string {
  const merged = { ...defaultPlaybooks, ...playbooks };
  return opts["red/event"] === "delete" ? merged.delete : merged.create;
}

const recapLineRe =
  /^(\S+)\s+:\s+ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)\s+skipped=(\d+)\s+rescued=(\d+)\s+ignored=(\d+)/gm;

export interface RecapCounters {
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  skipped: number;
  rescued: number;
  ignored: number;
}

// Parse the PLAY RECAP section of `ansible-playbook` output into
// {host: {ok, changed, unreachable, failed, skipped, rescued, ignored}}.
export function parseRecap(out: string): Record<string, RecapCounters> {
  const recap: Record<string, RecapCounters> = {};
  for (const m of String(out).matchAll(recapLineRe)) {
    const [, host, ok, changed, unreachable, failed, skipped, rescued, ignored] = m;
    recap[host!] = {
      ok: Number(ok),
      changed: Number(changed),
      unreachable: Number(unreachable),
      failed: Number(failed),
      skipped: Number(skipped),
      rescued: Number(rescued),
      ignored: Number(ignored),
    };
  }
  return recap;
}

function fail(opts: Opts, res: ExecResult, pb: string): Opts {
  return {
    ...opts,
    "red/exit": res.exit,
    "red/err": `ansible-playbook ${pb} failed: ${res.out || res.err || "(no output)"}`,
  };
}

export interface AnsibleConfig {
  // working directory; playbook and inventory paths resolve relative to it
  dir: string;
  // inventory file (default "inventory.ini")
  inventory?: string;
  // {create, delete} overriding defaultPlaybooks
  playbooks?: Playbooks;
  // SSH private key file passed as --private-key
  privateKey?: string;
  // remote user passed as -u
  user?: string;
  // map passed as -e in JSON form
  extraVars?: Record<string, unknown>;
  // set to false to export ANSIBLE_HOST_KEY_CHECKING=False for the run —
  // for ephemeral or emulated hosts whose host keys change on every create.
  // Omitted or true, the environment is left untouched.
  hostKeyChecking?: boolean;
  // namespaced key for the parsed recap
  recapKey?: string;
}

// Run `ansible-playbook` in `dir` according to "red/event" (see `playbook`).
// On success the parsed PLAY RECAP is merged under `recapKey` (default
// "ansible/recap") — never top-level.
export async function ansibleStep(opts: Opts, config: AnsibleConfig): Promise<Opts> {
  const {
    dir,
    inventory = "inventory.ini",
    playbooks,
    privateKey,
    user,
    extraVars,
    hostKeyChecking,
    recapKey = "ansible/recap",
  } = config;
  const pb = playbook(opts, playbooks);
  const env = hostKeyChecking === false ? { ANSIBLE_HOST_KEY_CHECKING: "False" } : undefined;
  const args = ["-i", inventory];
  if (privateKey) args.push("--private-key", String(privateKey));
  if (user) args.push("-u", user);
  if (extraVars) args.push("-e", JSON.stringify(extraVars));
  args.push(pb);
  const res = await runtime.exec(["ansible-playbook", ...args], { cwd: dir, env });
  if (res.exit > 0) return fail(opts, res, pb);
  return { ...opts, "red/exit": 0, [recapKey]: parseRecap(res.out) };
}

// Scaffold ansible config files (playbooks, ansible.cfg, …) then run
// ansible-playbook (create); or run ansible-playbook then remove the
// scaffolded files (delete). Mirrors the tofu-with-spec pattern.
export async function ansibleWithSpec(
  opts: Opts,
  ansibleConfig: AnsibleConfig,
  specs: Spec[],
): Promise<Opts> {
  if (opts["red/event"] === "delete") {
    const ran = await ansibleStep(opts, ansibleConfig);
    return (ran["red/exit"] ?? 0) > 0 ? ran : scaffold(ran, specs);
  }
  return ansibleStep(scaffold(opts, specs), ansibleConfig);
}

// --- inventory ---------------------------------------------------------------

function iniVars(vars: Record<string, unknown> | undefined): string[] {
  return Object.entries(vars ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
}

export interface InventoryHost {
  name: string;
  vars?: Record<string, unknown>;
}

export interface InventoryGroup {
  hosts: InventoryHost[];
  vars?: Record<string, unknown>;
}

function hostLine(host: InventoryHost): string {
  return [host.name, ...iniVars(host.vars)].join(" ");
}

function groupSection([group, { hosts, vars }]: [string, InventoryGroup]): string {
  const lines = `[${group}]\n${hosts.map((h) => `${hostLine(h)}\n`).join("")}`;
  const varEntries = iniVars(vars);
  if (varEntries.length === 0) return lines;
  return `${lines}\n[${group}:vars]\n${varEntries.map((v) => `${v}\n`).join("")}`;
}

// Render an Ansible INI inventory from
// {group: {hosts: [{name: "zk1", vars: {ansible_host: "172.17.0.3"}}, ...],
//          vars: {ansible_user: "root"}}}.
// Groups and vars are emitted in sorted order for deterministic output.
export function inventoryIni(groups: Record<string, InventoryGroup>): string {
  return Object.entries(groups)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(groupSection)
    .join("\n");
}

type InventoryGroups =
  | Record<string, InventoryGroup>
  | ((opts: Opts) => Record<string, InventoryGroup>);

// Build a `before` advice that writes an INI inventory to the file returned
// by fileFn(opts) before the step runs. `groups` is the inventory data (see
// `inventoryIni`), or a function of opts returning it.
export function inventoryAdvice(fileFn: (opts: Opts) => string, groups: InventoryGroups) {
  return (opts: Opts): Opts => {
    const file = fileFn(opts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, inventoryIni(typeof groups === "function" ? groups(opts) : groups));
    return opts;
  };
}
