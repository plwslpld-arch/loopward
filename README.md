<!-- Clean-room project. No prior-employer or third-party source, data, or naming. See PROVENANCE.md. -->

<div align="center">

<img src="assets/logo.png" width="96" alt="Loopward" />

# Loopward

**Put your agent's harness under test.** Find where routing and stopping break on your own tools, change the harness, and prove with a deterministic oracle that the change moved the number.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/loopward.svg)](https://www.npmjs.com/package/loopward)
[![CI](https://github.com/plwslpld-arch/loopward/actions/workflows/ci.yml/badge.svg)](https://github.com/plwslpld-arch/loopward/actions/workflows/ci.yml)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](./package.json)
[![routing robustness](https://img.shields.io/endpoint?url=https%3A%2F%2Fplwslpld-arch.github.io%2Floopward%2Frobustness.json)](https://plwslpld-arch.github.io/loopward/)

English | [简体中文](./README.zh-CN.md)  ·  [**Live findings dashboard →**](https://plwslpld-arch.github.io/loopward/)

</div>

Every tool-using agent makes the same call over and over: *which tool*. Loopward tests only that decision, using
your own tools, scored by a deterministic ground-truth oracle (no LLM judge). It audits confusable tool names,
red-teams routing six ways, proposes and re-verifies fixes, compares loop strategies, and turns failures into a
measured lift. Everyone is designing agent loops; almost nobody checks whether the loop's *decisions* hold up.

> Thirteen frontier models route tools near-perfectly on clean inputs in our suite (most at 100%, none below 90%).
> Add one injected line and the drop ranges from **0 points** (Claude Opus-4-8 barely moves) to **100** (Gemini-3.1-pro
> gets it wrong on every case in this suite). Single-seed, n=42 — a pilot, not a ranking. See [`docs/findings.md`](./docs/findings.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/heatmap-dark.svg">
  <img alt="Model × attack routing-robustness heatmap: each cell is the accuracy points lost to that attack (green held, red broke); the signed number is printed in every cell, so it reads without color. Rows are 13 models, columns are the 6 attacks, sorted by prompt injection." src="assets/heatmap.svg" width="100%">
</picture>

<sub>Points of routing accuracy lost to each attack. Green held, red broke; the number is in every cell (colorblind-safe). Single seed, n=42, deterministic oracle — a pilot, not a verdict. The [live dashboard](https://plwslpld-arch.github.io/loopward/) has hover detail and a bilingual toggle.</sub>

## Quickstart

No install step. `npx` runs the published build; nothing to compile on your side. Needs Node 24+.

```bash
# 1) Which of your tools will confuse the router? Deterministic, no API key, instant.
npx loopward audit --tools ./my-tools.json

# 2) Stress-test routing on your own tools with a real model (6 attacks + confidence intervals).
OPENAI_API_KEY=sk-... npx loopward attack --tools ./my-tools.json --provider openai --model gpt-5.5

# 3) Propose a fix and prove it moved the number.
OPENAI_API_KEY=sk-... npx loopward fix --tools ./my-tools.json --provider openai --model gpt-5.5
```

Or run `npx loopward` with no command for a guided setup.

`--tools` takes the same schema you already pass to the model — OpenAI's function-calling format:

```json
{
  "tools": [
    { "type": "function", "function": { "name": "get_status",     "description": "Get the current status of a service or job." } },
    { "type": "function", "function": { "name": "fetch_status",   "description": "Fetch the latest status for a given resource." } },
    { "type": "function", "function": { "name": "refund_payment", "description": "Issue a refund for a completed payment." } }
  ]
}
```

Anthropic's `{ name, description, input_schema }` array and a plain `[{ name, description }]` list both work too.

## Commands

| Command | What it does |
|---|---|
| `audit`    | Flags the tool names a router will mix up (`get_status` vs `fetch_status`). No model call, milliseconds. |
| `attack`   | Rewrites each request six ways and reports how far routing fell, with paired-bootstrap 95% CIs. |
| `fix`      | Proposes a clearer rename for the confusable tools, then re-verifies the delta through the same oracle. |
| `matrix`   | Runs the same attacks through `single` / `self-check` / `react` / `observe` on a *fixed* model — the harness under test. |
| `flywheel` | Splits your cases, turns failures into a guardrail, and measures the held-out routing lift with a CI. |
| `multi`    | Runs a real multi-step loop and scores what single-turn routing can't see: premature-stop, over-run, success. Add `--stop-axis` to probe the *halt* decision. |
| `gate`     | Fails CI (exit 1) when routing regressed vs a saved baseline — case-paired bootstrap + Holm, not a flaky fixed threshold. |
| `multiseed`| Runs N seeds and reports the across-seed spread honestly (seed is the replication unit; case-pairs are never pooled). |
| `mcp-tools`| Imports a live MCP server's tool catalog over stdio, so every command above works on the exact schema it ships. |
| `coevo`    | Exports every misroute as DPO preference pairs, verifiable-reward samples, and SFT negatives. |
| `stats`    | Re-scores a report with a one-sided permutation test + Holm correction (works on attack *and* stop-axis reports). |
| `verify`   | Re-derives a report's deterministic fields offline (hashes, accuracy, seeded CIs) and checks they agree. |

The three that make it more than one-more-eval:

- **`fix`** turns the diagnostic into a controller. The rename is a model-made *suggestion*; the re-measurement that
  proves it is strictly deterministic — a thing an LLM-judged eval structurally cannot claim.
- **`matrix`** treats the harness as the independent variable. On GLM-5.1 a self-check node *recovers* +6.9pp under
  attack (CI excludes 0); the same node *hurt* deepseek-chat. Whether a loop upgrade helps is a property of the
  model-and-harness pair, not the harness alone.
- **`flywheel`** closes the model↔harness loop end to end and measures a held-out lift — the co-evolution story shown,
  not asserted. It stays a demo (inject-and-re-measure), never a trainer.

## Honest by construction

Scored by a fixed ground-truth oracle, never an LLM judge. Every run carries a provenance manifest (seed,
tool-schema hash, oracle version, model id, git sha). `loopward verify` re-checks it offline; `npm run
regenerate-all` proves the mock pipeline reproduces byte-for-byte; and `stats` applies Holm correction so a
"significant" badge survives six simultaneous comparisons. A runtime guard makes a perturbation fail loud rather
than ever silently change the correct answer.

## Models and keys

Works with any OpenAI-compatible endpoint. First-party presets (`openai`, `deepseek`, `moonshot`, `dashscope`,
`groq`, `together`, `siliconflow`) bake in the base URL; anything else works with `--provider openai --base-url <url>`.
Keys come from the environment, one variable per provider, so nothing secret lives in the repo. Full list and
examples in [`docs/providers.md`](./docs/providers.md).

## Bring tools from an MCP server

Point loopward at a running MCP server and it pulls the exact tool catalog the server ships (JSON-RPC over
stdio, zero deps), so you audit the real thing instead of a hand-copied schema:

```bash
npx loopward mcp-tools --server "npx -y @modelcontextprotocol/server-everything" --out tools.json
npx loopward audit --tools tools.json
```

`--server` executes the command you give it locally, so only import from servers you trust. A saved
`tools/list` response also works fully offline with `--from saved.json`. The written file carries a
`_source` provenance block (server, protocol version, tool count, hash) — an MCP catalog is a point-in-time
snapshot, and the file says so.

## Gate it in CI

```bash
npx loopward audit  --tools ./tools.json --fail-on-high                                       # fast, no key
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70 --out cur.json
npx loopward gate   --baseline baseline.json --report cur.json                                # regressed vs baseline?
```

`--fail-under` is an absolute floor; `gate` is the relative counterpart — it fails only when the current run is
*significantly* worse than a saved baseline (case-paired bootstrap, Holm-corrected), so one flipped case from
temperature-0 jitter won't trip it. Also emit SARIF for GitHub code scanning with `audit --sarif out.sarif`, and
drop the ready-made [`loopward-pr`](.github/workflows/loopward-pr.yml) workflow in to get a sticky robustness
comment on every PR. Full setup in [`docs/ci.md`](./docs/ci.md).

## Findings

Reproducible results across 13 models live in [`docs/findings.md`](./docs/findings.md). The short version:
routing robustness is model-specific and does not track capability; the attacks that actually work are the boring
ones (terse requests, lookalike names), not the adversarial-looking ones; a naive self-check loop can help one
model and hurt another; and feeding tool observations back in a multi-step loop moved task success from 10% to 60%
on the same model. The harness decides the outcome as much as the model does.

## What this is not

Not a leaderboard, not a safety audit, not a loop *runner* you ship to production. It is a diagnostic-and-fix tool
for the routing and stopping decisions inside a loop. It does not claim to be the first to evaluate tool selection.
See [`RELATED-WORK.md`](./RELATED-WORK.md) for an honest comparison with CATS/ToolCert, MetaTool, and Harness-Bench.

## Layout

```
packages/core       loop runner + strategies, routing oracle, providers, multi-step, tool audit, manifest, MCP + SARIF
packages/redteam    6 attack classes, robustness metrics + bootstrap CI, fix, meaning guard, stop-axis probe
packages/eval       harness-matrix, stats (Holm), verify (report linter), gate (regression), seed-sweep (multi-seed)
packages/coevo      export failures as training signal; micro-loop flywheel experiment
packages/cli        audit / attack / fix / matrix / flywheel / multi / gate / multiseed / mcp-tools / coevo / stats / verify
packages/ci         pure PR-comment + shields-badge renderer (formats reports; never scores)
packages/dashboard  self-contained bilingual findings dashboard (deployed to GitHub Pages)
harnesses           the 4 loop strategies as "specimens under test" (matrix's independent variable) + when each helps/hurts
datasets            routing, multistep, tool-schema, and gold-label suites
```

Run the checks with `npm test` (offline, no key). Design notes in [`docs/`](./docs).

## Provenance and license

Independent clean-room implementation. No prior-employer or third-party code, data, or naming. See
[`PROVENANCE.md`](./PROVENANCE.md). Apache-2.0.
