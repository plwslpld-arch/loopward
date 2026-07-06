<!--
  README skeleton. Fill the [TODO] parts as the implementation lands.
  Rule: this repo is clean-room. It contains NO third-party or prior-employer
  source code, data, or internal naming. See PROVENANCE.md.
-->

# LoopBench

> **Everyone is designing loops. Nobody is testing whether the loop's *decisions* are stable.**
> LoopBench is an eval + adversarial-robustness layer for agent loops — it stress-tests the
> **routing / tool-selection decision** an agent makes inside its loop, and exports the failures
> as reusable post-training signal.

> ⚠️ Working title. Name pending a GitHub/npm/PyPI/X collision check before public launch.

---

## Why this exists (the real-world problem)

As agents connect to more tools (MCP servers, skills, sub-agents), the **routing decision** — *which
tool/skill to call for this intent* — becomes the dominant failure surface:

- Tool-selection accuracy **degrades sharply** as a tool catalog grows from dozens to hundreds; hallucinated
  calls scale with toolbelt size. *(see RELATED-WORK.md for sources)*
- Near-duplicate names (`get_status` / `fetch_status` / `query_status`) make models **misfire on token similarity**.
- Under ambiguity, agents sometimes **take no action / get stuck / time out** — a *loop* failure, not a model failure.

There is a lot of writing on **designing** loops (loop engineering, 2026). There is almost nothing that
**rigorously tests** whether a loop's routing decisions hold up under benign-but-ambiguous and adversarial input,
and turns those failures into something a model team can train on. That gap is what LoopBench fills.

## What this is / is NOT

**Is:** a diagnostic + adversarial-robustness harness for the *routing* and *stop* decision points of an agent loop,
with deterministic ground-truth scoring, harness-portability variance analysis, and export of failures into
post-training signal (preference pairs / verifiable reward / SFT negatives).

**Is NOT:** a leaderboard benchmark to rank models; a security/malware red-team; a loop *runner* you ship to prod.

## How it's different (honest prior-art delta)

LoopBench does **not** claim to be the first to evaluate tool selection. See [`RELATED-WORK.md`](./RELATED-WORK.md)
for a line-by-line comparison with CATS/ToolCert, MetaTool, Harness-Bench, and others. The specific delta:

1. **Adversarial perturbation at the loop's *decision points*** (route + stop), not just static tool-choice accuracy.
2. **Harness-portability variance decomposition** — same suite across ≥2 real harnesses to show routing robustness is a
   *harness* property, not only a model property.
3. **Co-evolution export** — routing failures → preference pairs / verifiable rewards / SFT negatives + a micro-experiment.
4. **TypeScript/Node-native, deterministic scoring** (no LLM-judge for routing), reproducible with fixed seeds.

## Architecture

```
loop runner (5-node state machine)  ──▶  redteam (6 intent-side attacks + deterministic oracle)
        │                                          │
        ▼                                          ▼
     eval (metrics + bootstrap CI + delta)  ──▶  coevo (export failures → post-training signal + micro-exp)
        │
        ▼
   dashboard (leaderboard / attack×variant heatmap / trajectory viewer)
```

See [`docs/`](./docs) for the full design and metric definitions.

## Reproduce

```bash
pnpm install
pnpm loopbench run --suite datasets/routing --variant single --seed 42   # clean routing accuracy
pnpm loopbench attack --suite datasets/routing --variant self-check      # + 6 attack classes
pnpm loopbench report                                                    # metrics + bootstrap CI
```

[TODO: fill exact commands as CLI lands]

## Status

Early WIP. Roadmap in [`docs/roadmap.md`]. Findings and methodology in [`docs/`].

## Provenance & License

Independent clean-room implementation. Contains no prior-employer or third-party source, data, or internal naming —
see [`PROVENANCE.md`](./PROVENANCE.md). Licensed under **Apache-2.0**.
