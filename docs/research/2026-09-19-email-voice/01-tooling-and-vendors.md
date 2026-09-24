# Email voice: tooling and vendors

Research date: 2026-09-19. Web research only; nothing was installed or run. "Verified" below means I read it in the project's own README, docs or issue tracker today. "Claimed" means only marketing or a third-party article says so. "From memory" means I did not re-check it today.

## Plain-language summary

1. Nothing on the market does the job better than a small, well-structured set of tables in the Postgres database we already own. Every "agent memory" product lets the AI rewrite its own memory automatically — the opposite of our rule that a human approves every change.
2. Most memory products are written in Python (we are TypeScript), and most report usage statistics to their makers unless switched off. Two have had bugs where "off" did not fully mean off.
3. The Vercel AI SDK we already use is a plain library: it runs on our box and sends nothing anywhere unless we wire it up. It gives us the two building blocks we need most: forcing the model to answer in a fixed form (for sorting the owner's edits into types) and turning text into numbers for similarity search.
4. The SDK has no memory feature and no test-bench for quality. We build both.
5. The best idea for "learn from what the owner changed" comes from a 2024 research paper (CIPHER): have the model describe each edit as a short written preference, store it with the situation it applied to, and fetch the relevant ones next time. That is a design, not a product — a few hundred lines of our own code.
6. One TypeScript library (Ax) can automatically rewrite a style guide from examples. Worth a later experiment, not a foundation: it rewrites the whole text, which clashes with add-only, approved changes.
7. Comparing draft with sent email mechanically: one small, mature library (jsdiff) does word- and sentence-level comparison. Adopt.
8. Measuring quality: extend the test pattern the repo already has (`packages/memory-evals`, recorded baseline). No new platform needed. Langfuse is possible but heavy; promptfoo now belongs to OpenAI and still pings home once even when told not to.
9. European similarity-search models exist (Scaleway in Paris, Mistral in Paris), and a self-hosted re-ranker (a second, sharper sorting pass) runs on our own box. Nobody publishes convincing Norwegian numbers — we must measure on our own mail.
10. Net: adopt two small libraries, borrow five ideas, skip every memory platform.

## Candidates

| Candidate | What it gives us | Fits constraints? | Verdict |
|---|---|---|---|
| AI SDK 7 `generateText` + `Output.object` / `Output.choice` | Model answers in a fixed schema: edit type, scope, evidence quote | Yes. Library, no cloud | **Adopt** (already have) |
| AI SDK `embed` / `embedMany` | Embeddings through any provider | Yes | **Adopt** (already have) |
| AI SDK `rerank()` | One API for re-rankers | Library yes; listed providers are all US (Cohere, Bedrock, Together) | **Borrow**: write a small adapter to a self-hosted re-ranker, or call it directly |
| AI SDK telemetry | OpenTelemetry hooks | Yes. Off unless registered; inputs/outputs can be excluded | Optional |
| AI SDK `ai/test` mocks | Fake models for deterministic tests | Yes | **Adopt** for harness plumbing |
| eve evals (`defineEval`, `t.judge`) | Scored checks with LLM judge, datasets, CI | Runs locally. But drives a whole agent session over HTTP, not one function | **Skip** for draft quality; fine for end-to-end smoke |
| Workflow SDK Postgres world | Durable jobs on own Postgres | Self-hosted; docs call it a reference implementation, no built-in auth/encryption | Not needed for this feature |
| Vercel AI Gateway, Agent Runs dashboard | Hosted routing / observability | No. Vercel cloud | **Skip** |
| Mem0 | Auto-extracted facts, TS OSS build | Apache-2.0. PostHog telemetry on by default; opt-out bugs on record | **Skip**; borrow "add-only" |
| Zep / Graphiti | Time-aware knowledge graph, facts invalidated not deleted, source "episodes" | Python only; needs Neo4j/FalkorDB; telemetry on by default | **Skip**; borrow invalidate-don't-delete + episodes |
| Cognee | Knowledge graph; can run on one Postgres | Python core; telemetry on by default | **Skip** |
| Letta | Self-editing memory blocks; git-versioned memory files | Python server; agent edits memory itself; git hosting is a cloud feature | **Skip**; borrow git-style history |
| LangMem | Memory extraction + prompt optimizer | Python only, tied to LangGraph storage | **Skip**; borrow optimizer prompts |
| Hindsight | Postgres+pgvector; observations keep exact quotes + proof count | MIT; server is Python; telemetry unverified | **Skip**; borrow evidence quotes + proof count |
| CIPHER / PRELUDE (paper) | Learn written preferences from user edits; tested on email | Research code (Python); idea is portable | **Borrow** — core design for (b) |
| Ax (`@ax-llm/ax`) GEPA / ACE | DSPy-style prompt optimisation in pure TS | Apache-2.0; AI SDK v7 bridge; telemetry default unverified | **Experiment later**, offline only |
| DSPy, GEPA (Python), TextGrad | Prompt optimisation | Python only | **Skip** |
| jsdiff (`diff`) | Word, sentence, array diff; ships types | BSD-3, no network | **Adopt** |
| `@sanity/diff-match-patch` | Character diff with semantic clean-up | TS fork, no network | Optional second opinion |
| vitest + own scorers | Held-out pairs, judge + edit distance, recorded baseline | Yes; pattern already in repo | **Adopt** |
| evalite | vitest-based eval runner, local SQLite, local UI | MIT, local; v1 still beta; telemetry unverified | Optional nicety |
| Langfuse self-hosted | Datasets, experiments, judge, UI | MIT; needs Postgres + ClickHouse + Redis + blob store; telemetry on by default (`TELEMETRY_ENABLED=false`) | **Skip** for now — too heavy for one feature |
| promptfoo | YAML-driven evals | MIT; OpenAI-owned since March 2026; opt-out still sends one beacon | **Skip** |
| Scaleway Generative APIs | `qwen3-embedding-8b`, `bge-multilingual-gemma2` | EU (Paris); no dedicated re-ranker | **Candidate**, measure on Norwegian |
| Mistral `mistral-embed` | Embeddings, EU by default | EU; no re-ranker; no Norwegian claim found | Candidate, measure |
| TEI + `bge-reranker-v2-m3` / `bge-m3` on our box | Self-hosted embeddings and re-ranking | Apache-2.0 server, no data leaves the box | **Candidate**, measure |

## 1. Vercel

- **AI SDK 7** (released 2026-06-25) is a library. Verified: structured output is now `generateText` with `output: Output.object(...)`; `Output.choice()` classifies into a fixed list; `Output.array()` returns typed lists. That is exactly the shape for "classify each edit hunk". [structured data docs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [v7 blog](https://vercel.com/blog/ai-sdk-7), [migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)
- **Reranking**: `rerank({model, query, documents, topN})` exists; the docs list only Cohere, Amazon Bedrock and Together.ai — all US. No self-hosted provider is documented. [reranking](https://ai-sdk.dev/docs/ai-sdk-core/reranking). Not verified: how much work a custom re-ranking provider is; the provider spec is open, so I expect small.
- **Memory**: verified there is no first-party memory. The docs point to Anthropic's memory tool, Letta, Mem0, Supermemory, Hindsight, MongoDB, or "build your own". [memory](https://ai-sdk.dev/docs/agents/memory)
- **Evals**: verified none first-party; only mocks (`MockLanguageModelV4`, `MockEmbeddingModelV4`) in `ai/test`. [testing](https://ai-sdk.dev/docs/ai-sdk-core/testing)
- **Telemetry**: verified nothing is emitted unless you install `@ai-sdk/otel` and call `registerTelemetry()`; `recordInputs`/`recordOutputs` can be set false. Compatible with "nothing phones home". [telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- **Middleware** (`wrapLanguageModel`): from memory, not re-checked. Useful place to inject the context pack uniformly; not essential.
- **eve**: Apache-2.0, beta. Evals (`defineEval`, `t.check`, `t.judge`, dataset fan-out) run locally and in CI with no Vercel cloud, but they boot the agent and drive it over HTTP — wrong granularity for scoring one drafting function against 200 held-out pairs. eve ships no long-term memory (third-party source). [evals](https://eve.dev/docs/evals), [self-hosting](https://eve.dev/docs/guides/deployment/self-hosting), [Hindsight blog on eve](https://hindsight.vectorize.io/blog/2026/07/06/eve-persistent-memory)
- **Hosted, therefore out**: AI Gateway, Agent Runs observability, Vercel Sandbox, Vercel Connect. [eve on Vercel](https://vercel.com/docs/eve)
- **Workflow SDK** `@workflow/world-postgres` 4.1.0: self-hosted, Postgres + graphile-worker; own docs say reference implementation, no built-in auth or encryption. Irrelevant to this feature. [Postgres world](https://useworkflow.dev/worlds/postgres)

## 2. Agent-memory libraries

| | Language | Licence | Self-host | Telemetry default | Provenance | Human-approved updates | Versioning / rollback | Contradictions |
|---|---|---|---|---|---|---|---|---|
| Mem0 | Python + TS (`mem0ai/oss`) | Apache-2.0 | Yes | **On** (PostHog); `MEM0_TELEMETRY=False` | Metadata only | No | History store (SQLite) | New algorithm is add-only |
| Graphiti | Python | Apache-2.0 | Yes, needs graph DB | **On**; `GRAPHITI_TELEMETRY_ENABLED=false` | Yes (episodes) | No | Bi-temporal history | Old fact invalidated, kept |
| Cognee | Python (TS SDK claimed) | Apache-2.0 | Yes, single Postgres possible | **On**; `TELEMETRY_DISABLED=true` | Not documented | No | Not documented | Not documented |
| Letta | Python server, TS client | Apache-2.0 | Yes | Unverified | Weak | No — agent self-edits | Git-backed (hosting is cloud; own remote possible) | Agent decides |
| LangMem | Python | MIT (third-party source) | Yes (library) | None known, unverified | No | No | No | LLM merges/overwrites |
| Hindsight | Python server, TS client | MIT | Yes, Postgres+pgvector | Unverified | Yes (quotes, proof count) | No | Not documented | Belief strengthened/weakened |

Sources: [mem0](https://github.com/mem0ai/mem0), [mem0 Node quickstart](https://docs.mem0.ai/open-source/node-quickstart), mem0 telemetry issues [#3729](https://github.com/mem0ai/mem0/issues/3729), [#3762](https://github.com/mem0ai/mem0/issues/3762), [#2901](https://github.com/mem0ai/mem0/issues/2901); [graphiti](https://github.com/getzep/graphiti); [cognee](https://github.com/topoteretes/cognee), [cognee config](https://docs.cognee.ai/setup-configuration/overview), [cognee #2120](https://github.com/topoteretes/cognee/issues/2120); [letta](https://github.com/letta-ai/letta), [context repositories](https://www.letta.com/blog/context-repositories/), [MemFS](https://docs.letta.com/concepts/memfs); [langmem](https://langchain-ai.github.io/langmem/); [hindsight](https://github.com/vectorize-io/hindsight).

**Honest verdict: no, none beats our own Postgres store for this job.** Reasons:

- All of them are built around the AI writing memory on its own. None has an approval queue. We would be fighting the product to get our central rule.
- None knows the difference between the owner's words and the recipient's words. Our rule that recipient-written text never becomes standing memory needs the origin tracking Lares already has; a third-party store would sit outside it.
- Four of six need a Python sidecar. Three of six have telemetry on by default, and Mem0's off-switch has twice been reported as leaky (fix noted in v1.0.5).
- The job is narrow: a few hundred rows of "preference, scope (person / relationship / mailbox), evidence, status, version". That is a table, not a platform. Benchmarks these tools quote (LongMemEval etc.) measure chat recall, not this.

Ideas worth taking: add-only writes (Mem0); "invalidate with a date, never delete" and a link from every learned item to the source events (Graphiti); exact supporting quotes plus a count of how many times seen (Hindsight); a commit-style history so any version can be restored (Letta).

## 3. Learning a style guide from (draft, final) pairs

- **CIPHER / PRELUDE** (Gao et al., NeurIPS 2024) is the closest published match: for each user edit, an LLM infers a written preference; preferences are stored with the context; at draft time the nearest contexts' preferences are retrieved and merged into the prompt. Evaluated on email writing, scored by edit distance between draft and final. Readable preferences mean the user can inspect and correct them — which maps directly onto approval plus evidence. Caveat: their "user" was GPT-4 simulated. [arXiv 2404.15269](https://arxiv.org/abs/2404.15269), [code (Python)](https://github.com/gao-g/prelude)
- **LangMem prompt optimizer**: takes conversations plus free-text feedback and proposes a revised prompt (three strategies, 1–10 model calls). Python only; no JS port found. Whether the revised email can be passed as feedback is not stated — feedback is free text, so probably yes. [reference](https://langchain-ai.github.io/langmem/reference/prompt_optimization/)
- **Ax** is the only serious TypeScript option: GEPA (reflective prompt evolution), ACE and few-shot bootstrapping run in pure TS; MiPRO needs a Python service. Apache-2.0, has an AI SDK v7 bridge package. Telemetry default not verified. [repo](https://github.com/ax-llm/ax), [GEPA docs](https://axllm.dev/gepa/)
- **DSPy, GEPA reference implementation, TextGrad**: Python only (from memory).
- **AI SDK-native equivalent**: none found.

Caution: optimisers rewrite the entire prompt to maximise a score. That is hard to reconcile with add-only, per-item evidence and rollback. Use one, if at all, offline to *propose* items that then go through normal approval.

## 4. Prose diffing in TypeScript

- **jsdiff** (npm `diff`, BSD-3-Clause): `diffWords`, `diffWordsWithSpace`, `diffSentences`, `diffArrays`; types shipped since v8; `diffWords` accepts an `Intl.Segmenter` for non-English word splitting; `maxEditLength` and `timeout` guards. Latest version number not verified (npm blocked the fetch). [repo](https://github.com/kpdecker/jsdiff)
- **`@sanity/diff-match-patch`**: maintained TypeScript fork of Google's library; character-level with a "semantic clean-up" pass. [repo](https://github.com/sanity-io/diff-match-patch)
- Suggested mechanical step (my design, untested): strip quoted thread and signature; split both texts into sentences with Node's built-in `Intl.Segmenter('nb', {granularity: 'sentence'})`; align sentences with `diffArrays`; run `diffWords` inside changed pairs; hand the model compact hunks (kept / removed / added / rewritten) rather than two whole emails. Greeting and sign-off lines deserve their own hunk type — they carry most per-recipient tone.

## 5. Evaluation

Best fit: **vitest with our own scorers**, copying the `packages/memory-evals` pattern (recorded baseline, fails on regression). Hold out draft/final pairs by date; regenerate the draft; score (a) normalised edit distance to the sent email, (b) share of sentences kept unchanged, (c) LLM judge with a fixed rubric via `Output.object`, judged blind and pairwise against the previous version. Edit distance is the metric CIPHER used, and it is the one the owner actually feels.

- evalite: MIT, vitest-based, local SQLite, local web UI; v1 has been "beta" for a while. Telemetry unverified. Nice viewer, not required. [repo](https://github.com/mattpocock/evalite)
- Langfuse: MIT, self-hostable, owned by ClickHouse Inc. since 2026-01-16. Self-hosting needs ClickHouse (v4: ≥ 25.12) beside Postgres; usage telemetry on unless `TELEMETRY_ENABLED=false`. Sensible if Lares later wants tracing across the fleet; overkill here. [telemetry](https://langfuse.com/self-hosting/security/telemetry), [ClickHouse requirements](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse), [acquisition](https://github.com/orgs/langfuse/discussions/11593)
- promptfoo: MIT; OpenAI announced the acquisition 2026-03-09; `PROMPTFOO_DISABLE_TELEMETRY=1` still sends one opt-out beacon per process. [telemetry docs](https://www.promptfoo.dev/docs/configuration/telemetry/), [PR #10047](https://github.com/promptfoo/promptfoo/pull/10047), [OpenAI](https://openai.com/index/openai-to-acquire-promptfoo/)
- Privacy note: held-out pairs are real mail. They live on the installation's box, never in this repo; the repo carries only the harness and synthetic fixtures.

## 6. European embeddings and re-ranking; Norwegian

- **Scaleway Generative APIs**: `qwen3-embedding-8b` (adjustable 32–4096 dimensions, 32k context, ~119 languages) and `bge-multilingual-gemma2` (3584 fixed, 8k). No dedicated re-ranker; Scaleway's docs say the embedding model's cosine score is the re-rank score, i.e. no real second pass. From memory: pgvector's fast index tops out at 2000 dimensions for the standard type, so 3584 is awkward; Qwen3 cut to 1024 is fine. [supported models](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/), [reranking how-to](https://www.scaleway.com/en/docs/generative-apis/how-to/query-reranking-models/)
- **Mistral**: text embeddings, EU processing by default (third-party sources also mention possible temporary transfers for some sub-processors — read the DPA). No re-ranker. No Norwegian statement found. [docs](https://docs.mistral.ai/capabilities/embeddings/text_embeddings)
- **Self-hosted**: Hugging Face Text Embeddings Inference serves `bge-m3` (embeddings) and `bge-reranker-v2-m3` (a true re-ranker, `/rerank` route), both multilingual. Ollama serves embedding models; I could not confirm a native re-rank endpoint. [bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- **Norwegian**: the Scandinavian Embedding Benchmark (NeurIPS 2024) found large gaps between models that ordinary leaderboards hide, and that Norwegian-specific models (`nb-bert-large`) can match multilingual ones on some tasks. It now lives inside MTEB. I could not pull current Norwegian retrieval numbers for Qwen3, bge-m3 or Mistral. [paper](https://arxiv.org/abs/2406.02396), [repo](https://github.com/KennethEnevoldsen/scandinavian-embedding-benchmark)
- Practical answer: do not trust any vendor on Norwegian. `packages/memory-evals` already measures recall — add a Norwegian email set and compare the current model, Qwen3 via Scaleway, and bge-m3 (+ re-ranker) before switching anything. With only three exemplars retrieved per draft, a re-ranker is the cheaper upgrade to test first.

## Could not verify

- Telemetry defaults for Letta, Hindsight, LangMem, evalite, Ax.
- Whether Cognee's TypeScript SDK runs standalone or is only a client to the Python service (I expect the latter).
- Effort to write a custom AI SDK re-ranking provider.
- Current npm versions of `diff`, `evalite`, `mem0ai`.
- Any head-to-head Norwegian retrieval scores for the candidate models.
- Mistral's embedding model names/dimensions as of today (docs page gave only an overview).
