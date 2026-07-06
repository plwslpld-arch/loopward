# Roadmap

Realistic solo timeline: **2 weeks = defensible MVP, 3–4 weeks = strong.** Every week ships a verifiable artifact.
Ship nothing publicly until MVP is reached (a shallow demo backfires).

## W1 — kernel runs, produce clean data
- Independent git root under personal identity/email. IP + novelty hygiene files first (LICENSE, PROVENANCE, RELATED-WORK). ✅ (scaffolded)
- `core`: 5-node loop state machine (perceive → route → act → verify → decide/stop) + `single` variant, thin over a public agent framework (do not hand-roll a naive loop).
- DeepSeek + OpenAI-compatible provider abstraction.
- Structured trajectory trace (JSONL).
- `tasks`: routing YAML loader + `RoutingOracle` (deterministic ground-truth scoring).
- **Verify:** `loopbench run` prints clean routing accuracy for one model + emits one trajectory JSONL.

## W2 — adversarial + robustness metrics + 2nd variant  (MVP line → can go public)
- `redteam`: 6 attack classes (intent-side transforms, each with public-source header) + attack-runner.
- `eval`: metrics (misroute / wrong-tool / over-run / premature-stop / robustness-delta) + multi-seed + bootstrap CI.
- `variants`: `self-check` (reflexion-lite) — an extra decision node = an extra attack surface.
- **Verify:** attack×variant misroute heatmap + ≥1 reproducible, counter-intuitive finding (with CI).

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
