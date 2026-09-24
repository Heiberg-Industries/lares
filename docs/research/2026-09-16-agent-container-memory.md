# Agent capacity reading — owner approval pending

Read-only measurement captured 2026-09-16 17:38–17:40 Europe/Oslo by the controller. No restart, configuration write or controlled load. Docker current usage was supplemented with cgroup v2 `memory.peak`; peaks cover container lifetimes starting approximately 07:36–07:58. Container limits/reservations were zero; no swap. No host load-average reading was recorded, so this is not a measured busy-workload guarantee.

| Container | Current bytes | Lifetime peak bytes |
|---|---:|---:|
| Saga | 2789937152 | 3138240512 |
| Marcel | 1816055808 | 2246868992 |
| Calliope | 820961280 | 925274112 |
| Console | 149794816 | 158732288 |
| Notion sync | 231206912 | 257708032 |
| Atlas sync | 162045952 | 223412224 |
| Proxy | 15843328 | 21241856 |
| Database | 354336768 | 1198030848 |

RAM: **8127713280 bytes**. Non-agent current stack: **913227776 bytes**. Largest observed agent peak: **3138240512 bytes**. Fixed B1 headroom: **2147483648 bytes (2 GiB)**.

`floor((8127713280 - 913227776 - 2147483648) / 3138240512) = 1`.

This result is **not approved or adopted**. No setting or migration seeds it. Missing `agents.ceiling` fails creation closed; zero is a valid configured ceiling. Existing three agents continue and definition saves do not check capacity. There is no host override. A Task20 throwaway fourth-agent acceptance cannot run at this measured capacity with all three retained. A human must approve a representative measurement, and capacity must actually permit creation; do not bypass the policy.

## Fresh-install amendment — 2026-09-24

The owner approved a narrower launch decision for the fresh tested path: after the installer's
6 GiB preflight floor passes, it initializes a missing `agents.ceiling` to **1** so the first agent
can be created. This is a conservative product floor, not a retrospective approval of the
single-box observation above and not a claim that every role has the same memory profile. Existing
settings are never overwritten. Raising the ceiling still requires a representative measurement;
zero remains a valid explicit lockout.
