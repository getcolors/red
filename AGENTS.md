# AGENTS.md

## What this is

`red` is the TypeScript/Bun workflow SDK of Colors. Green (Clojure/Babashka)
is canonical; red and Blue (Python/uv) implement the same model. Keep DAGs,
subworkflows and the full advice system, including inheritance, ordering and
inspection. Keep engine-level slicing and YAML/environment configuration
helpers. Applications own CLI parsing, file discovery, validation, planning,
progress, logging and durable recovery; do not restore removed convenience
modules or OpenTofu/Ansible integration.

Read README.md before changes. `SPEC.md` is the behavioral contract and
`index.html` publishes it. Keep all three accurate. This repository contains
TypeScript/Bun only; do not add other language implementations.

## Commands

```sh
bun install
bun test
bun run typecheck
```

`examples/hello/red` is an application-owned CLI; its create/delete/dry-run
commands are not SDK entry points. Tests exercise it with temporary files.
Keep its DAG, embedded greeting workflow and inherited application advice
working. Source tests are discovered under `test/*.test.ts`.

## Architecture and conventions

- `src/workflow.ts` owns static/dynamic graphs, parallel joins, failed-fork
  collapse, input freezing, error conversion and subworkflow composition.
  Steps return new options objects. Keep workflow constructors pure.
- `src/advice.ts` owns the ten Emacs nadvice-style combinators and immutable
  registries. Keep depth/add ordering, same-id replacement, transitive
  inheritance by flat step name and `advicePlan` inspection consistent.
- `src/cli.ts` retains its historical module path for `loadYaml`, `readPars`
  and `parName`. There is no parser, runner, file discovery or process-exit
  policy in the SDK. Bun supplies YAML parsing without a runtime dependency.
- Engine keys are `red/*` and private `red.*/*`; applications use their own
  namespace for events, paths, preview flags and results. Environment inputs
  remain flat kebab-case. Never merge arbitrary provider output at top level.
- Subworkflow output adapters must preserve or deliberately handle failures.
  Parent advice can target nested step names; use namespaced names.
- No npm release exists: external dependencies must use a published git SHA,
  not unpinned auto-install imports. In-repo examples use relative imports.
- Ignore `node_modules/`, `dist/`, `target/`, and example `work/` directories.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

The page is styled like www.getcolors.ai (IBM Plex Sans/Mono, the shared
`oklch` tokens, the site's sticky header and footer) and matches the green and
blue pages; only `--accent` differs (`var(--red)` here). Keep it light-only,
free of horizontal scroll at phone width, and accurate to `SPEC.md`.
