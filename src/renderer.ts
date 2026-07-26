// Small Selmer-compatible renderer for the subset red exercises.
//
// Supported:
// - Variables with dotted paths: {{name}}, {{node.id}}; missing values -> "".
// - HTML escaping by default; the `safe` filter bypasses escaping.
// - `for` loops and `if` blocks; blocks may nest.
// - Filter pipelines: `safe`, `not-empty`, and `sort(attribute='field')`.
// - Selmer-style delimiter overrides: tagOpen/tagClose/filterOpen/filterClose
//   are single-character pieces. Defaults make variables {{ }} and tags {% %};
//   e.g. {tagOpen:"<", tagClose:">", filterOpen:"{", filterClose:"}"}
//   makes variables <{ }> and tags <% %>, leaving Jinja2 {{ }}/{% %} intact.

export interface RenderOpts {
  tagOpen?: string;
  tagClose?: string;
  filterOpen?: string;
  filterClose?: string;
  [key: string]: unknown;
}

interface Delimiters {
  varOpen: string;
  varClose: string;
  tagOpen: string;
  tagClose: string;
}

interface EvalResult {
  value: unknown;
  safe: boolean;
}

function delimiters(opts?: RenderOpts): Delimiters {
  const tagOpen = opts?.tagOpen ?? "{";
  const tagClose = opts?.tagClose ?? "}";
  const filterOpen = opts?.filterOpen ?? "{";
  const filterClose = opts?.filterClose ?? "}";
  return {
    varOpen: `${tagOpen}${filterOpen}`,
    varClose: `${filterClose}${tagClose}`,
    tagOpen: `${tagOpen}%`,
    tagClose: `%${tagClose}`,
  };
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#x27;";
      default:
        return ch;
    }
  });
}

