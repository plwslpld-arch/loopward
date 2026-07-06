# Findings

> Reproducible results produced by LoopBench. Each is regenerable from the exact command listed.
> These are **pilot-grade** results (single model, single seed, one suite) — the shape is real; breadth
> caveats are stated per finding. Do not overstate them.

## F1 — Routing robustness ≠ routing accuracy; the effective attacks are the boring ones

**Setup.** `deepseek-chat`, `datasets/routing/tools.json` (n=42, 10 tool families), `single` variant,
temperature 0, seed 42. Deterministic RoutingOracle. Robustness delta = clean_acc − attacked_acc, with a
paired case-level bootstrap 95% CI (2000 resamples).

```
loopbench attack --suite datasets/routing/tools.json --provider deepseek --seed 42
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
