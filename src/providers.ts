import type { Opts } from "./workflow.ts";

export type Registry = Record<string, Record<string, { required?: string[]; secrets?: string[]; tofuEnv?: Record<string, string> }>>;
export const placeholder = (value: unknown) => value == null || (typeof value === "string" && (!value.trim() || value.toUpperCase() === "REPLACE_ME"));
export const entry = (registry: Registry, opts: Opts, slot: string) => registry[slot]?.[String(opts[slot])];
export function selected(registry: Registry, opts: Opts, slots: string[]) { return Object.fromEntries(slots.map((slot) => [slot, entry(registry, opts, slot)])); }
export function slotKeys(registry: Registry, opts: Opts, slots: string[], field: "required" | "secrets") { return slots.flatMap((slot) => entry(registry, opts, slot)?.[field] ?? []); }
export const missingKeys = (opts: Opts, keys: string[]) => keys.filter((key) => placeholder(opts[key]));
export function selectionErrors(registry: Registry, opts: Opts, slots: string[]) { return slots.flatMap((slot) => entry(registry, opts, slot) ? [] : [`${slot} has unsupported provider: ${opts[slot]}`]); }
export function requiredErrors(registry: Registry, opts: Opts, slots: string[], own: string[] = []) { return missingKeys(opts, [...slotKeys(registry, opts, slots, "required"), ...own]).map((key) => `${key} is required`); }
export function secretErrors(registry: Registry, opts: Opts, slots: string[], own: string[], parName: (key: string) => string) { return missingKeys(opts, [...slotKeys(registry, opts, slots, "secrets"), ...own]).map((key) => `${parName(key)} is required`); }
export const tofuEnv = (registry: Registry, opts: Opts, slot: string) => entry(registry, opts, slot)?.tofuEnv ?? {};
export function toolEnv(registry: Registry, opts: Opts, slots: string[]) { const mapping = Object.assign({}, ...slots.map((slot) => tofuEnv(registry, opts, slot))); const env = Object.fromEntries(Object.entries(mapping).flatMap(([key, name]) => placeholder(opts[key]) ? [] : [[name, String(opts[key])]])); return Object.keys(env).length ? env : undefined; }
export function refuseOverlay(env: Record<string, string | undefined>, key: string, reason: string, parName: (key: string) => string) { const name = parName(key); return env[name] ? [`${name} is set; ${reason}`] : []; }
