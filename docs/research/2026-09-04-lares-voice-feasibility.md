# Lares voice — feasibility note (audio conversations with Saga, Marcel, Calliope)

**Date:** 2026-09-04
**Status:** assessment only — nothing built, nothing decided beyond the recommendation at the end.
**Question asked:** if we wanted to talk to the agents by voice, how would it work? Does it fit the
standard doors (Slack, Telegram) or does it need a Mac helper app? Which vendors? Could ChatGPT be
the audio gateway over an MCP into Lares?
**Method:** eve 0.32 channel types and our channel files read; the gateway config read; vendor
state checked on the web the same day (sources at the bottom). No live probes were run — every
"needs verifying" below is genuinely unverified.

---

## 1. Short answer

- **Voice notes over Telegram and Slack are feasible now**, with a small build and no Mac app.
  This is the walkie-talkie mode: record, the agent transcribes and answers, optionally with a
  voice clip back.
- **A live, interruptible conversation** (ChatGPT-voice style) is a different product. It needs a
  streaming audio surface — the console web page can be that surface — and a real architecture
  decision about who the brain is.
- **A Mac helper app is the last option, not the first.** A console page with a mic button covers
  nearly everything a native app would, and the console is being built anyway (console-first rule,
  `docs/superpowers/specs/2026-08-17-shared-agent-stack-design.md`).
- **ChatGPT as the audio gateway does not work today**: ChatGPT voice mode cannot call custom MCP
  connectors. The MCP half of that idea is still worth building (§4), the voice half is blocked by
  OpenAI, not by us.

## 2. What the code does today (verified 2026-09-04)

| Fact | Where |
| --- | --- |
| eve's Telegram inbound parser only recognises `"document" \| "photo"` attachments. A voice note arrives as empty text, empty caption, no attachments. | eve 0.32 `dist/src/public/channels/telegram/inbound.d.ts:34` |
| Saga's Telegram door keeps audio out of `allowedMediaTypes` on a recorded verdict (2026-08-14): the old door declined audio gracefully; what eve does with a disallowed inbound type is **not verified** (no live bot to test then). | `services/eve-saga/agent/channels/telegram.ts:184-190` |
| Marcel already has the user-facing guard: a tagged message with no dispatchable content (voice note, sticker, video) gets a fixed Norwegian "I don't support that message type yet" reply, because an empty prompt is rejected by the model. Marcel cannot tell a voice note from a sticker. | `services/eve-marcel/agent/channels/telegram.ts:311-325`, `:945` |
| Slack: eve's channel handles file uploads outbound via Slack's external-upload flow; inbound audio clips arrive as ordinary files with a mimetype. | eve 0.32 `dist/src/public/channels/slack/api.d.ts:67-102` |
| eve ships a **Twilio channel** with voice calls, speech transcription hooks (`defaultOnVoice`, `defaultOnVoiceTranscription`) and turn-based speak/listen TwiML helpers. Nothing in Lares uses it. | eve 0.32 `dist/src/public/channels/twilio/` |
| The gateway (LiteLLM) has **no audio models** configured. LiteLLM itself supports `/audio/transcriptions` and `/audio/speech`, with Mistral listed as a transcription provider. | `services/gateway/config.yaml` (model_list: Claude, gpt-4o, gemini-flash, jina-embeddings) |
| Saga has an authenticated HTTP session route (Basic auth, password from a secret file) that runs a full eve turn and streams `actions.requested` / `action.result` / `message.completed`. This is the only non-human, authenticated way in. | `services/eve-saga/agent/channels/eve.ts`; recipe in memory `project_saga_acceptance_via_http_route` |
| We already carry an eve patch, so a small parser addition is a known, accepted mechanism. | `patches/eve.patch` (6 hunks) |

## 3. Three tiers

### Tier 1 — voice notes in Telegram and Slack (recommended first)

Inbound: voice note → fetch the audio file from Telegram/Slack → speech-to-text through the
gateway → the transcript enters the normal turn as text, so persona, memory, tools, HITL, budgets
and Langfuse all apply unchanged. Outbound (optional): text-to-speech → send as a Telegram voice
message or a Slack file.

Work:
1. Telegram: eve's inbound parser must surface `voice`/`audio` (Bot API `message.voice`) as an
   attachment kind, or a sidecar on the raw update must fetch the file. Either way it is a patch or
   an extension at the parser seam; Marcel's guard at `telegram.ts:311` then becomes the fallback
   for stickers/video only.
2. Slack: accept `audio/*` in `uploadPolicy.allowedMediaTypes`, fetch the file with the bot token.
3. Gateway: add a transcription model entry (and a TTS entry if voice replies are wanted) to
   `services/gateway/config.yaml`, with the same per-(user, agent) key/budget split as text
   (ORB-202).
4. A `lib/transcribe.ts` in `packages/agent-kit` so all three agents share one code path.

Latency is seconds and asynchronous, which matches how voice notes are used. Effort: days.

### Tier 2 — phone calls (Twilio)

eve's Twilio channel gives a phone number you can call, with Twilio doing speech-to-text and
text-to-speech and eve running the turn between. Nearly no custom code. Twilio is a US vendor and
carries the audio, so it needs a case-by-case sovereignty decision
(`feedback_vendor_sovereignty_pragmatism`). Prototype effort: hours. Not recommended before Tier 1.

### Tier 3 — real-time full-duplex conversation

Needs a persistent microphone stream: a console page with a mic button, or a native app. The
surface is the easy part. The hard part is the brain:

