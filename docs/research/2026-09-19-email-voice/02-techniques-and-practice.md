# Email voice: techniques and practice (research, 2026-09-19)

Web research only. Nothing here was tested on our system. "Peer-reviewed" = published at a reviewed venue; "preprint" = on arXiv, not yet reviewed; "vendor" = the company's own claim.

## Plain-language summary

1. The best-evidenced recipe is what we already do, plus one step: a written style guide AND real example emails together beat either alone.
2. More examples do not help much. Two to five is enough; ten is no better than two in the largest study.
3. Picking examples by TOPIC helps the draft say the right things, but does not make it sound more like the owner — in one email study it made it sound less like them.
4. Nobody has published a clean test of "pick examples by RECIPIENT". Linguistics says tone shifts by relationship, so it should help — but it is our experiment to run, not a proven fact.
5. Learning from the owner's edits works in research, but only when a rule is checked against several past emails before it is kept. One-off edits mislead.
6. Counting "sent without changes" as approval is risky: people accept "good enough", so the agent ends up teaching itself its own habits.
7. Even the best models still sound more like an AI than like the person. Email is the easiest case, but expect a ceiling.
8. Every automatic "does this sound like me?" score disagrees with the others. Use two or three cheap ones plus an occasional blind A/B by the owner.
9. Commercial tools (Superhuman, Fyxer, Gmail) claim per-recipient tone and learning from edits; none publish how, and their numbers are self-reported.
10. Gmail: the draft's identity is destroyed on send. Only the conversation (thread) id is documented to survive. Matching draft to sent mail needs a live test.

## What the evidence says we should do

