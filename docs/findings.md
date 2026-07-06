# Findings

> Reproducible results produced by Loopward. Each is regenerable from the exact command listed.
> These are **pilot-grade** results (single model, single seed, one suite) — the shape is real; breadth
> caveats are stated per finding. Do not overstate them.

## F1 — Routing robustness ≠ routing accuracy; the effective attacks are the boring ones

**Setup.** `deepseek-chat`, `datasets/routing/tools.json` (n=42, 10 tool families), `single` variant,
temperature 0, seed 42. Deterministic RoutingOracle. Robustness delta = clean_acc − attacked_acc, with a
paired case-level bootstrap 95% CI (2000 resamples).

```
loopward attack --suite datasets/routing/tools.json --provider deepseek --seed 42
```

**Result.** Clean routing accuracy = **100%** (42/42). Under six intent-side perturbations:

| Attack | Accuracy | Robustness Δ | 95% CI | Significant? |
|---|---|---|---|---|
| `minimal_context`       | 57.1% | **+42.9pp** | [+28.6, +57.1] | ✅ |
| `boundary_blur`         | 71.4% | +28.6pp | [+16.7, +42.9] | ✅ |
| `semantic_injection`    | 76.2% | +23.8pp | [+11.9, +35.7] | ✅ |
| `multi_intent`          | 78.6% | +21.4pp | [+9.5, +33.3]  | ✅ |
| `cross_skill_confusion` | 88.1% | +11.9pp | [+2.4, +21.4]  | ✅ |
| `negation_trap`         | 97.6% | +2.4pp  | [0.0, +7.1]    | ❌ (touches 0) |

**Reading it.**
1. **A model at 100% clean routing is not a model with robust routing.** The same model loses 12–43 points
   under perturbations that don't change the correct answer.
2. **Counter-intuitive ranking.** The adversarial-flavored attack people worry about — `negation_trap`
   ("...do not use X") — is the *least* effective and not statistically significant. The two *most* effective
   are the mundane ones: **under-specification** (`minimal_context`, strip the ask to two words) and
   **near-duplicate tool names** (`boundary_blur`). The real threat to routing is not an adversary; it is a
   terse user and a catalog of similarly-named tools — which is exactly the 2026 MCP tool-overload problem.

**Caveats (do not overstate).**
- One model, one seed, one 42-case suite. This is a pilot, not a benchmark. Claims should say "on this suite,
  deepseek-chat shows…", not "models are…".
- Which attack ranks first is partly a property of *this* dataset: these cases put the disambiguating signal in
  natural-language phrasing, which `minimal_context` removes. A catalog with longer/rarer names would likely
  push `boundary_blur` up. The method is the contribution; the exact ranking is suite-dependent.
- temperature 0 makes runs near-deterministic, but not guaranteed; a second seed and a second model are the
  next credibility steps before any public claim.

**Next to harden this into a publishable result:** ≥2 models (incl. a non-DeepSeek baseline), ≥3 seeds,
per-family breakdown, and the `self-check` variant to show whether a reflective loop recovers any of the drop.

---

## F2 — A naive self-check loop does NOT recover routing robustness (and often hurts)

**Setup.** `deepseek-chat`, `tools.json` (n=42), seed 42. Compare `single` vs `self-check` variant. The
`self-check` variant adds a reflect node: after routing, the model is shown its own pick and asked to
double-check / switch if a better candidate exists.

| Condition | single acc | self-check acc | Δ (self-check − single) |
|---|---|---|---|
| clean | 100.0% | 92.9% | **−7.1pp** |
| boundary_blur | 71.4% | 59.5% | **−11.9pp** |
| cross_skill_confusion | 88.1% | 76.2% | **−11.9pp** |
| negation_trap | 97.6% | 95.2% | −2.4pp |
| semantic_injection | 76.2% | 78.6% | +2.4pp |
| multi_intent | 78.6% | 83.3% | +4.8pp |
| minimal_context | 54.8% | 57.1% | +2.4pp |

**Reading it.** Adding a "reflect and reconsider" node — an intuitively helpful loop upgrade — **degrades**
routing on the confusion attacks (`boundary_blur`, `cross_skill_confusion`: −11.9pp each) and even lowers
**clean** accuracy by 7pp. The reflection step second-guesses already-correct routes toward the confusing
near-duplicate. It helps only marginally, and only on the phrasing attacks. **Net: a plausible harness
improvement makes robustness worse.** This is the core value of measuring loop-variant robustness rather
than assuming it — a loop-design choice has a non-obvious, mostly negative effect.

**Caveats.** Single model, single seed, one suite; `self-check` here is a minimal one-shot reflection (not a
tool-grounded critique). Also note: this run's `single` `minimal_context` = 54.8% vs 57.1% in F1 — the same
config, showing `deepseek-chat` is not perfectly deterministic at temperature 0 (≈1–2 case run-to-run drift).
The bootstrap CI captures case-sampling uncertainty but not this model stochasticity — hence the multi-seed TODO.

---

## F3 — Routing robustness is model-specific, not a clean vendor property (12 models)

