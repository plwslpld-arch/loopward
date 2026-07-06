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
- ✅ **First real finding (F1, see docs/findings.md).** `deepseek-chat` on the 42-case `tools.json`: 100% clean, but 5/6 attacks drop it 12–43pp with CIs excluding zero. Counter-intuitive ranking: `minimal_context` + `boundary_blur` dominate; `negation_trap` is null. Pilot-grade (1 model / 1 seed / 1 suite).
- **Verify (done):** `loopbench attack --suite datasets/routing/tools.json --provider deepseek` → 6-row delta+CI table + docs/findings.md.
- 🔜 To make F1 publishable: ≥2 models + ≥3 seeds + per-family breakdown + the `self-check` variant (moved here from the deferred list).

## W3 — co-evolution loop + variants + breadth  (the soul — do not cut)
- ✅ `coevo`: export failures → preference pairs / verifiable reward / SFT negatives (`loopbench coevo`). Verified on deepseek: 17 real misroutes → 17 pref pairs / 34 reward / 17 sft.
- ✅ `self-check` variant (reflect decision node) wired through run/attack/CLI (`--variant`).
- ✅ Provider generalized to env-injected OpenAI-compatible → multi-model breadth (deepseek + gpt/claude/gemini via any gateway; no secrets in repo).
- 🔄 Running: 4-model breadth table (deepseek ✅ + gpt-5.4 ✅ + claude/gemini in flight) → cross-model vulnerability fingerprints. GPT-5.4 bombshell: semantic_injection 100%→2.4% (Δ+97.6pp) while deepseek only +23.8pp.
- 🔄 Running: single vs self-check variant experiment (does reflection recover attack-induced misroutes?).
- 🔜 `planner-subagent` variant + micro-experiment (offline reward analysis showing "feed failures back → measurable robustness gain") + harness-portability variance decomposition.

## W4 — dashboard + docs + launch materials
- `dashboard`: Vite/React static export → GitHub Pages (leaderboard / attack×variant heatmap / trajectory viewer / delta).
- README final (hook + prior-art table + reproduce steps).
- Two long-form writeups (掘金 code/repro, 知乎 insight); X launch thread + Show HN; awesome-list PRs.
- SWE-bench-lite only if time permits (10–20 instances via an existing harness adapter) — always optional.

## Never
- Do not build a self-authored executable real-task benchmark with an oracle judge (collides with Harness-Bench, hits weak spots, sinks the timeline).
- Do not claim "first to evaluate routing robustness."
- Do not mention DeepSeek / job search / any employer in public materials.