- **OpenAI Realtime** (speech-to-speech, ~300–500 ms) and **ElevenLabs Agents** (pipeline
  STT → LLM → TTS, ~450–750 ms) both run their *own* conversation loop. Plugging them in "as
  Saga" means ChatGPT-or-ElevenLabs wearing Saga's name: no eve memory, no dream cycle, no
  chat-day session, no HITL cards, no LiteLLM budget, no Langfuse trace.
- The honest design is a **custom pipeline**: streaming STT → an eve turn → streaming TTS, with
  the voice vendor reduced to ears and mouth. Or the vendor's agent calls Saga as a single tool
  (§4), accepting dead air while a multi-tool Saga turn runs (seconds to tens of seconds).

Effort: weeks, and an architecture decision. Not before Tier 1 has been lived with.

## 4. "Add an MCP to Lares and use ChatGPT as the audio gateway"

Checked 2026-09-04: **ChatGPT voice mode does not call custom MCP connectors.** Developer mode
(Plus/Pro, web-first, beta) lets you paste a remote MCP server URL and text chats can call its
tools; the voice conversation runs without them. There is an open prediction market on whether
this lands before July 2026. So the exact plan is blocked upstream.

Two shapes of the MCP, only one of which is right:

| Shape | What happens | Verdict |
| --- | --- | --- |
| Expose Saga's *tools* over MCP; the external client drives them | External model becomes the brain, Saga becomes hands. Loses persona, memory, session, HITL, budgets, traces. Answers differ from Slack-Saga. | **No.** |
| Expose **one tool, `ask_saga(text)`**, backed by the existing HTTP session route | Client is a microphone and speaker. The turn runs inside eve exactly as today. | **Yes** — small build (thin MCP server + OAuth in front of the route), and useful on its own for Claude Desktop / Claude Code. |

Costs that apply to *any* US voice client, either shape:
- **Sovereignty.** The user's voice and everything Saga answers transit the vendor. Saga's answers
  draw on Brain (personal, Saga-only by decision — `project_brain_personal_business_split`), CRM
  and email. A far wider data flow than an LLM call through the gateway.
- **Latency.** A tool-running Saga turn is seconds to tens of seconds; in a voice conversation
  that is dead air, and MCP clients have their own timeouts.
- **Exposure.** A public MCP endpoint into Saga needs OAuth and a caller → principal mapping,
  i.e. the same gating work as the console.

Whether the **Claude app's** voice mode calls connectors today was not verified; test live before
betting on it.

## 5. Vendors and models

Never chosen from memory; verify with a live probe before any of these becomes a config line
(`CLAUDE.md` third-party-API rule: the sweep, not the fixture, is the acceptance bar).

| Role | EU option | US option | Note |
| --- | --- | --- | --- |
| Speech-to-text | **Mistral Voxtral** (Transcribe 2: batch + realtime; realtime is open-weights, Apache 2.0). LiteLLM lists Mistral as a transcription provider, so it can go through the gateway. Hostable on Scaleway. | OpenAI transcription, ElevenLabs STT | **Norwegian quality unverified** for all of them. Probe with real voice notes. |
| Text-to-speech | **Mistral Voxtral TTS** (4B, 9 languages, open-weights) | **ElevenLabs** — best quality, distinct voice per agent, voice cloning | ElevenLabs is US; case-by-case. Norwegian coverage of Voxtral TTS unverified. |
| Speech-to-speech (no STT/TTS step) | — | OpenAI Realtime, ~$0.06–0.10/min (mid-2026) | Replaces the brain. Only for Tier 3 "voice front end calls Saga". |
| Phone | — | Twilio (eve channel exists) | Carries audio; sovereignty decision. |

## 6. Recommendation

1. **Tier 1 first, Marcel first** (travel on the go is the obvious use), then Saga. STT via the
   gateway; voice replies optional. Smallest data footprint, no new surface.
2. **Build `ask_saga` as an MCP** when a voice client exists that can call it, and treat it as the
   reusable front door for any Tier 3 pipeline later. Not as a voice plan today.
3. **Decide Tier 3 only after a few weeks of voice notes.** No Mac app.

Follow-up ticket: [ORB-221](https://linear.app/heiberg-industries/issue/ORB-221) — "Lares voice —
shape Tier 1 voice notes (Telegram/Slack) and the ask_saga MCP", filed 2026-09-04, Backlog, Low.

## Sources (checked 2026-09-04)

- [OpenAI Realtime vs LiveKit vs ElevenLabs](https://kanopylabs.com/blog/openai-realtime-api-vs-livekit-agents-vs-elevenlabs)
- [Voice AI latency 2026](https://tokenmix.ai/blog/voice-ai-api-realtime-vs-gemini-live-vs-elevenlabs-2026)
- [ElevenLabs pricing 2026](https://pxlpeak.com/blog/ai-tools/elevenlabs-pricing-guide)
- [Voxtral TTS](https://mistral.ai/news/voxtral-tts/) · [Voxtral Transcribe 2](https://mistral.ai/news/voxtral-transcribe-2/)
- [Scaleway sovereign AI API](https://www.edenai.co/providers/scaleway)
- [LiteLLM /audio/transcriptions](https://docs.litellm.ai/docs/audio_transcription) · [LiteLLM /audio/speech](https://docs.litellm.ai/docs/text_to_speech)
- [ChatGPT voice mode and custom MCPs (community)](https://community.openai.com/t/chatgpt-support-of-mcp-in-voice-mode-on-web-and-android/1382072)
- [Developer mode and MCP apps in ChatGPT (help center)](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Custom MCP in Claude and ChatGPT (Willison)](https://til.simonwillison.net/llms/mcp-in-claude-and-chatgpt)
- [Prediction market on voice-mode MCP](https://manifold.markets/singer/chatgpts-voice-mode-allows-custom-m)
