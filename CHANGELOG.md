# Changelog

This channel targets OpenCode V2 exclusively.

## Unreleased

Live release validation remains pending for instruction precedence, opaque-reasoning
replay, and continued work after automatic compaction, as recorded in
the [acceptance report](docs/opencode-v2-release-acceptance.md).

- Reconstruct authoritative host history through structured Cursor root blobs.
- Observe host tool, permission, question, and session events while forwarding
  results only from the next authoritative model invocation.
- Use bounded, per-Run Node HTTP/2 workers with validated Connect completion.
- Preserve late reasoning signatures in durable host metadata for fresh replay.
- Report terminal input, output, cache, and reasoning counters with explicit
  usage scope and separate checkpoint occupancy.
- Keep multi-invocation Run totals in durable provider metadata rather than
  misreporting them as usage for the final host invocation. Verify the correction
  against the pinned host's automatic compaction behavior.
- Preserve checkpoint-referenced opaque reasoning in durable host metadata and
  restore its exact placement during replay. Reject ambiguous or changed new
  roots rather than guessing their relationship to emitted output.
- Match opaque roots to visible text and tools even when Cursor also streamed
  thinking. Omit thinking-only roots and extra unmatched conversation roots
  instead of failing a completed answer.
- Treat Cursor `reasoning-effort` as a variant parameter so Gemini 3.8 Flash
  High/Medium attach to one model, matching Gemini 3.7 Flash.
- Group Cursor usable-model IDs by family: none is the non-thinking SKU, and
  thinking SKUs become low/medium/high/xhigh/max. Prefer default, then none,
  low, medium, high, xhigh, max.
- Add deterministic pinned-host acceptance and opt-in synthetic live probes.
- Project host system instructions into ordered Cursor rules as well as history
  roots. Add an explicit host contract for precedence and genuine tool outcomes.
  Instruction delivery remains best effort; live acceptance is pending.
- Restrict this package to the native V2 plugin API and its runtime dependencies.
- Migrate to released `@opencode/*` `2.0.6`, replacing the removed catalog API
  with provider source registration and reload.
- Refresh Cursor models on `credential.switched`, including sign-in and disconnect.
- Preserve tool-error metadata in structured compaction and auxiliary requests.
  Update host fixtures for directory loading and experimental session export APIs.

## 3.0.0-beta.2

- Native OpenCode V2 plugin, integration, catalog, and language-model APIs.
- Account-discovered Cursor models with exact model/variant routing.
- OpenCode-owned OAuth credentials, permissions, sessions, tools, and compaction.