function valueString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function splitPipeline(expr: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    const prev = expr[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "|" && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

function splitPath(path: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let bracketDepth = 0;
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i]!;
    const prev = path[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === "." && bracketDepth === 0) {
      parts.push(path.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(path.slice(start).trim());
  return parts.filter(Boolean);
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return t;
}

function lookup(ctx: Record<string, unknown>, expr: string): unknown {
  const trimmed = expr.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "nil") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return unquote(trimmed);
  }

  let cur: unknown = ctx;
  for (const segment of splitPath(trimmed)) {
    if (cur === null || cur === undefined) return undefined;
    const key = unquote(segment);
    if (Array.isArray(cur) && /^\d+$/.test(key)) {
      cur = cur[Number(key)];
    } else if ((typeof cur === "object" || typeof cur === "function") && key in Object(cur)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function sortValue(value: unknown, filter: string): unknown {
  if (value == null) return [];
  const items = Array.isArray(value)
    ? [...value]
    : typeof (value as Iterable<unknown>)?.[Symbol.iterator] === "function"
      ? Array.from(value as Iterable<unknown>)
      : [];
  const attr = /attribute\s*=\s*(['"])(.*?)\1/.exec(filter)?.[2];
  return items.sort((a, b) =>
    compareValues(attr ? lookup({ item: a }, `item.${attr}`) : a, attr ? lookup({ item: b }, `item.${attr}`) : b),
  );
}

function applyFilter(result: EvalResult, filter: string): EvalResult {
  const name = filter.split(/[(:\s]/, 1)[0]?.trim();
  switch (name) {
    case "safe":
      return { ...result, safe: true };
    case "sort":
      return { value: sortValue(result.value, filter), safe: result.safe };
    case "not-empty": {
      const value = result.value;
      const nonEmpty =
        value !== null && value !== undefined &&
        (!(typeof value === "string" || Array.isArray(value)) || value.length > 0) &&
        (!(typeof value === "object") || Array.isArray(value) || Object.keys(value as object).length > 0);
      return { value: nonEmpty ? value : null, safe: result.safe };
    }
    default:
      // Unknown filters are deliberately conservative: keep the value as-is.
      // This mirrors the renderer's small-subset role without corrupting data.
      return result;
  }
}

function evalExpr(expr: string, ctx: Record<string, unknown>): EvalResult {
  const [head, ...filters] = splitPipeline(expr);
  let result: EvalResult = { value: lookup(ctx, head ?? ""), safe: false };
  for (const filter of filters) result = applyFilter(result, filter);
  return result;
}

function renderValue(expr: string, ctx: Record<string, unknown>): string {
  const { value, safe } = evalExpr(expr, ctx);
  const s = valueString(value);
  return safe ? s : htmlEscape(s);
}

function toIterable(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof (value as Iterable<unknown>)?.[Symbol.iterator] === "function") {
    return Array.from(value as Iterable<unknown>);
  }
  if (typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

function parseFor(tag: string): { name: string; expr: string } | null {
  const m = /^for\s+([^\s]+)\s+in\s+([\s\S]+)$/.exec(tag.trim());
  if (!m) return null;
  return { name: m[1]!, expr: m[2]!.trim() };
}

function parseIf(tag: string): string | null {
  const m = /^if\s+([\s\S]+)$/.exec(tag.trim());
  return m?.[1]?.trim() ?? null;
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function findMatchingIf(
  content: string,
  bodyStart: number,
  d: Delimiters,
): { thenEnd: number; elseStart?: number; elseEnd?: number; afterEnd: number } {
  let depth = 1;
  let idx = bodyStart;
  let elseTag: { start: number; end: number } | undefined;
  while (idx < content.length) {
    const tagStart = content.indexOf(d.tagOpen, idx);
    if (tagStart < 0) break;
    const contentStart = tagStart + d.tagOpen.length;
    const tagEnd = content.indexOf(d.tagClose, contentStart);
    if (tagEnd < 0) break;
    const tag = content.slice(contentStart, tagEnd).trim();
    if (parseIf(tag)) depth += 1;
    else if (tag === "endif") {
      depth -= 1;
      if (depth === 0) {
        return {
          thenEnd: elseTag?.start ?? tagStart,
          ...(elseTag ? { elseStart: elseTag.end, elseEnd: tagStart } : {}),
          afterEnd: tagEnd + d.tagClose.length,
        };
      }
    } else if (tag === "else" && depth === 1) {
      elseTag = { start: tagStart, end: tagEnd + d.tagClose.length };
    }
    idx = tagEnd + d.tagClose.length;
  }
  throw new Error("unterminated if block in template");
}

function findMatchingEndfor(
  content: string,
  bodyStart: number,
  d: Delimiters,
): { bodyEnd: number; afterEnd: number } {
  let depth = 1;
  let idx = bodyStart;
  while (idx < content.length) {
    const tagStart = content.indexOf(d.tagOpen, idx);
    if (tagStart < 0) break;
    const tagContentStart = tagStart + d.tagOpen.length;
    const tagEnd = content.indexOf(d.tagClose, tagContentStart);
    if (tagEnd < 0) break;
    const tag = content.slice(tagContentStart, tagEnd).trim();
    if (parseFor(tag)) {
      depth += 1;
    } else if (tag === "endfor") {
      depth -= 1;
      if (depth === 0) return { bodyEnd: tagStart, afterEnd: tagEnd + d.tagClose.length };
    }
    idx = tagEnd + d.tagClose.length;
  }
  throw new Error("unterminated for loop in template");
}

function nextToken(content: string, idx: number, d: Delimiters) {
  const varAt = content.indexOf(d.varOpen, idx);
  const tagAt = content.indexOf(d.tagOpen, idx);
  if (varAt < 0 && tagAt < 0) return null;
  if (varAt >= 0 && (tagAt < 0 || varAt <= tagAt)) return { kind: "var" as const, at: varAt };
  return { kind: "tag" as const, at: tagAt };
}

function renderBlock(content: string, ctx: Record<string, unknown>, d: Delimiters): string {
  let out = "";
  let idx = 0;
  while (idx < content.length) {
    const tok = nextToken(content, idx, d);
    if (!tok) {
      out += content.slice(idx);
      break;
    }
    out += content.slice(idx, tok.at);
    if (tok.kind === "var") {
      const exprStart = tok.at + d.varOpen.length;
      const exprEnd = content.indexOf(d.varClose, exprStart);
      if (exprEnd < 0) {
        out += content.slice(tok.at);
        break;
      }
      out += renderValue(content.slice(exprStart, exprEnd).trim(), ctx);
      idx = exprEnd + d.varClose.length;
    } else {
      const tagStart = tok.at + d.tagOpen.length;
      const tagEnd = content.indexOf(d.tagClose, tagStart);
      if (tagEnd < 0) {
        out += content.slice(tok.at);
        break;
      }
      const tag = content.slice(tagStart, tagEnd).trim();
      const loop = parseFor(tag);
      const condition = parseIf(tag);
      if (loop) {
        const bodyStart = tagEnd + d.tagClose.length;
        const { bodyEnd, afterEnd } = findMatchingEndfor(content, bodyStart, d);
        const body = content.slice(bodyStart, bodyEnd);
        const { value } = evalExpr(loop.expr, ctx);
        for (const item of toIterable(value)) {
          out += renderBlock(body, { ...ctx, [loop.name]: item }, d);
        }
        idx = afterEnd;
      } else if (condition) {
        const bodyStart = tagEnd + d.tagClose.length;
        const match = findMatchingIf(content, bodyStart, d);
        const { value } = evalExpr(condition, ctx);
        const body = truthy(value)
          ? content.slice(bodyStart, match.thenEnd)
          : match.elseStart === undefined
            ? ""
            : content.slice(match.elseStart, match.elseEnd);
        out += renderBlock(body, ctx, d);
        idx = match.afterEnd;
      } else if (["endfor", "endif", "else"].includes(tag)) {
        // Matching closing tags are consumed by their block handlers.
        idx = tagEnd + d.tagClose.length;
      } else {
        // Unsupported tags render empty rather than leaking template syntax into
        // generated infrastructure config.
        idx = tagEnd + d.tagClose.length;
      }
    }
  }
  return out;
}

export function render(
  content: string,
  data: Record<string, unknown> = {},
  opts?: RenderOpts,
): string {
  return renderBlock(String(content), data, delimiters(opts));
}
