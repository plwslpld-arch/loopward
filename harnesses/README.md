<!--
  Field guide to the four loop strategies Loopward sweeps. Each is framed as a "specimen under test":
  its exact node sequence, one mechanism sentence, and a helps/hurts pair stamped with a specific
  model + seed + finding id (never a universal claim). The strategies ARE the independent variable of
  `loopward matrix`; their behavior lives only in packages/core/src/loop.ts, and strategies.json is a
  machine-checked mirror of that file, not a config or plugin loader.
  ponytail: no plugin system and no config loader — adding a fifth harness means editing loop.ts, not
  dropping a file here.
-->

# Harnesses under test

English | [简体中文](./README.zh-CN.md)

Loopward holds the **model fixed** and varies the **loop** around it. These four loop strategies are the
independent variable that `loopward matrix` sweeps: same cases, same deterministic oracle
(`route-exact-v1`, `scoreRoute`/`norm`), only the harness changes — so any difference in robustness is
attributable to the loop, not the model. This is the axis a model-vs-model leaderboard cannot see.

**Where behavior is defined.** The actual node sequences and branching live **only** in
[`packages/core/src/loop.ts`](../packages/core/src/loop.ts) (`type Variant`, `runCase`). This directory
is documentation: [`strategies.json`](./strategies.json) is a **machine-checked mirror** of `loop.ts`, not
a config file and not a plugin registry. Nothing loads it at runtime; there is no plugin system. Adding a
fifth harness means editing `loop.ts`, not dropping a file here.

The set of ids is exactly `{single, self-check, react, observe}` — the `DEFAULT_STRATEGIES` that
`matrix` runs.

Every strategy ends in the same tail — `act → verify → stop` — and `verify` scores with the deterministic
oracle. No strategy ever calls an LLM to judge; the oracle is the sole scorer.

---

## Specimen: `single`

**Node sequence:** `perceive → route → act → verify → stop`
**Feedback turns:** 0  ·  **Reflects:** no

**Mechanism.** One-shot: perceive the intent and candidates, `route()` once, act, verify, stop — no
re-examination and no feedback.

- **Helps —** `deepseek-chat`, seed 42 (**F1**): the baseline control. 100% clean routing accuracy on
  `tools.json` (n=42); strong wherever the first pick is already right.
- **Hurts —** `deepseek-chat`, seed 42 (**F1**): no recovery path. The same model loses **12–43pp** under
  boring intent-side perturbations that don't change the correct answer (worst: `minimal_context` +42.9pp;
  the adversarial `negation_trap` is the *weakest*, +2.4pp, not significant).

---

## Specimen: `self-check`

**Node sequence:** `perceive → route → reflect → act → verify → stop`
**Feedback turns:** 1  ·  **Reflects:** yes

**Mechanism.** After the first `route()`, a `reflect` node shows the model its own pick and asks it to
double-check / switch to a better candidate before committing (one extra `route()` call, same oracle).

- **No win —** `glm-5.2`, seed 42 (**F5**, `sample.json` n=12): the reflect node is a **wash** — **+0.0pp**
  vs `single` (identical): re-examination buys no measurable robustness on this model.
- **Hurts —** `deepseek-chat`, seed 42 (**F2**, `tools.json` n=42): the same reflect node second-guesses
  already-correct routes toward the confusing near-duplicate — **−11.9pp** on `boundary_blur` and
  `cross_skill_confusion`, and even **−7.1pp** on clean.

> Read F5 and F2 **together**: identical node, harmful on one model and inert on another, decided by the model.
> `self-check` is not an endorsed upgrade — it is the clearest demonstration that whether a harness change helps
> is a property of the *model-and-harness pair*, which is exactly why you `matrix` it instead of assuming it.

---

## Specimen: `react`

**Node sequence:** `perceive → think → route → act → verify → stop`
**Feedback turns:** 1  ·  **Reflects:** no

**Mechanism.** A `think` node (free-text `generate()` reasoning about which candidate fits) runs first,
then `route()` is fed the intent plus that reasoning. Falls back to a plain `route()` when the provider has
no `generate()`.

- **Helps —** `glm-5.2`, seed 42 (**F5**): a neutral, non-harmful loop option sitting between one-shot and
  re-examination; gives the router explicit reasoning context before it picks.
- **Hurts —** `glm-5.2`, seed 42 (**F5**, `sample.json` n=12): the extra reasoning turn buys nothing —
  **+0.0pp** vs `single` — so on this model/suite it is the cost of an extra `generate()` call with no
  robustness payoff.

---

## Specimen: `observe`

**Node sequence:** `perceive → route → observe → act → verify → stop`
**Feedback turns:** 2 (up to)  ·  **Reflects:** no

**Mechanism.** `route()` once, then up to 2 `observe` feedback turns: each turn shows the model its current
pick plus a **stub** observation ("it returned: ok") and lets it keep or switch the tool, stopping early
once the pick stabilizes. The routing analogue of the multi-step observation loop.

- **Helps —** `deepseek-chat`, seed 42 (**F4**, `tasks.json` n=10): feeding an observation back is the
  single most impactful harness change measured — adding a one-line stub observation after each call lifted
  multi-step task success **10% → 60%** and cut over-run **80% → 20%**, same model and tasks. On `glm-5.2`
  the routing `observe` variant nudges **+1.4pp** but its CI includes 0, so no significant gain (**F5**).
- **Hurts —** `glm-5.2` / `deepseek-chat`, seed 42 (**F5**, **F2**): the observation is a stub, not a real
  tool result, so it cannot fix a route already committed to the wrong tool; on models where re-feeding a
  prior pick induces second-guessing it can drift the same way `self-check` does (levels are not fully
  independent — both re-feed a prior pick).

---

*Every claim above is stamped with a specific model + seed + finding id; none is a universal statement about
"models" or "loops". Full setups, caveats, and CIs are in [`docs/findings.md`](../docs/findings.md).*
