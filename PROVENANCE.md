# Provenance & Clean-Room Statement

This project is an **independent, clean-room implementation**, built by the author on personal time and
personal equipment, from **publicly available knowledge and sources only**.

## Declarations

- This repository contains **no source code, configuration, data, prompts, test corpora, internal
  naming, or design documents** from any current or previous employer, or any third party.
- The concepts implemented here (agent loop orchestration, tool/skill routing evaluation, adversarial
  robustness testing) are **general, publicly documented industry techniques**. Ideas and functional
  approaches are not, in themselves, protected expression; the code here is written independently.
- Every attack class and evaluation method is **re-derived from public sources**, each cited below and
  footnoted at its point of use in the code (`// derived from public source: <url>`).
- No proprietary thresholds, scoring formulas, rule weights, state-transition tables, internal prompt
  templates, or private datasets from any employer are used or reproduced.

## Public sources this work is derived from

> These are the public references the design is built on. See `RELATED-WORK.md` for the academic prior art
> and `ATTACK-TAXONOMY.md` for the per-attack citations.

- OWASP Top 10 for LLM Applications (LLM01 Prompt Injection, tool/plugin risks) — https://owasp.org/www-project-top-10-for-large-language-model-applications/
- Adversarial NLP / prompt-injection & jailbreak taxonomy literature (public arXiv)
- MCP tool-routing / tool-overload public write-ups (2026)
- Public agent frameworks and their loop/tool-use docs (e.g. Vercel AI SDK, LangGraph)
- Academic prior art on tool selection and harness evaluation (listed in `RELATED-WORK.md`)

[TODO: as each file is written, add the exact public URL it was derived from, both here and in the file header comment.]

## Hygiene commitments

- Independent git root; not nested in, and never importing from, any employer workspace.
- Personal Git identity and personal GitHub account only (never a company org/email/CI/internal package).
- Commit history built incrementally from an empty repository, with messages referencing the public source
  behind each change (not a single dump of a finished artifact).
- Pre-publication check: repository-wide grep for internal names returns **zero** before anything goes public.

## License

Apache-2.0 (see `LICENSE`). The Apache-2.0 patent grant is a deliberate, affirmative statement that the author
has the right to license this work — i.e., that it is the author's own independent creation, not assigned IP.