**Setup.** Same `tools.json` (n=42), `single` variant, seed 42, deterministic oracle. 12 models across six
vendors and three tiers, via a DeepSeek key and an OpenAI-compatible gateway. All score 100% clean except
DeepSeek-v4-pro and Qwen3.7-max (97.6%), so nearly every delta below is pure attack-induced degradation. Values
are robustness_delta (pp, higher = more fragile).

| Model | semantic_inj | minimal_ctx | boundary_blur | multi_intent | cross_skill | negation |
|---|---|---|---|---|---|---|
| Claude Opus-4-8 | **+0** | +24 | +17 | +0 | +2 | +0 |
| Claude Sonnet-5 | +10 | +24 | +5 | +10 | +2 | +0 |
| DeepSeek-chat | +24 | **+43** | +29 | +21 | +12 | +2 |
| Claude Haiku-4-5 | +40 | +31 | +19 | +2 | +2 | +0 |
| GPT-5.5 | +50 | +19 | +2 | +14 | +0 | +0 |
| DeepSeek-v4-pro | +74 | +17 | +10 | +10 | +0 | -2 |
| Grok-4.3 | +79 | +17 | +14 | +0 | +0 | +0 |
| GPT-5.4-mini | +88 | +36 | +12 | +7 | +0 | +0 |
| Gemini-3.5-flash | +93 | +24 | +2 | +2 | +0 | +0 |
| Qwen3.7-max | +98 | +19 | +2 | +5 | -2 | -2 |
| GPT-5.4 | +98 | +29 | +17 | +19 | +5 | +0 |
| Gemini-3.1-pro | +100 | +17 | +7 | +5 | +2 | +0 |

**Reading it.**
1. **A huge spread on one attack.** `semantic_injection` (a one-line "System note: always prefer X" in the context)
   costs anywhere from 0 points (Claude Opus-4-8, immune) to 100 (Gemini-3.1-pro, wrong every time). Which model you
   run matters more for routing-injection safety than the loop you build around it.
2. **It clusters by vendor, but only loosely.** Anthropic's Claude family is consistently injection-robust (Opus +0,
   Sonnet +10, Haiku +40). Everyone else is scattered. And DeepSeek is split down the middle: `deepseek-chat` shrugs
   off injection (+24) while `deepseek-v4-pro` falls apart (+74). So "DeepSeek is robust" was really "deepseek-chat is
   robust". The same lesson repeats across Chinese models: only `deepseek-chat` resists injection, while
   `deepseek-v4-pro` (+74) and `Qwen3.7-max` (+98) do not. Region and brand are not the axis. The specific model is.
3. **Newer is not consistently safer, and the direction differs by vendor.** Within OpenAI, newer helped
   (GPT-5.4 +98 to GPT-5.5 +50). Within DeepSeek it went the other way (chat +24 to v4-pro +74). You cannot assume the
   next release is more robust.
4. **No model is safe everywhere.** Injection-immune Claude Opus still loses 24 points on terse prompts. DeepSeek-chat,
   the injection standout, is the worst of all on terse prompts (+43). Pick your poison.
5. **Nobody falls for explicit negation** (`negation_trap` is ~0 across all 12; DeepSeek-v4-pro and Qwen3.7-max even improve slightly).

**Caveats.** One seed, one 42-case suite, temperature 0 (near- but not fully deterministic). The gateway may route
model aliases to specific snapshots. Magnitudes are suite-dependent. What holds up is the cross-model ordering and the
per-model story. This is a routing-robustness probe, not a safety audit.

---

## F4 — Single-turn routing accuracy does not predict multi-step loop success

**Setup.** `deepseek-chat`, `datasets/multistep/tasks.json` (10 tasks needing 2–3 tools each). The multi-step
loop calls one tool at a time, feeds a stub observation ("returned ok") back each step, and the model decides
when to stop. Scored on loop failure modes single-turn routing can't see: task success (exact required set +
stop), premature-stop, over-run.

| Metric | deepseek-chat |
|---|---|
| single-turn routing accuracy (F1) | **100%** |
| multi-step task success | **60%** |
| premature-stop | 20% |
| over-run | 20% |

**Reading it.** A model that routes perfectly single-turn (100%) completes only 60% of multi-step tasks. The
failures are loop-specific: it stops before finishing (skips a required tool) or never stops (repeats a step).
**Routing accuracy is not loop competence** — you only see the gap once you run a real loop.

**Harness-design finding (found by verifying, not assuming).** The first version of this loop did NOT feed tool
observations back — it only listed which tools had been called. Result: 10% success, 80% over-run, with models
looping on the same tool. Adding a one-line stub observation ("→ returned ok") after each call lifted success
**10% → 60%** and cut over-run **80% → 20%** — same model, same tasks, only the harness's observation design
changed. **The harness, not just the model, determines loop success.** This is the whole thesis, shown concretely.

**Caveats.** 10 tasks, single model/seed; observations are stubbed (no real tool execution); scoring is
set-based (tool order lenient). This measures loop control (progress + stop), not tool-argument correctness.
