---
name: signals
description: Read the operational signal spine when asked what is alerting, what broke, or what the spine saw about something.
---

# Signals

Call `agent-kit__signals_recent` first whenever the owner asks whether anything is alerting,
what broke, or what the spine saw about a project or event. Never answer all-clear from memory.

Answer from the returned cards in their compact shape: `severity · [project] title · when ·
issue reference`, adding the count when it is greater than one and saying when a signal recovered.
An empty `cards` list is a real empty answer. If the result has `unavailable`, say plainly that
the spine could not be read; never turn unavailable into “nothing is alerting”.
