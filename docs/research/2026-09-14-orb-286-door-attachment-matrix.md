# ORB-286 — door × file-type matrix (Saga, Marcel)

**Date:** 2026-09-14 · **Engine:** eve 0.32.0 + `patches/eve.patch` (the patch does not touch the
inbound attachment files) · **Model adapter:** `@ai-sdk/anthropic` 4.0.37 via the gateway's
`/v1/messages` route · **Repo:** `97a887e9`

> **Update 13:45 — the owner's hand run stopped on errors. Two infra bugs found, both live:**
> every Slack PDF fails (the redirect to `slack-files.com` is dropped by the box firewall), and
> link reading has been dead for every agent since 2026-09-01 (undici 8 vs Node 22's `fetch`).
> See "Measured live" below.

## Status — half measured

| Layer | Status |
|---|---|
| **Door code** — what eve's parser, the upload policy and each door's gate let through to a turn | **Measured offline.** eve's real inbound code was run against every file type (`orb-286-instruments/door-code-matrix.mjs`). The update envelopes are **shaped** from the Telegram Bot API and Slack Events docs, not recorded from a device. |
| **Past the door** — file download, staging, what the model receives, what the agent says | **NOT measured.** Read from code only; every such cell below is a *prediction*. |
| **URLs** | **NOT measured.** |

**Why the live half is missing.** The live probe (`orb-286-instruments/door-attachments.live.py`)
is written and staged on the box but has **never run**. It gets each bot to upload a real fixture
file into the owner's own DM, then re-delivers that message to the agent's webhook *as if the owner sent
it*, and reads the agent's event log. Claude Code's permission check refused the delivery step as
impersonation of the owner against production. The Slack half needed the owner's stored user token to
upload as him, and that read was refused too. Both refusals are the owner's to lift or not. The
alternative is that the owner sends the fixtures himself.

## Measured live — the owner's hand sends, Slack → Saga DM, 2026-09-14 12:58–13:41 Oslo

the owner stopped after 12 cells because of the errors. The causes below were traced on the box: squid
access log, `workflow_steps.error_cbor`, and direct calls to the reader.

| Cell | Result | Cause |
|---|---|---|
| photo.jpg | **works** (read the code word) | — |
| iphone.heic | **error**, then the conversation ended | Anthropic refuses `image/heic` (`invalid_request_error … media_type: Input should be 'image/jpeg', 'image/png'…`). This confirms prediction 3. |
| “hi” in the HEIC thread | answered | The failed session is over; the reply starts a **fresh session with no memory of the thread** (a new `workflowEntry` at 10:59:20Z). eve's text “Start a new thread — I can't pick this one back up” is wrong. There is **no lasting poisoning** — prediction 5 is refuted for Slack. |
| audio clip | degrades: “Nothing came through — empty message” | The door drops the clip (prediction 4). She doesn't know it was audio. |
| “hi” in the audio thread | answered, same session | — |
| report.pdf (15 KB) | **error after ~46 s**, conversation ended | **Every Slack PDF fails.** Slack answers a PDF's `url_private` with `302 → https://slack-files.com/…`. `SlackProxyDispatcher` proxies only `*.slack.com`, so the redirect goes direct, the box's `saga_egress` drops it, and eve retries 4× on a 10 s connect timeout. Stored error: `EveAttachmentError: fetchFile for adapter kind="channel:slack" threw: fetch failed ← ConnectTimeoutError (3.68.124.168 … = slack-files.com)`. |
| big-scan.pdf (27 MB) | error, same cause | — |
| notes.txt / notes.md / contract.docx / budget.xlsx | **degrades with a message**: she names the file and says she can only see a path she can't open | Prediction 1 + 2 confirmed. Slack labels `.md` as `text/plain`. |
| link (paulgraham.com) | “the reader service is down (502, twice)” | **Link reading has been broken for every agent since 2026-09-01** — see below. |

### After the 14:15 hotfix — links (Slack → Saga) and the first Telegram cell, 14:21–14:26 Oslo

| Cell | Result | What it means |
|---|---|---|
| Slack PDF, after the fix | **works** (the owner confirmed) | — |
| Link, article, after the fix | **works** (the owner confirmed) | — |
| Paywalled article (NYT) | says it's blocked by the paywall | Honest. Fine as is. |
| PDF link (arxiv.org/pdf/…) | answered from the arXiv **abstract page** and said so | The reader refuses non-HTML (`unsupported content-type`). She worked around it this time; it won't work for most PDF links. **Gap.** |
| Google Doc (private) | says it needs a sign-in and suggests publish/export | Honest. **Gap:** a user expects their own doc to open. |
| YouTube | says there's no transcript | **Gap.** |
| Image URL | “I can't see it … I have no vision capability” | The reader refuses `image/jpeg`. **And the reply is false:** she does see images sent as attachments (S1). **Gap + wrong self-description.** |
| **Telegram photo (from Mac)** | **error after ~46 s; session ended** | **Prediction 6 confirmed: every Telegram attachment fails, for Saga AND Marcel.** Telegram's file server answers every download `Content-Type: application/octet-stream`. eve's `createTelegramFetchFile` prefers that header over the type Telegram already declared in the message (`photo` → `image/jpeg`, `document.mime_type`). It then re-checks against the upload policy: `Telegram file rejected — photo.jpg has media type "application/octet-stream" which is not allowed by this route` (`error_cbor`, 12:25Z). Even if the policy allowed it, the model adapter refuses octet-stream. Nothing staged in Telegram can reach the model until this is fixed. |

### Link reading is broken for every agent, and has been since 2026-09-01

The reader is up and healthy, and plain `fetch` from inside its container returns 200. But **every**
`/extract` call returns `502 fetch failed` in 0.2 s — paulgraham.com, wikipedia.org and nrk.no alike,
tested 2026-09-14. Reproduced inside the container:

```
undici 8.9.0 Agent + Node 22 built-in fetch → ERR fetch failed | cause: UND_ERR_INVALID_ARG
undici 8.9.0 Agent + undici's own fetch      → status 200
```

`54d04252` (2026-09-01, ORB-24 "parser bumps") moved `undici` `^7.27.0 → ^8.0.0`.
`services/readability/lib/extract.ts` hands an undici-8 `Agent` (the SSRF pin) to Node 22's
**built-in** `fetch`, and that pairing rejects the dispatcher. The suite stayed green because every
test injects `fetchFn`, which skips the dispatcher (`extract.ts:169`). This is the CLAUDE.md
third-party rule again: no test ever made a real call.

**ORB-289 has the wrong cause.** Its "worker said fetch failed on a notion.so URL" is this bug.
Notion is not special here, and the "reader is down" wording is wrong for a different reason than
the ticket assumed.

## What the door code does (measured offline)

Rows = what arrives. "Turn" = whether the agent is woken at all. "Model gets" = what eve hands on.

### Telegram — Saga and Marcel, private DM (same eve code, same upload policy)

Policy on both doors: `image/*`, `application/pdf`, `text/*`, 10 MB
(`services/eve-saga/agent/channels/telegram.ts:190`, `services/eve-marcel/agent/channels/telegram.ts:945`).

| Arrives | Turn? | Model gets | Door verdict |
|---|---|---|---|
| Photo (Telegram-compressed) | yes | the image | passes |
| Photo + caption | yes | caption + image | passes |
| PNG / JPEG sent as file | yes | the image | passes (see "past the door": > 3 MB) |
| HEIC sent as file | yes | an `image/heic` part | passes (see "past the door") |
| PDF ≤ 10 MB | yes | the PDF | passes |
| PDF > 10 MB | yes | **an empty message** | **file dropped; the agent is not told.** Only a container-log warning. |
| docx / xlsx / pptx | yes | **an empty message** | **file dropped; the agent is not told** |
| docx + caption | yes | the caption only | **file dropped; the agent is not told.** It answers the question as if no file came. |
| GIF (arrives as `video/mp4`) | yes | an empty message | file dropped; the agent is not told |
| txt / md / csv | yes | a `text/*` part | passes (see "past the door") |
| Voice note, audio, video, round video, sticker, contact | **no** | — | **silent drop.** eve's parser only knows `photo` and `document`, so the message looks empty and the door ignores it. No reply, no log line. |
| Location | no | — | Saga: silent drop. Marcel: stored as his live location, by design, with no reply. |
| Album of 3 | 3 separate turns | one image each | passes, but as three turns. The caption rides only on the first. |
| Forwarded message | yes | the text only | **the "forwarded from" is lost.** The agent reads it as the owner's own words. |
| Reply to an earlier photo | yes | the reply text only | **the replied-to photo is not passed on.** The agent sees only the chat and message ids. |
| Edited message | no | — | dropped by the parser. Marcel's live-location updates are affected too, as already known. |

### Slack — Saga DM

No upload policy is set on this door (`services/eve-saga/agent/channels/slack.ts`), so eve's
default applies: every type, 25 MB. The bot token **does** hold `files:read` (checked live via
`auth.test` 2026-09-14), and `files.slack.com` goes through the squid `.slack.com` acl.

| Arrives | Turn? | Model gets | Door verdict |
|---|---|---|---|
| JPEG / PNG / HEIC | yes | the image | passes |
| PDF, including 40 MB | yes | the PDF | passes. **No size check happens,** because Slack's file is a URL with no length known up front. |
| docx / xlsx / md / txt | yes | the file | passes |
| Album of 3 | yes, one turn | 3 images | passes |
| Audio clip / video clip | yes | **nothing from the file** | **dropped with no log line at all** (`slack/attachments.js` `toSlackFilePart` returns null for audio/video). With no text, the turn is an empty message. |

Slack channel mentions go through the same file collector. They were not run separately.

## Past the door — predictions from code, not measured

These decide the cells marked "passes" above. Each one needs a live send to settle.

1. **eve stages every file in the agent's sandbox, then shows the model only two kinds inline:**
   images ≤ 3 MB and PDFs ≤ 20 MB (`eve/dist/src/harness/attachment-staging.js`,
   `shouldInlineSandboxRefAsBytes`). Everything else — txt, md, csv, docx and xlsx on Slack,
   images > 3 MB (an iPhone photo sent as a file), PDFs > 20 MB — becomes a single line of text,
   `Attached file /workspace/attachments/<hash>/<name> (<type>)`.
2. **Neither agent can open that path.** `read_file`, `bash`, `glob` and `grep` are all disabled
   on Saga and Marcel (`agent/tools/*.ts` → `disableTool()`, ORB-52). So for every text-reference
   file, the agent can at best name the file and say it cannot open it. At worst it guesses.
   → **Prediction: txt / md / csv / docx (Slack) / large photos = "degrades", and only if the
   model chooses to say so.**
3. **HEIC reaches the model as `image/heic`.** The Anthropic adapter passes any `image/*` type on
   unchanged (`@ai-sdk/anthropic` `convertToAnthropicMessagesPrompt`), and Anthropic's API accepts
   jpeg / png / gif / webp only. → **Prediction: the turn fails with eve's generic error text.**
4. **An empty message** (docx, xlsx, pptx, GIF or PDF > 10 MB on Telegram with no caption; an
   audio clip on Slack) is sent to the model as empty user content. Anthropic rejects empty content.
   Marcel's own code says so (`eve-marcel/agent/channels/telegram.ts:311`), but it guards only the
   **group** path. → **Prediction: a generic error.**
5. **Session poisoning (the high-impact hypothesis).** A Telegram DM is ONE eve session per chat-day
   (see the `project_eve_session_is_a_chat_day_not_a_conversation` memory). If the rejected part
   from 3 or 4 stays in that session's history, **every later message that day fails too,**
   until the day rolls over (ORB-74 rotation). That would match "spotty". **This is the first
   thing a live run must check:** send a HEIC, then plain text, and see whether the text is answered.
6. **Telegram's file server `Content-Type`.** eve takes the downloaded file's media type from the
   response header, then re-checks it against the upload policy (`telegram/attachments.js`
   `createTelegramFetchFile`). If Telegram answers `application/octet-stream`, **even photos and
   PDFs fail at download.** Unverified — this is exactly the "a fixture is belief" case in CLAUDE.md.
7. **Whether the sandbox is bound at all.** If it isn't, file parts stay `telegram-file:` URLs, and
   the model adapter can't fetch them (`attachment-staging.js` `stageAttachmentsToSandbox` returns
   early). This decides whether *any* file works.

