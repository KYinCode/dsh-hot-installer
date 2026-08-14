# Upstream issue drafts (deepseek-ai/deepseek-harness)

Issues observed while testing `dsh-project-mcp-bridge`, ready to file on
https://github.com/deepseek-ai/deepseek-harness/issues.

---

## Issue 1: ~~dsh-mcp-client instance not disposed on HMR removal~~ — RETRACTED

**Status**: RETRACTED after clean re-verification (2026-08-14).

Re-verification: add host row via user patch layer (HMR applies, subprocess
spawns) → remove row (HMR applies) → process count returns to baseline
within ~8 s, subprocess gone, no respawn. The earlier "ghost processes"
were misread from a mixed timeline (project-plugin connections and manual
kills), not an official-bridge defect. The official bridge disposes its
transport and subprocess correctly on row removal. No issue to file.