1. **Keep voice card + examples together; do not drop either.** PROSE+examples beat examples alone by 9% and beat rules alone; humans preferred the combination 69% vs examples-only. Rules capture tone; examples capture structure. — Confidence: **high** (Apple, arXiv 2505.23815, May 2025; consistent with Richardson et al. 2023 on LaMP).
2. **Stay at 3–5 examples; spend effort on which ones, not how many.** Accuracy flat from 2 to 10 examples. — **High** (Wang et al., EMNLP Findings 2025).
3. **Add recipient-keyed examples alongside topic-keyed ones (e.g. 2 by recipient/relationship, 1–2 by topic), and A/B it.** Topic-similar selection reduced style fidelity on Enron email; style varies by power and social distance. No direct benchmark of recipient retrieval exists. — **Medium-low** (inference from Wang et al. 2025; Peterson et al. 2011; PersonaMail IUI 2026).
4. **Promote an edit-derived rule only after it is verified against several of the owner's OTHER sent emails**, and prune rules that past mail contradicts. This fits our owner-text-only safety rule: verification corpus = Sent mail. — **High** for the mechanism (PROSE), **low** for any specific threshold (none published; suggest ≥3 independent threads).
5. **Do not treat unedited sends as positive evidence for new rules.** Use them only as a metric. — **Medium** (PROSE critique of PRELUDE; CHI 2025 homogenisation study; Inbox Zero's Sept 2026 fix for automatic learning overwriting user corrections).
6. **Separate factual edits from style edits before learning.** ~31% of post-editors changed facts, not style. Classify each changed span (fact / commitment / style) and learn only from style. — **Medium** (preprint 2604.24444).
7. **Track a small per-recipient feature sheet computed only from the owner's own messages to that person** (greeting, sign-off, length, language, formality markers, emoji). — **Medium** (register research is solid; the specific list is our judgement).
8. **Measure with an ensemble: characters-kept/edit distance + send-without-edit rate + a monthly blind pairwise check by the owner.** No single metric is trustworthy. — **High** (arXiv 2508.06374; PersonalBench preprint).
9. **Correlate draft to sent by thread id + time + text similarity; treat Message-ID survival as unknown until a live probe.** — **High** on what is documented, unverified beyond.

## 1. Personalisation without fine-tuning

Peer-reviewed / benchmarked:
- **LaMP** (ACL 2024, https://aclanthology.org/2024.acl-long.399/) and **LongLaMP** (arXiv 2407.11016, July 2024; includes email generation): retrieving the user's own past items improves output substantially over no personalisation (LongLaMP reports ~30% ROUGE-1 average gain). ROUGE measures word overlap, not voice.
- **Richardson et al.** (Amazon, arXiv 2310.20081, 2023): an offline-written user summary plus retrieval matches or beats retrieval alone with 75% fewer retrieved items. Supports "profile + few examples".
- **Wang et al., "Catch Me If You Can? Not Yet"** (EMNLP Findings 2025, https://aclanthology.org/2025.findings-emnlp.532/): 400+ authors, 40k generations per model. Email (Enron) is the easiest domain (authorship-verification 96% for GPT-4o, 5-shot) vs blogs (19%). More examples barely help. Selecting examples by content similarity "surprisingly reduces attribution performance" on Enron. They did not test written style guides.
- **PROSE / PLUME** (Apple, arXiv 2505.23815, May 2025, https://machinelearning.apple.com/research/predicting-preferences): inferred written preferences +33% over CIPHER; combined with examples best overall. Rules alone underperform examples on weaker models, outperform on the strongest.

Preprint: **PersonalBench** (arXiv 2608.19746, Aug 2026): few-shot, profile-only and contrastive prompting all land in a narrow band, and all generated text sits further from the target author than random humans are from each other. Treat as a ceiling warning, not settled.

Recipient vs topic retrieval: **no direct comparison found.** Unverified.

## 2. Learning from edits

- **PRELUDE/CIPHER** (Microsoft, NeurIPS 2024, https://arxiv.org/abs/2404.15269): infer a written preference from each (draft, edited) pair, store it with the context, retrieve the k nearest contexts next time and merge. Lowest edit cost among baselines; preferences are human-readable and editable. Caveat: the "user" was GPT-4 simulated.
- **PROSE** adds the two safeguards we want: iterate until the inferred rule reproduces the owner's text (max 5 rounds), then break the rule into parts and score each against multiple other owner samples (−2 to +2); prune low scorers "to prevent overfitting". It also criticises edit-based setups: unedited generations carry no clear signal, and the draft itself biases what the user writes.
- **PersonaMail** (IUI 2026, peer-reviewed, n=16, arXiv 2602.17340): stores edits with the user's stated reason ("stylebook"); reuse cut task time 42%. Small, single-session, English.
- **Post-editing study** (preprint 2604.24444, n=81): edited text moves toward the person's style but stays closer to the LLM's; people feel it is authentic anyway; ~31% of edits were factual. Implication: edits under-report the true style gap, and sent-unchanged is weak evidence.
- Failure modes documented: overfitting one-off edits (PROSE); self-reinforcement and homogenisation (CHI 2025, https://dl.acm.org/doi/10.1145/3706598.3713564); automatic learning overwriting user corrections (Inbox Zero PR #3669, 2026-09-11, fixed with provenance: automatic writes cannot overwrite user-authored ones).
- No source gives an evidence threshold. Our add-only, human-approved design is stricter than anything published.

## 3. Audience and register

- Communication accommodation theory: people converge on the other party's style; lower-power writers accommodate more; accommodation by the higher-power party can backfire (Muir et al., J. Language & Social Psychology 2017, https://doi.org/10.1177/0261927x17701327).
- **Peterson, Hohensee & Xia** (ACL workshop 2011, https://aclanthology.org/W11-0711/): on Enron, formality tracks social distance, relative power and size of the request; measured via greetings, closings, requests.
- PersonaMail's review of 97 papers yields 8 recipient factors (relationship type, familiarity, power, culture…) and 9 situation factors (urgency, purpose, emotional intent…).

Suggested observable sheet per recipient, from owner-written text only: language (NO/EN); greeting form; sign-off form; median length; first name vs full name; contractions/emoji/exclamation rate; hedging vs direct requests; typical reply latency (metric only — do not imitate). Relationship label (client/collaborator/friend) should be owner-assigned, not inferred from the recipient's text.

Norwegian vs English: only practitioner sources found (e.g. https://www.tegeland.com/how-norwegian-email-etiquette-differs-from-global-norms/, https://nlsnorwegian.no/business-norwegian-mastering-the-art-of-email-writing-for-professional-success/): "Hei + first name" even to senior people, titles rare, short and direct, little small talk; English business mail expects more softening. **No peer-reviewed Norwegian email-register study located — unverified.** A Hermes (2021) article may be relevant but could not be opened.

## 4. Commercial products (all vendor claims unless noted)

- **Superhuman Auto Drafts**: learns from past conversations; third-party reviews say per-recipient tone, TechCrunch (2026-07-14) does not confirm it. Co-founder claim: 40% of drafts sent within a day, 60% of those unedited. Reporter saw it remember a correction, but also default to agreeing to pitches and a post-midnight meeting. https://techcrunch.com/2026/07/14/superhumans-new-auto-draft-feature-almost-makes-me-like-ai-replies/
- **Fyxer** (blog, 2026-07-21): last 300 sent emails; adapts by "who it's with"; learns "when you accept a draft as-is, edit a phrase, or change the sign-off" — i.e. counts unedited sends as signal; "55% sent unchanged" among power users. Complaints (aggregated by a competitor, eesel, Oct 2025; Reddit/Trustpilot, not individually verified): robotic tone, missed thread context, heavy rewriting, commitments made on the owner's behalf.
- **Shortwave Ghostwriter**: retrieves 5–10 semantically similar sent emails; fine-tuning only for autocomplete; learning from edits "not yet implemented" (ZenML case study, undated).
- **Gmail Suggested Replies** (Jan 2026, https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/): past emails + Drive for tone and detail; no per-recipient or edit-learning claims.
- **Outlook Copilot "sound like me"**: announced; no mechanism documented. **Apple Mail, Grammarly voice, Spark: nothing verifiable found** on per-recipient or edit learning.
- **Inbox Zero** (open source, https://docs.getinboxzero.com/essentials/assistant-settings): writing style is typed by the user, not learned; docs say editing drafts "helps the assistant learn over time" (mechanism not documented).

Recurring complaints: over-agreeable, too long, generic openers, AI tells (em dashes), invented commitments.

## 5. Evaluation

| Method | Pitfall |
|---|---|
| Edit distance / characters kept | Mixes factual and style edits; long drafts inflate; PROSE found weak correlation (<0.5) with preference quality |
| Send-without-edit rate | "Good enough" acceptance; vendor headline metric; biased by which mails get drafted |
| LLM-as-judge | Near-zero correlation with authorship models (r=0.013); rewards profile-style outputs (PersonalBench, preprint) |
| Authorship models (LUAR) | Weak on single short texts (AUC 0.76); mixes topic with style; English-trained — Norwegian untested |
| Human pairwise | Best signal; costly; people over-rate authenticity |

arXiv 2508.06374 (listed as accepted EMNLP 2026): ensembles of metrics consistently beat any single one.

Minimal eval for a few hundred pairs: (1) per draft, log characters kept, split into style vs fact spans, plus greeting/sign-off/language/length match against the recipient sheet; (2) weekly send-without-edit rate, reported by relationship type, as a trend only; (3) frozen replay set of ~50 past (incoming, owner-sent) pairs — regenerate after every voice-card change, compare to what was sent; (4) monthly 10-pair blind A/B (old vs new config) by the owner.

## 6. Gmail draft-to-sent matching

Documented (https://developers.google.com/workspace/gmail/api/guides/drafts, updated 2026-09-10): the draft id is stable while drafting, but "the underlying message IDs change every time the message is replaced"; on send "the draft is automatically deleted and a new message with an updated ID is created with the SENT system label". `drafts.send` returns that Message. Threading requires `threadId`, RFC-compliant `References`/`In-Reply-To`, and matching `Subject` (https://developers.google.com/workspace/gmail/api/guides/threads). Search supports `rfc822msgid:`; `history.list` reports `messagesAdded` with labels.

Not documented — **needs a live probe** (`tests/live/gmail-draft-send.live.mts`):
- Does the `Message-ID` header we set on an API-created draft survive when the owner sends from the Gmail web or mobile UI, and after they edit it? (Gmail is known to rewrite malformed Message-IDs into `X-Google-Original-Message-ID`.)
- Does `threadId` always survive if the owner changes subject or recipients?
- Does editing in the UI change the draft id or only the inner message id?
- What does `history.list` show: draft `messagesDeleted` + SENT `messagesAdded` in one record?

How others do it: Inbox Zero keeps the stable provider draft id and handles message-id replacement on autosave (PRs #3567, #3749). Fallback without any id: same thread + SENT + created after our draft + highest text similarity to the draft.
