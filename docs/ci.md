# Gate your agent's routing in CI

LoopBench commands exit non-zero when a threshold is breached, so you can block a merge that makes
your agent's tool routing worse.

## Fast gate, no API key

Catch confusable tool names before they ship. Deterministic, runs in milliseconds.

```bash
npx loopbench audit --tools ./tools.json --fail-on-high
# exits 1 if any HIGH-risk confusable pair exists (e.g. get_status vs fetch_status)
```

## Full robustness gate (needs a model)

Synthesize a test intent per tool, run the six attacks, and fail if the worst attacked accuracy drops
below your floor.

```bash
npx loopbench attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
# exits 1 if any attack pushes routing accuracy under 70%
```

Multi-step tasks have their own gate:

```bash
npx loopbench multi --suite ./tasks.json --provider openai --model gpt-5.5 --fail-under 80
# exits 1 if multi-step task success is under 80%
```

## GitHub Actions

```yaml
name: routing-robustness
on: [pull_request]
jobs:
  loopbench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      # fast, no secret needed:
      - run: npx loopbench audit --tools ./tools.json --fail-on-high
      # full gate (add OPENAI_API_KEY as a repo secret):
      - run: npx loopbench attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Keys are read from the environment only. Point `OPENAI_BASE_URL` at any OpenAI-compatible gateway.
