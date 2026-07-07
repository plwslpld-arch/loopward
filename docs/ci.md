# Gate your agent's routing in CI

English | [简体中文](./ci.zh-CN.md)

Loopward commands exit non-zero when a threshold is breached, so you can block a merge that makes
your agent's tool routing worse.

## Fast gate, no API key

Catch confusable tool names before they ship. Deterministic, runs in milliseconds.

```bash
npx loopward audit --tools ./tools.json --fail-on-high
# exits 1 if any HIGH-risk confusable pair exists (e.g. get_status vs fetch_status)
```

## Full robustness gate (needs a model)

Synthesize a test intent per tool, run the six attacks, and fail if the worst attacked accuracy drops
below your floor.

```bash
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
# exits 1 if any attack pushes routing accuracy under 70%
```

Multi-step tasks have their own gate:

```bash
npx loopward multi --suite ./tasks.json --provider openai --model gpt-5.5 --fail-under 80
# exits 1 if multi-step task success is under 80%
```

## Regression gate against a baseline

`--fail-under` is an absolute floor. `gate` is the *relative* gate: it fails only when the current run is
significantly worse than a saved baseline, using the same case-paired bootstrap + Holm correction the rest of
the suite uses — so a single case flipping under temperature-0 jitter won't trip a false alarm.

```bash
# once: save a baseline you trust
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --out baseline.json
# in CI: produce the current report, then gate it
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --out cur.json
npx loopward gate   --baseline baseline.json --report cur.json
# exits 1 only if clean or any attack regressed (Holm-p < 0.05 AND the drop's CI lower bound clears --tolerance)
```

It refuses to compare across a different model, variant, or tool schema (guard errors), and a dropped attack
counts as a coverage regression. Add `--tolerance 3` to require the drop to exceed 3 points before it fails.

## Stop-axis fragility gate

Probe the *halt* decision (not routing) and fail if a stop-bias nudge significantly moves premature-stop,
over-run, or success in its pre-registered direction:

```bash
npx loopward multi --suite ./tasks.json --provider openai --model gpt-5.5 --stop-axis --fail-on-fragile
# exits 1 if any non-control nudge is Holm-significant (the neutral control is a placebo and is ignored)
```

## SARIF for GitHub code scanning

Emit the confusable-pair findings as SARIF 2.1.0 so they appear as code-scanning alerts:

```bash
npx loopward audit --tools ./tools.json --sarif loopward.sarif
```

Then upload with `github/codeql-action/upload-sarif`. Findings are heuristic name/description overlaps, so they
top out at `warning`/`note` and never claim a security severity.

## Sticky PR comment + badge

Drop in [`.github/workflows/loopward-pr.yml`](../.github/workflows/loopward-pr.yml) to post one robustness table
per PR (upserted by a hidden marker — never spammed). Set the `LOOPWARD_MODEL_KEY` secret to run the full
attacked-accuracy table; without it, same-repo PRs get an audit-only comment and forks degrade to the job step
summary (fork code never sees a write token or secrets). The [`pages.yml`](../.github/workflows/pages.yml)
workflow publishes a shields endpoint badge (`robustness.json`) and the live dashboard from the default branch.

## GitHub Actions

```yaml
name: routing-robustness
on: [pull_request]
jobs:
  loopward:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      # fast, no secret needed:
      - run: npx loopward audit --tools ./tools.json --fail-on-high
      # full gate (add OPENAI_API_KEY as a repo secret):
      - run: npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Keys are read from the environment only. Point `OPENAI_BASE_URL` at any OpenAI-compatible gateway.
