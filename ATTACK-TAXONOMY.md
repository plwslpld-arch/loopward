# Attack Taxonomy

Six perturbation classes applied to the **intent** that the loop's routing/stop decision consumes. Each is an
*intent-side transform* (we change the input the decision point sees, not the model or the tools).

> **Clean-room note:** every class below is re-derived from public sources (cited per row). Naming, organization,
> scoring logic, and corpora are produced independently here. Functional overlap with published work is expected and
> disclosed in `RELATED-WORK.md`; that overlap is not proprietary.

| Class | What it perturbs | Failure it probes | Maps to / derived from (public) |
|---|---|---|---|
| `boundary_blur` | Blur the boundary between similarly-named/scoped tools | Misfire on token similarity (`get_status` vs `fetch_status`) | MCP tool-overload write-ups; MetaTool similar-tool cases |
| `semantic_injection` | Inject misleading instruction/semantics into the observed context | Route hijack via injected content | OWASP LLM01 (prompt injection) |
| `negation_trap` | Phrase intent with negation ("do NOT use X, use the other") | Routing flips on negation handling | Adversarial NLP negation literature |
| `multi_intent` | Pack two+ intents into one request | Wrong single-tool commit / dropped intent | Public multi-intent parsing / tool-use studies |
| `minimal_context` | Strip the intent to underspecified minimum | Over-confident wrong route / fails to ask/stop | Under-specification robustness literature |
| `cross_skill_confusion` | Present overlapping-capability skills at dispatch | Dispatch to wrong skill/sub-agent | MetaTool / CATS candidate-pool confusion |

## Honest positioning of novelty

- `negation_trap`, `multi_intent`, `minimal_context` — probe **benign-but-ambiguous** routing brittleness (a
  harness-quality / DX angle that is comparatively under-covered). These are the more defensible "delta" classes.
- `boundary_blur`, `semantic_injection`, `cross_skill_confusion` — overlap heavily with MetaTool/CATS/OWASP.
  Positioned explicitly as an **engineering operationalization** of known attack surfaces, **not** a novel taxonomy.

## Scoring

Deterministic ground-truth only for routing (no LLM-judge). Each case carries: `intent`, `candidate skills/tools`,
`ground_truth_route`, `expected_stop`. Open-ended multistep success may use a judge only as a last resort, and must
report judge-agreement.

[TODO: per-class, add the exact public source URL in the code file header as `// derived from public source: <url>`.]
