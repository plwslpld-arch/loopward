# Roadmap

Realistic solo timeline: **2 weeks = defensible MVP, 3–4 weeks = strong.** Every week ships a verifiable artifact.
Ship nothing publicly until MVP is reached (a shallow demo backfires).

## W1 — kernel runs, produce clean data  ✅ DONE
- ✅ Independent git root under personal identity/email. IP + novelty hygiene files first (LICENSE, PROVENANCE, RELATED-WORK).
- ✅ `core`: 5-node loop (perceive → route → act → verify → stop) + `single` variant. `act` is a no-op for routing-only; multi-step arrives W3.
- ✅ Provider abstraction: `mock` (deterministic, zero-dep, offline) + `deepseek` (OpenAI-compatible via plain fetch, needs `DEEPSEEK_API_KEY`).
- ✅ Structured trajectory trace (JSONL) + `RoutingOracle` (deterministic ground-truth scoring) + JSON suite loader with validation.
- ✅ **Verify:** `node packages/core/src/cli.ts run --suite datasets/routing/sample.json` → `10/12 = 83.3%` (mock) + trajectory JSONL. Self-check: `node packages/core/src/selfcheck.ts`.
- ⏭️ Deferred: Vercel AI SDK (routing is a single structured call — plain fetch is right; adopt the SDK at W3 for real multi-step tool-calling). YAML datasets (JSON for now).

## W2 — adversarial + robustness metrics  (core DONE; MVP line needs a real-model run)
- ✅ `redteam`: 6 attack classes (deterministic intent-side transforms, each with public-source tag) + attack-runner.
- ✅ metrics: accuracy / misroute_rate / robustness_delta + paired bootstrap 95% CI (seeded, reproducible). (over-run / premature-stop need multi-step → W3.)
- ✅ `loopbench attack` → per-attack acc + delta + CI table, heatmap-ready matrix (attack × case) JSON.
- ⏭️ `self-check` variant deferred to W3: with the mock a 2nd variant is contrived; it's only a meaningful comparison against a reasoning provider.
- ⚠️ **Not yet the finding.** Mock numbers only prove the pipeline (mock is a fragile token-overlap stand-in, so deltas are huge). The publishable, counter-intuitive finding needs a **real-model run** (`--provider deepseek`, needs `DEEPSEEK_API_KEY`). Do that before any public post.
- **Verify (done):** `loopbench attack --suite datasets/routing/sample.json` → 6-row delta+CI table.

## W3 — 2nd variant + co-evolution loop + portability  (the soul — do not cut)
- `variants`: `planner-subagent` (dispatch = prime `cross_skill_confusion` surface).
- `tasks`: multistep set with deterministic verifier; eval delta view.
- `coevo`: export failures → preference pairs / verifiable reward / SFT negatives + a micro-experiment
  (small open model LoRA/preference, or rigorous offline reward modeling) showing "feed failures back → measurable robustness gain".
- `eval/harness-portability`: same suite across ≥2 real harnesses; variance decomposition (harness property vs model property).
- **Verify:** a "harness vs model" variance chart + a micro-experiment before/after curve.

## W4 — dashboard + docs + launch materials
- `dashboard`: Vite/React static export → GitHub Pages (leaderboard / attack×variant heatmap / trajectory viewer / delta).
- README final (hook + prior-art table + reproduce steps).
- Two long-form writeups (掘金 code/repro, 知乎 insight); X launch thread + Show HN; awesome-list PRs.
- SWE-bench-lite only if time permits (10–20 instances via an existing harness adapter) — always optional.

## Never
- Do not build a self-authored executable real-task benchmark with an oracle judge (collides with Harness-Bench, hits weak spots, sinks the timeline).
- Do not claim "first to evaluate routing robustness."
- Do not mention DeepSeek / job search / any employer in public materials.