## The contract, against today's code

Contract (ORB-286): every cell either works, or the agent **says plainly what it cannot do.**
Silent drop is the only failure.

- **Definite silent drops (door code, measured):** voice, audio, video, round video, sticker,
  contact on both Telegram doors; location on Saga; audio/video clips on Slack.
- **Silent to the agent, so it cannot say anything (measured):** Office files, GIFs and PDFs over
  10 MB on Telegram. The agent is never told a file arrived. With no caption, the turn is empty;
  with one, it answers a question about a file it never saw.
- **Context lost without a word (measured):** forwarded-from, replied-to photo.
- **Everything else:** unknown until the live run (predictions 1–7).

## Fixtures

Each file carries one code word, so a reply that quotes it proves the content was read:
photo `FALCON-4417`, PNG `HERON-2268`, HEIC `OTTER-9051`, PDF `MAPLE-3320`, docx `CEDAR-1187`,
xlsx `BIRCH-5543`, pptx `ASPEN-7702`, txt `LARCH-6639`, md `SPRUCE-8816`, csv `ROWAN-3094`, caption
cells `LINDEN-5050` / `ELM-2020` / `YEW-3030`, album `PINE-1111/2222/3333`, forward `ALDER-7070`,
reply `HAZEL-6060`, plus a 26.7 MB PDF, a voice note, an mp3 and an mp4.
The generator is `orb-286-instruments/make-fixtures.sh` (macOS: `sips`, `cupsfilter`, `textutil`,
`magick`, `ffmpeg`). The built set is staged on agent-1 at `/root/orb286/fixtures/`.

## To finish the matrix

Pick one:

- **A — the probe runs as written.** the owner allows `ssh root@192.0.2.10 python3
  /root/orb286/door-attachments.live.py …` for this ticket. Cost: roughly 26 model turns per agent
  (≈ $3–5 on `owner-chief`, which had $26 left of its $50 / 30 days on 2026-09-14). Side effects:
  fixtures and replies land in the owner's DMs with both bots, and the probe turns go into that
  chat-day's session and into Saga's Brain conversation log (`_meta/conversations/`). They are
  tagged "ORB-286 probe" and can be removed afterwards.
- **B — the owner sends by hand.** The same fixtures, from his phone and desktop, into the Saga DM
  (Slack and Telegram) and the Marcel DM. The phone is the only way to prove the real-device
  envelopes anyway: HEIC from the camera roll, a real voice note, a real album, a real forward.
  He notes works / error / nothing for each.
- **Both.** A for the bulk; B for the four real-device cells and the whole Slack column.

Whichever runs, run the **poisoning check** (prediction 5) first. It decides how urgent the fix is.
