# Certification matrix (0.1.0)

Evidence checklist for publishable `0.1.0`. Unit evidence is always required;
acceptance evidence is platform/runtime dependent.

| Area | Unit (`pnpm check`) | Acceptance (`pnpm test:acceptance`) |
| --- | --- | --- |
| Config / discovery / targets | yes | — |
| Lifecycle create/up/drift/recreate | yes (FakeHost) | local + remote when runtime available |
| Dockerfile image ensure | yes | local when Docker + msb available |
| Network default-deny / allow / publish | yes | local when runtime available |
| Runtime secrets redaction | yes (canaries) | — |
| Process collect / stream / shell / PTY | yes | local + remote |
| Transfer file/dir | yes | local + remote |
| QCOW2 base / child / shell / remove | yes | local when qemu-img + formatter present |
| Remote HTTP/WS + auth + protocol | yes | remote serve |
| Non-loopback HTTP warning | yes (`doctor-url`) | yes (`remote-nonloopback.acceptance`) |
| CLI `run` finally cleanup | yes | local + remote |
| Sandcastle adapter | yes | local + remote |
| Declaration leak | yes | — |
| Repository audit / feature inventory | yes | — |
| Doctor required vs informational | yes | — |

Platform notes: Windows / macOS / Linux are remote-client capable. Local-host
evidence depends on Microsandbox support; unavailable acceptance is reported
as skipped (`sbox-acceptance-status: unavailable`), not as a pass.
