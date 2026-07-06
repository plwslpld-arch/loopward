# Related Work

LoopBench is **not** the first tool to evaluate tool/skill selection. This file states, honestly, what
exists and what LoopBench's specific delta is. (Being explicit about prior art is both intellectually
honest and evidence that this is a clean-room re-derivation from the public literature.)

## Prior art (tool selection / routing / harness eval)

| Work | What it does | What it does NOT do (LoopBench's gap) |
|---|---|---|
| **MetaTool** | Benchmark for whether an LLM *should* use a tool + which tool; tool-selection reliability | No adversarial/benign-ambiguous perturbation at the loop decision point; no loop-variant comparison; no training-signal export |
| **CATS / ToolCert** | Candidate-pool poisoning, top-N saturation, statistical certification of tool selection | Focus on certification of static selection; not loop stop/route decision robustness across harnesses |
| **Harness-Bench** | Large matrix (tasks × harnesses × models) comparing harness performance | No adversarial routing; no loop-variant robustness; no co-evolution export |
| **Auditing Agent Harness Safety** | Perturbs safety/boundary layer of harnesses | Safety layer, not the *routing/selection* decision layer |
| **Proteus** | Self-evolving skill red-team | Skill evolution focus; not deterministic routing-robustness eval + training export |
| **promptfoo (red-team)** | Helps you author red-team configs | Config authoring; not routing-decision robustness measurement |

## 2026 evidence that the routing-failure problem is real (motivation, not prior tools)

- *Looking Is Not Picking: Tool-Selection Failures in LLM Agents* (arXiv 2606.16364)
- *ACE-Router: History-Aware Routing from MCP Tools to the Agent Web* (arXiv 2601.08276)
- *Scaling Enterprise Agent Routing: Degradation, Diagnosis, and Recovery* (arXiv 2606.17519)
- MCP tool-overload / context-bloat public write-ups (2026)

## LoopBench's specific delta (what to claim, and only this)

1. Adversarial + **benign-but-ambiguous** perturbation injected at the loop's **route** and **stop** decision points.
2. **Harness-portability** variance decomposition (same suite, ≥2 real harnesses) — routing robustness as a harness property.
3. **Co-evolution export**: routing failures → preference pairs / verifiable reward / SFT negatives, with a micro-experiment.
4. TS/Node-native, deterministic (no LLM-judge for routing), seeded & reproducible.

**Do NOT claim** "first to evaluate routing robustness" or "nobody red-teams tool selection." That is false and
will be refuted by anyone who has read the papers above. Claim the specific delta only.

[TODO: replace paper IDs with verified links/titles before publishing; add any newer prior art found during build.]
