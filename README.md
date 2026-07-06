<!--
  Clean-room project. No prior-employer or third-party source, data, or naming. See PROVENANCE.md.
  Working title "Loopward" is pending a name-collision check before any public launch.
-->

# Loopward

Point it at your agent's tools and it tells you which ones the router will mix up, how badly a one-line
prompt tweak breaks routing, and it hands you the failures back as training data. Everyone is designing agent
loops. Almost nobody is checking whether the loop's *decisions* hold up. That is the gap this fills.

A dozen frontier models all route tools with 100% accuracy on clean inputs in our suite. Add one injected line and
the drop ranges from 0 points (Claude Opus-4-8 shrugs it off) to 100 (Gemini-3.1-pro gets it wrong every time).
See [`docs/findings.md`](./docs/findings.md).

## Quickstart

No install, no build. Needs Node 24+ (native TypeScript).

```bash
# 1) Which of your tools will confuse the router? Deterministic, no API key, instant.
npx loopward audit --tools ./my-tools.json

# 2) Stress-test routing on your own tools with a real model (6 attacks + confidence intervals).
OPENAI_API_KEY=sk-... npx loopward attack --tools ./my-tools.json --provider openai --model gpt-5.5

# 3) Turn the failures into DPO / reward / SFT training data.
npx loopward coevo --report runs/attack-*.json --out ./coevo-out
```

`--tools` takes the same tool schema you already pass to the model. OpenAI's function-calling format:

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

## What it does

- **audit** flags confusable tool pairs by name and description similarity, with no model calls. It catches the
  classic trap where `get_status`, `fetch_status`, and `query_status` all look the same to a router.
- **attack** synthesizes a test intent per tool, then perturbs it six ways (injection, terse phrasing, lookalike
  names, two-in-one requests, overlapping tools, negation) and reports how far accuracy falls, with a paired
  bootstrap 95% interval. Scoring is a deterministic ground-truth oracle, not an LLM judge.
- **multi** runs a real multi-step loop and scores the failures single-turn routing can't see: stopping too
  early, never stopping, wrong step.
- **coevo** exports every misroute as preference pairs, verifiable-reward samples, and SFT negatives. This is the
  model-and-harness co-evolution loop: the harness's failures become the model's training signal.

Works with any OpenAI-compatible endpoint. Keys and base URLs come from the environment, so nothing secret lives
in the repo. Point `OPENAI_BASE_URL` at your gateway of choice.

## Gate it in CI

```bash
npx loopward audit  --tools ./tools.json --fail-on-high            # fast, no key
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
```

Both exit non-zero when the threshold is breached. Full setup in [`docs/ci.md`](./docs/ci.md).

## What this is not

Not a leaderboard, not a safety audit, not a loop *runner* you ship to production. It is a diagnostic for the
routing and stopping decisions inside a loop. Loopward does not claim to be the first tool to evaluate tool
selection. See [`RELATED-WORK.md`](./RELATED-WORK.md) for an honest comparison with CATS/ToolCert, MetaTool, and
Harness-Bench, and the specific delta.

## Findings

Reproducible results (12 models) live in [`docs/findings.md`](./docs/findings.md). Short version: routing
robustness is model-specific and does not track capability. The attacks that actually work are the boring ones
(terse requests, lookalike names), not the adversarial-looking ones. And feeding tool observations back in a
multi-step loop moved task success from 10% to 60% on the same model, which says the harness decides the outcome
as much as the model does.

## Layout

```
packages/core      loop runner, routing oracle, providers, multi-step, tool audit + intent synthesis
packages/redteam   6 attack classes, robustness metrics, bootstrap CI
packages/coevo     export failures as training signal
packages/cli       run / attack / multi / audit / coevo
packages/dashboard self-contained findings dashboard (GitHub Pages)
datasets           routing, multistep, and tool-schema suites
```

Run the checks with `npm test` (offline, no key). Design notes in [`docs/`](./docs).

## Provenance and license

Independent clean-room implementation. No prior-employer or third-party code, data, or naming. See
[`PROVENANCE.md`](./PROVENANCE.md). Apache-2.0.
