# 0007: Memory architecture and web search backend (deep research)

Deep research run by the user on Claude Web on 2026-10-26 from the prompt Fable wrote. Pasted
verbatim below. Decisions that follow from it are recorded in the phase records (phase 17 memory,
phase 18 search).

---

# Decision Record: Memory Architecture and Web Search Backend for a Single-User Assistant

Build memory in-house on SQLite as a claim-and-evidence store fed by one masked LLM call per chat; adopt no external memory library; switch web search to the Brave Search API called directly by our server, with Exa deep search as the optional deep backend.

## TL;DR
- Memory: keep the byte-stable profile block, add a `claims` table with evidence, confidence and validity dates, extract once per chat, and inject at most ~300 retrieved tokens per turn. No published system beats this design by a margin that survives our constraints; the "99%" claims are ensembles or retrieval-recall numbers, not production QA accuracy.
- Search default: Brave Search API, direct, `country=FI&search_lang=fi`, $5 per 1,000 requests, exact query control, no LLM in the loop.
- Search deep: Exa `/search` with `type: "deep"` and highlights. That is $0.012 per deep request plus $0.001 per page of highlights, so $0.017 for 5 results (Exa prices as summarised by Keirolabs; one source says content for up to 10 results is included, so check Exa's own pricing page). No affordable option gives zero data retention for queries, so the server-side name filter remains the main privacy control.

## Summary
1. Decision: build memory in-house. Do not adopt Mem0, Zep, Letta, Honcho, Hindsight or EverMemOS.
2. Decision: add a `claims` table (claim, evidence, confidence, valid_from, valid_to, source chat) to the existing SQLite store.
3. Decision: one masked extraction call at chat end; ADD-only plus "supersede" proposals; user approves in the weekly review.
4. Decision: injection = cached profile block (≤4,000 chars, regenerated only at consolidation) + ≤300 tokens of per-turn retrieved claims placed after the cache breakpoint.
5. Decision: measure with a private Finnish eval of ~100 questions in LongMemEval categories, run monthly.
6. Decision: default search = Brave Search API direct, Finnish locale, 5 results with extra snippets.
7. Decision: deep search = Exa deep search direct, highlights capped at 2,000 chars per result.
8. Cost: Brave ≈ $3/month at 20/day and ≈ $15/month at 100/day, before the $5 monthly free credit. Brave's launch blog says "Every plan gets $5 of free credit that renews every month". The credit requires us to attribute the Brave Search API on our website or about pages.
9. Risk: no search option at our budget offers ZDR for queries; OpenRouter ZDR does not cover server tools.
10. Retire the deprecated OpenRouter web plugin.

## Question 1 findings table

All figures are self-reported by the vendor unless the "Source type" column says otherwise. Read 2026-10-26.

| System | Extraction | Structure | Temporal validity | Consolidation / decay | Retrieval | LoCoMo | LongMemEval | Tokens per query | Licence / self-host | Own LLM calls | Works on pseudonymized text |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Mem0 (2025 paper) | Per message pair; ADD/UPDATE/DELETE/NOOP via LLM tool call | Flat facts; Mem0g adds graph | No explicit | LLM update step | Vector (+graph) | 66.88 (judge, gpt-4o-mini) per HyMem paper; 68.5 Mem0g per Letta | 66.40 (MemReader paper, third party) | ~1.7k (paper); 1,070 (TiMem, third party) | Apache 2.0; self-host | ≥2 per write (extract + update) | Yes, if entities are stable surrogates |
| Mem0 (Apr–May 2026 algorithm) | Single-pass ADD-only, one LLM call | Facts + entity links | Temporal reasoning + memory decay added May 2026 | Decay | Semantic + BM25 + entity, fused | 92.5 | 94.4 | 6,956 (LoCoMo), 6,787 (LongMemEval) | Platform scores include "proprietary optimizations not available in the open-source SDK" | 1 per write | Yes |
| Zep / Graphiti | Per message (episode) | Temporal knowledge graph | Bi-temporal; t_valid / t_invalid; contradicted facts invalidated, not deleted | Community subgraphs | Semantic + BM25 + BFS graph; cross-encoder rerank | 75.10 (third party table) | 71.2 (gpt-4o), 63.8 (gpt-4o-mini); full context 60.2 | ~1.6k on LongMemEval | Graphiti licence UNVERIFIED; needs graph DB | Several per episode (entity, edge, date extraction) | Partly: entity resolution works on surrogates, but inflected Finnish names may split nodes |
| Letta (MemGPT) | Agent edits its own memory blocks via tools | Core blocks + archival vector + files | No | Agent-driven | Agent tool calls (grep, search) | 74.0 (filesystem agent, gpt-4o-mini) | Not published | Agent-dependent | Licence UNVERIFIED; Docker + Postgres | Many (agent loop) | Yes |
| Supermemory | LLM extraction | Memory + documents | Claims knowledge updates 99% (recall) | UNVERIFIED | Hybrid; ASMR = parallel search agents | Claims "#1" | ~99% only with 8-variant ensemble (ASMR, experimental); 85.2 single-pass | ~720 tokens at Recall@15 (retrieval metric, not QA) | Repo says can run locally; licence UNVERIFIED | Ensemble = many | UNVERIFIED |
| Hindsight (Vectorize) | Retain: narrative facts with temporal ranges, entity resolution | 4 networks: world, experience, observation, opinion | Yes, temporal ranges | Background observation consolidation | Semantic + keyword + graph + temporal in parallel | 83.2 (20B OSS model); 89.61 (larger backbone) | 83.6 (20B); 89.0 (GPT-OSS-120B); 91.4 (Gemini-3 Pro); non-standard judge flagged by third party | Token-budgeted recall | MIT; PostgreSQL + pgvector | Per retain + reflect | UNVERIFIED |
| EverMemOS | MemCells (episodes, atomic facts, "Foresight") | MemScenes + user profile | Time-bounded foresight signals | Semantic consolidation | Reconstructive recollection | 93.05 (paper); 92.32 (own repo, GPT-4.1-mini, 2,298 tokens); 82.75 (MemTensor reproduction, 8,559 tokens) | 83.0 (paper); 80.40 (MemTensor reproduction) | 2.3k–8.6k | Apache 2.0; MongoDB, Elasticsearch, Milvus, Redis | Multiple | UNVERIFIED |
| MemOS (MemTensor) | LLM extraction | Memory OS layers | UNVERIFIED | Yes | Hybrid | 80.76 (EverMemOS harness, 2,498 tokens); 88.83 (own harness, 5,400 tokens) | 77.80 (per EverMemOS); 89.20 (own harness, 4,151 tokens) | 1,371 (TiMem) to 5,400 | Open source; licence UNVERIFIED | Multiple | UNVERIFIED |
| Memobase | Profile extraction | User profile slots | UNVERIFIED | UNVERIFIED | Profile + events | 75.80 (third-party table) | 72.40 (MemReader paper) | 1,541 | Open source; licence UNVERIFIED | Per batch | UNVERIFIED |
| Cognee | Graph + vector ingestion | Knowledge graph | UNVERIFIED | UNVERIFIED | Graph + vector | No primary number found | No primary number found | UNVERIFIED | UNVERIFIED | Multiple | UNVERIFIED |
| A-MEM | Per note, LLM generates tags, links, evolves notes | Zettelkasten linked notes | No | Note evolution | Vector over notes | F1 39.65 (ES-Mem table) | 62.6–70.6 (LightMem table) | 2,431–2,712 | MIT (per MemRefine paper) | Several per note | Yes |
| LightMem | Compress (LLMLingua-2) → topic segments → summarise; offline "sleep-time" update | Summarised entries | No | Offline parallel update | Vector | F1 44.73 (ES-Mem table) | Up to +7.7% over A-MEM; reproduction: 57.0–70.7 on 444 questions | 815; 660–720 answering tokens (reproduction) | Open source (zjunlp); licence UNVERIFIED | Few, batched | Yes |
| LangMem | LLM extraction | Flat | No | UNVERIFIED | Vector | F1 36.87 (ES-Mem table) | UNVERIFIED | 127 tokens but 18.53 s latency | UNVERIFIED | Per write | Yes |
| Honcho (Plastic Labs) | "Deriver" LLM reads every message | Peer representations | Yes (changing peers) | "Dreamer" background synthesis | "Dialectic" LLM answers queries | 89.9 | 90.4 (LongMem S); backbone/embedder undisclosed | Median 5% of context | AGPL-3.0; Postgres + pgvector + Redis + worker | Per message + per query | Partly; reasons over surrogates |
| Claude Code auto memory (Anthropic) | Model writes notes during session | Markdown: MEMORY.md index + topic files | No | "Auto Dream" background consolidation | Index loaded at start; topic files read on demand | n/a | n/a | Guides citing the Claude Code docs (fast.io, Vectorize) say "the first 200 lines of MEMORY.md, or the first 25KB (whichever limit hits first)" load at session start; secondary sources | Local files | In-session | n/a |
| ChatGPT memory (OpenAI) | Saved memories + "reference chat history" synthesis | Notes + profile summary | Memories revised over time ("Dreaming") | Background | Summary pre-loaded every chat, not fetched per question (secondary) | 52.9 (Mem0 paper) | n/a | UNVERIFIED | Closed | n/a | n/a |
| Gemini memory (Google) | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | n/a | n/a | UNVERIFIED | Closed | n/a | n/a |

### The "99%" and record claims

| Claim | Benchmark | What it actually measures | Verdict |
|---|---|---|---|
| Supermemory ~99% | LongMemEval_s | QA accuracy from an 8-variant ensemble (ASMR); framed by its authors as experimental, not production | Marketing for production use; single-pass is 85.2–85.86 |
| Supermemory "99.4% context reduction" | LongMemEval | Retrieval Recall@15 = 95% at ~720 tokens | Retrieval metric; not QA accuracy |
| MemPal 100% | LongMemEval | Last step from 99.4% to 100% was tuned on 3 specific wrong answers (its own disclosure) | Overfit |
| agentmemory V4 96.2% | LongMemEval | 481/500, Claude Opus 4.6 generator, single run, self-reported | Unreviewed, strong generator |
| Agent Zero 95.60% / 93.60% | LongMemEval / LoCoMo | arXiv preprint; compares against vendor self-reports | Not comparable across harnesses |
| Mem0 92.5 / 94.4 | LoCoMo / LongMemEval | Mem0 April 2026 blog: LoCoMo 71.4→92.5 at 6,956 tokens; LongMemEval 67.8→94.4 at 6,787 tokens; top_200 retrieval. The README says scores "reflect Mem0's managed platform, which includes proprietary optimizations not available in the open-source SDK". Third party Particula.tech says GPT-5 was "both answerer and judge" (472/500 and 1,425/1,540) | Real gain, but 4–7× our injection budget |

### What beats our current design, and by how much

| Capability | Who does it | Evidence of gain | Do we have it? | Worth adopting? |
|---|---|---|---|---|
| Temporal validity on facts | Zep (bi-temporal), Hindsight, Mem0 May 2026 | Zep temporal reasoning 45.1 → 62.4 (+38.4% relative, gpt-4o) over full context | No | Yes: `valid_from`/`valid_to` |
| Knowledge-update handling | Zep, Mem0 | Zep knowledge-update 78.2 → 83.3 (gpt-4o); Mem0 April algorithm 91.6 → 92.5 LoCoMo after adding temporal reasoning and decay | Weekly diff only | Yes: supersede links |
| Entity linking across memories | Mem0 2026, Zep, Hindsight | Part of Mem0's +21 pt LoCoMo jump (71.4 → 92.5); ablation per component not published | No | Yes, light version: entity table keyed by real value + lemma |
| Hybrid semantic + keyword retrieval | Mem0 2026, Zep, Hindsight | Standard in all top systems | Yes (FTS5 + vector) | Already have |
| ADD-only extraction (history kept) | Mem0 2026 | Mem0 migration docs: p50 extraction latency fell from ~2.0 s to ~1.0 s when "two LLM passes (extract + merge)" became "single-pass ADD-only (one LLM call)" | Partly (replace/remove tool) | Yes: never delete, only close validity |
| Background consolidation | Claude Code Auto Dream, Honcho Dreamer, LightMem offline update | LightMem offline update: token use cut up to 38× total, 106× online | Yes (weekly) | Keep |
| Per-message LLM reasoning | Honcho, Zep | Honcho 90.4 LongMem S (self-reported) | No | No: breaks budget and "one call per chat" |
| Agentic multi-agent search | Supermemory ASMR | ~99% only as ensemble | No | No |

Key reading. A plain filesystem agent scored 74.0 on LoCoMo, above Mem0g's 68.5. A reproduction of LightMem found naive RAG "just as good". LoCoMo has only 10 conversations, and it has repeated questions. Scores move with answer model, judge and harness: EverMemOS gets 93.05 in its own paper and 82.75 in MemTensor's reproduction. So cross-vendor gaps under ~10 points are not decision-grade. Our hybrid FTS5 + vector recall over chunks is already the "naive RAG" baseline that reproductions find competitive. The real gaps are temporal validity, supersession and entity linking.

## Question 1 recommendation

**Build in-house.** Reasons:
- Mem0's best numbers come from its managed platform, not the open SDK.
- Zep, Honcho and EverMemOS need extra services (graph DB, Postgres, Redis, Milvus, Elasticsearch) and per-message LLM calls.
- Honcho is AGPL-3.0.
- No library supports "real values on disk, surrogates to the LLM" out of the box. We must own the mask/unmask boundary anyway.
- Borrow ideas: Mem0 2026 (ADD-only, entity linking, multi-signal fusion), Zep (bi-temporal validity), Claude Code (small always-loaded index plus on-demand detail).

**Data model (SQLite).**

| Table | Columns |
|---|---|
| `claims` | id, subject (`user` or entity_id), kind (fact, preference, goal, decision_pattern, quirk, relationship, rhythm), text_real, confidence (0–1), status (proposed, active, superseded, rejected), valid_from, valid_to, recorded_at, supersedes_id, source_chat_id, last_confirmed_at, times_seen |
| `evidence` | id, claim_id, chat_id, message_id, quote_real (≤300 chars), stance (supports, contradicts) |
| `entities` | id, canonical_real, lemma, aliases (inflected forms), type (person, place, org, code), surrogate (stable) |
| `claims_fts` | FTS5 over text_real + entity aliases |
| `claims_vec` | e5-small embedding of text_real |

**Extraction pipeline (one call per chat).**
1. At chat end, take the masked transcript. Surrogates must be stable per entity across chats so that the LLM sees the same token for the same person.
2. Send one call to a cheap model with: masked transcript, the ≤40 currently active claims most similar to the chat (masked), and a JSON schema.
3. Output: new claims, each with evidence message IDs, confidence, kind and valid_from; plus "supersede" proposals (claim_id, reason, valid_to).
4. Server unmasks surrogates to real values and writes rows as `proposed`.
5. Auto-activate only low-risk kinds (preference, rhythm) from chats with no untrusted tool output and confidence ≥0.8. Everything else waits for review. This keeps the existing approval rule for untrusted turns.
6. Never delete. Supersession sets `valid_to` and `status=superseded`.
7. Finnish: store lemma and inflected aliases for entities. Use an FTS5 trigram tokenizer, because the default unicode61/porter tokenizers do not stem Finnish (UNVERIFIED for our corpus). A Voikko lemmatiser in the Python sidecar is an option (availability UNVERIFIED).

**Retrieval and injection per turn.**

| Block | Content | Size | Changes when | Cache |
|---|---|---|---|---|
| Profile (system prompt) | USER.md + MEMORY.md, regenerated from top active claims | ≤4,000 chars (about 1,000–1,600 tokens; Finnish token ratio UNVERIFIED) | Only at weekly consolidation | Byte-stable, cached |
| Relevant claims | Top 5–8 active claims by fused FTS5 + vector + entity match on the user message, masked | ≤300 tokens | Every turn | After the cache breakpoint, at the end of the prompt |
| `recall(query)` tool | Chunks, summaries and claims with evidence | On demand | — | — |

Masking at injection must be deterministic, so the same real value always maps to the same surrogate. Otherwise the cached prefix breaks. Total memory cost ≈ 1.3–1.9k tokens per turn, most of it cached. That is below Mem0 2026's ~7k tokens per retrieval and in the range of Zep (~1.6k) and the Mem0 2025 paper (~1.7k).

**Review loop.**
- Weekly: show proposed claims with evidence quotes and the source chat link. Actions: accept, edit, reject, set expiry.
- Show "contradictions" (supersede proposals) first.
- Monthly: list claims not confirmed in 90 days for keep or expire. Lower confidence instead of deleting (decay).
- The assistant may state uncertain inferences ("decision patterns") only when confidence ≥0.6 and the claim cites ≥2 chats.

**Measurement (our own benchmark).**
- Build ~100 Finnish questions from real chats, in LongMemEval categories: single-session user, multi-session, knowledge update, temporal reasoning, preference, abstention.
- Store the gold evidence message IDs for each question.
- Metric 1: evidence Recall@5 of `recall()` and of the per-turn block. No LLM needed.
- Metric 2: QA accuracy with a masked LLM judge.
- Metric 3: injected tokens per turn and cache hit rate.
- Metric 4: claim precision = accepted / proposed in review.
- Run monthly and after every pipeline change. Add 10 new questions per month so the set does not go stale.

**Trade-offs.**

| Option | Recall / accuracy upside | Tokens per turn | LLM calls | Ops burden | Privacy fit | Finnish | Verdict |
|---|---|---|---|---|---|---|---|
| Current design | Baseline | ~1.0–1.6k (cached) | 1 per week | Low | Good | FTS5 weak on inflection | Keep as base |
| **In-house claims + temporal (recommended)** | Adds updates, temporal, entities | ~1.3–1.9k | 1 per chat | Low (SQLite) | Full control | Lemma + trigram | Adopt |
| Mem0 OSS | 92.5/94.4 only on managed platform | ~7k at published config | 1 per write | Medium | Needs custom mask layer | UNVERIFIED | Reject |
| Zep / Graphiti | Strong temporal | ~1.6k | Several per message | High (graph DB) | Entity split risk | Weak on inflection | Reject |
| Honcho | 90.4 self-reported | Small | Per message + per query | High; AGPL | Surrogate reasoning only | UNVERIFIED | Reject |
| Hindsight | 83.6–91.4 | Budgeted | Per retain + reflect | Medium (Postgres) | UNVERIFIED | UNVERIFIED | Watch |
| Letta-style agent memory | 74.0 LoCoMo | Agent-dependent | Many | Medium | OK | OK | Reject (cost) |

## Question 2 findings table

Read 2026-10-26. "Query control" = our server sets the exact query string.

| Backend | Query control | Result shape | Cost per search | Cost per 1,000 | Finnish | Latency | Retention / training | EU path | Rate limit | Status | Covered by OpenRouter ZDR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OpenRouter web plugin (`plugins:[{id:"web"}]`) | Indirect (we write the prompt) | Snippets/highlights in model context | Same as server tool engines | Exa $7 equivalent | UNVERIFIED | Model + search | Engine's own policy | None | UNVERIFIED | Deprecated | No |
| `openrouter:web_search` server tool, Exa | No: model writes query; `max_uses` caps count | Highlights, adaptive ~2–4k chars per result; `max_characters` settable | $0.007 (instant/fast/auto); deep $0.012; deep-reasoning $0.015 | $7–$15 + model tokens | UNVERIFIED | ~250 ms (instant) to ~1 s (auto); deep 4–15 s | Exa's own policy | None ("No engine is available on eu.openrouter.ai") | 30 server-tool steps per request max | Beta | No |
| Server tool, Parallel | No | Excerpts, default 1,500 chars per result | $0.001 turbo/fast; $0.005 basic/advanced | $1–$5 + model tokens | turbo: English and Japanese only; basic/advanced "broad language support" | ~200 ms to ~3 s | Parallel's own policy | None via OpenRouter | — | Beta | No |
| Server tool, Perplexity Search | No | Ranked results, snippets | $0.005 | $5 + model tokens | UNVERIFIED | UNVERIFIED | Own policy | None | — | Beta | No |
| Server tool, Firecrawl | No | Search results | $0.005 + $0.0125 per result ($0.0675 for 5) | $67.50 at 5 results | UNVERIFIED | UNVERIFIED | Rejected when ZDR enforced | None | — | Beta | Blocked |
| Server tool, native (Anthropic/OpenAI/Google) | No | Provider-synthesised with citations | Anthropic $10/1k searches. OpenAI, per its own pricing page: "Web search (all models) \| $10.00 / 1k calls + Search content tokens billed at model rates"; the preview tool is $25/1k calls. Google $14/1k after 5,000 free per month | $10–$14 + tokens | UNVERIFIED | UNVERIFIED | Provider policy | None | — | Beta | No |
| Perplexity Sonar via OpenRouter | No (model searches) | Synthesised answer + citations | Request fee $5/$8/$12 (low/med/high) + $1/$1 per M tokens | $5–$12 + tokens | UNVERIFIED | UNVERIFIED | ZDR status on OpenRouter UNVERIFIED | UNVERIFIED | UNVERIFIED | Active | UNVERIFIED |
| Sonar Pro / Sonar Reasoning Pro via OpenRouter | No | Synthesised answer + citations | Fee $6/$10/$14 + $3/$15 (Pro) or $2/$8 (Reasoning Pro) per M tokens | $6–$14 + tokens | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Active | UNVERIFIED |
| Sonar Pro Search via OpenRouter | No | Multi-step agentic answer | $18/1k requests + $3/$15 tokens | $18 + tokens | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | OpenRouter-exclusive | UNVERIFIED |
| Exa API direct | Yes | Results with highlights, full text, or summaries; Answer endpoint | Instant $0.004; auto $0.007; deep $0.012; + $0.001 per page per content type | $4–$15 + contents | UNVERIFIED | ~250 ms to 15 s | ZDR only on Enterprise | No EU endpoint found | Up to 25 QPS (pay-as-you-go) | Active | n/a |
| Parallel Search API direct | Yes | Ranked excerpts | Turbo/fast $0.001; basic/advanced $0.005; 10 results included | $1–$5 | Turbo: English and Japanese only | ~200 ms to ~3 s | ZDR on Enterprise; training policy UNVERIFIED | `eu.parallel.ai` under enterprise agreement | 600 req/min | Active | n/a |
| Tavily | Yes | Distilled snippets; optional LLM answer | Basic 1 credit, advanced 2; $0.008/credit PAYG | $8 basic / $16 advanced | UNVERIFIED | UNVERIFIED | UNVERIFIED (Nebius acquisition Feb 2026) | UNVERIFIED | Plan-based | Active | n/a |
| Brave Search API | Yes | Web results with snippets, extra snippets; LLM Context endpoint; Answers plan | $0.005 | $5 ($5 free credit/month) | `country=FI`, `search_lang=fi` supported; quality UNVERIFIED | UNVERIFIED | ZDR only on Enterprise; "Keeping any data from the API is prohibited" (secondary) | No EU endpoint found | 50 QPS | Active | n/a |
| Kagi Search API | Yes | Search results; Extract $4/1k | $0.012 | $12 | Country and language filters; FI UNVERIFIED | UNVERIFIED | Queries "logged temporarily for debugging" (general privacy page); API terms UNVERIFIED | No EU endpoint found | UNVERIFIED | Public preview | n/a |
| Jina Search (`s.jina.ai`) | Yes | Full page content as text | Fixed tokens per request, from 10,000 tokens | ~$0.45–$0.50 (secondary conversion) | UNVERIFIED | UNVERIFIED | UNVERIFIED (now under Elastic DPA, secondary) | UNVERIFIED | 100 RPM (free/paid key), 1,000 RPM premium | Active | n/a |

Notes.
- OpenRouter ZDR "does not apply to plugins, server tools, or their backends, which follow their own retention policies." So no OpenRouter search path is covered by our ZDR setting.
- Server tools are in beta, and on server tools the model writes the query. Our name-blocking filter then cannot run before execution. Pseudonymized prompts limit the leak to surrogates, but we lose the hard block.
- Every engine except Exa is rejected on `us.openrouter.ai`; none runs on `eu.openrouter.ai`.
- Kagi's own benchmark (self-reported) gives URL recall: Kagi 41%, Exa 38%, Brave 33%, Parallel 32%.

## Question 2 recommendation

**Default: Brave Search API, direct.** Why:
- Exact query control. The existing name filter stays as the gate.
- Explicit Finnish locale parameters.
- Lowest list price among exact-control options with broad language support ($5 per 1,000).
- No LLM call in the search path. Results go back to the main model through LiteLLM, so that hop stays under OpenRouter ZDR.
- Independent index, 50 QPS.

Request shape (path and `extra_snippets` name from Brave docs listing; verify on first integration):
```
GET https://api.search.brave.com/res/v1/web/search
  ?q=<server-composed query>
  &country=FI
  &search_lang=fi
  &count=5
  &extra_snippets=true
  &safesearch=moderate
Headers: X-Subscription-Token: <key>, Accept: application/json
```
Return to the model: title, URL, age, description, extra_snippets, capped at ~1,500 chars per result.

**Optional deep backend: Exa `/search`, `type: "deep"`, direct.** Why:
- Exact query control.
- Highlights cut tokens.
- Deep mode does multi-step search.
- Same engine we already use, so quality is known.
- Use only when the user asks for deep research, or when Brave returns <3 relevant results.

Request shape (field names per Exa docs as summarised by OpenRouter; verify):
```
POST https://api.exa.ai/search
Headers: x-api-key: <key>
{
  "query": "<server-composed query>",
  "type": "deep",
  "numResults": 5,
  "contents": { "highlights": { "maxCharacters": 2000 } }
}
```

**Monthly cost (30 days, search fees only; main-model tokens for results excluded).**

| Backend | Unit cost | 20/day (600/month) | 100/day (3,000/month) |
|---|---|---|---|
| Brave (list) | $0.005 | $3.00 | $15.00 |
| Brave (after $5 monthly credit) | — | $0.00 | $10.00 |
| Exa deep, 5 results + highlights | $0.012 + 5 × $0.001 = $0.017 | $10.20 | $51.00 |
| Exa deep (after $10 monthly credit) | — | $0.20 | $41.00 |
| Current: OpenRouter Exa (auto) | $0.007 + small-model tokens | $4.20 + tokens | $21.00 + tokens |

Deep search at 100/day breaks the "few euros per day" budget only marginally (~$1.70/day). Cap deep searches at 10/day in the server, which caps the deep spend at ~$5.10/month list.

**Do not choose.**
- Firecrawl: blocked under ZDR, $0.0675 per 5-result search.
- Sonar Pro Search: $18/1k plus tokens, and no query control.
- Native provider search: $10–$14/1k, no query control.
- Parallel turbo: English and Japanese only.

## Facts not verified
- Licences of Graphiti, Letta, Supermemory, MemOS, Memobase, Cognee, LightMem, LangMem.
- Any benchmark numbers for Cognee and LangMem on LongMemEval.
- Google Gemini app memory design.
- Token count of 4,000 chars of Finnish text with our main model's tokenizer.
- FTS5 default tokenizer behaviour on Finnish inflection in our corpus; Voikko availability in the sidecar image.
- Claude Code MEMORY.md 200-line / 25 KB cap. The quote "the first 200 lines of MEMORY.md, or the first 25KB (whichever limit hits first)" comes from guides that cite the official docs (fast.io, Vectorize), not from Anthropic's page directly.
- ChatGPT "summary pre-loaded every chat" mechanism (secondary analysis).
- Perplexity Sonar ZDR status on OpenRouter.
- Finnish search quality for every backend; no vendor publishes a Finnish evaluation that we found.
- Data retention and training terms for Tavily, Jina, Kagi API, and Parallel (training).
- Exact Brave and Exa endpoint paths and parameter names (taken from docs summaries; check on first call).
- Deprecation date of the OpenRouter web plugin (docs say deprecated; date not found).
- Mem0 open-source SDK scores on LoCoMo/LongMemEval with the 2026 algorithm.

## Sources
All sources were read on 2026-10-26. The citation pass attaches each URL to the claim it supports. Primary sources include: the Mem0 paper (arXiv 2504.19413) and Mem0 research and blog pages; the Zep paper; the Hindsight paper (arXiv 2512.12818, ACL 2026 demo); the EverMemOS repo and MemTensor OmniMemEval results; the LightMem paper (arXiv 2510.18866) and its reproduction (arXiv 2607.29104); the Letta benchmark blog; the Honcho repo; Claude Code memory docs; OpenRouter web search, server tools and ZDR docs; and the Brave, Exa, Parallel, Tavily, Kagi, Jina, Anthropic and Google pricing pages.
