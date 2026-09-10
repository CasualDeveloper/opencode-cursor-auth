# OpenCode-owned Cursor adapter

The V2 adapter uses AgentService through a narrow direct protocol client.
OpenCode owns the conversation, tool execution, permissions, steering, and
compaction. Cursor receives structured history and requests host tools through
MCP. A live Run is a disposable continuation, never the durable session.

The replacement has deterministic acceptance against the pinned OpenCode host,
including tool scheduling, interruption, images, forks, and compaction. Live
acceptance now covers Composer, Auto, Opus, signed reasoning after restart,
452k mixed history, and conversation-correlated billing comparisons. See the
[release acceptance results](opencode-v2-release-acceptance.md) for the measured
limits, including the absence of a cross-Run cache saving in the long tests.

## Host API compatibility, September 16, 2026

The adapter now targets `@opencode/plugin` and `@opencode/schema`
`2.0.6`. It registers the provider and complete model inventory through
`context.provider.transform`, then calls `context.provider.reload` when a
`credential.switched` event changes the active Cursor connection. The old
`context.catalog` API is no longer used.

Compaction now receives structured messages. Tool-error metadata is preserved
in `context`, `compaction`, `generate`, and `title` hooks before AI SDK conversion.
Configured local plugins point to directories containing an entrypoint.

## Decision, September 10, 2026

The final architecture review recommended AgentService, a direct client,
structured history, and bounded continuations at 78% subjective confidence.
The implementation decision agrees at 80%. These are engineering judgments,
not measured reliability rates.

AgentService has the strongest available evidence for account-discovered
Auto/default, Composer, and exact private-model variants. The
[thirty synthetic Runs](opencode-v2-cursor-capability-probe.md) support the
endpoint and root-history representation. They did not test this replacement.

The official [Cursor SDK](https://cursor.com/docs/sdk/typescript) is the strongest
alternative because it maintains the protocol and exposes usage reporting.
Its callbacks can wait for OpenCode's real results. The unresolved question is
whether it can reconstruct a checkpoint entirely from host history after
restart, steering, or compaction without duplicating that history as prose.
A thin SDK adapter that passes that contract would justify replacing the direct
client. The SDK's API-key authentication also needs separate validation against
the required account access; the existing OAuth token is not assumed equivalent.

## Request lifecycle

1. `src/opencode/language.ts` compiles the current host prompt and resolves the
   current OpenCode-managed credential before choosing a continuation.
2. `src/opencode/history.ts` preserves message roles and paired tool IDs.
   Genuine tool results carry explicit success, error, or denial information.
   Printed tool notation remains assistant text. Orphan results fail explicitly.
3. `src/cursor-agent-protocol.ts` creates content-addressed root blobs and an
   opening action with the current user input. It sends the exact model ID,
   parameters, max mode, and MCP tool snapshot. Historical user images retain
   their message position; current images use `SelectedImage`.
4. `src/cursor-agent.ts` validates structured execution requests and exposes
   ordinary V3 tool calls. It records queued, delivered, and forwarded calls
   separately. It never executes a tool.
5. OpenCode executes and persists the calls. Public host events tell the adapter
   when it can end a tool-delivery step. The next model invocation supplies the
   authoritative outcomes after OpenCode's steering/compaction boundary.
6. The client resumes only when the host scope, credential, endpoint, model,
   tools, prior history, emitted assistant content, and expected results match.
   Otherwise it reconstructs a fresh Run from the host prompt.

Each Node worker owns one Run and connection. The worker restricts Cursor to
`mcp_tool_call`, or sends an explicit empty allowlist when tools are unavailable.
It validates HTTP status, Connect framing, compression, end status, and EOF.
`turnEnded` alone is insufficient for a successful final response. Protocol
errors are reported without copying upstream diagnostic payloads. Final blob
operations and checkpoints can arrive after `turnEnded`; the request remains
writable until the validated response ends, with a five-second drain deadline.
The V2 client recognizes the SDK's post-turn feedback-form notification without
treating it as model output. Unknown terminal updates still fail.

The worker starts lazily. Connection pooling can be added after measuring a
benefit.

## Tool delivery and parallel execution

The pinned `2.0.6` host starts tools while the provider stream remains
open. The integrated fixture makes tool A wait for tool B, which arrives 1.5
seconds later. Both execute before the next model invocation. This exercises a
dependency that crossed the original one-second delivery window.

`src/opencode/tool-observer.ts` observes public tool success/failure, permission
replies, question forms, and session execution events. A rejected permission or
dismissed question releases its delivery wait even though the host publishes
the terminal tool failure later. These events never supply Cursor tool results.
Session termination also discards any abandoned Run, and unloading one plugin
scope leaves other scopes' Runs intact.

The adapter keeps delivering calls while host tools run. After all delivered
calls settle, it waits one second for more calls before handing control back to
OpenCode. Model-output watchdogs pause during observed host work. The maximum
hold is five minutes (`OPENCODE_CURSOR_NATIVE_TOOL_WAIT_MS`); it yields a host
step without inventing outcomes if a terminal signal is unavailable. Losing the
event subscription fails the Run explicitly. Direct `LanguageModelV3` callers
without the host observer retain a one-second finite delivery window.

These are delivery policies, not upstream batch-completion signals. Calls that
arrive after a handoff remain queued on the same Run for the next host step.
Previously delivered calls require results; queued calls do not. Identical
retransmissions cannot execute twice, and conflicting retransmissions fail.
Dependencies spanning the maximum hold still need workload acceptance; the
adapter does not guarantee simultaneous launch of an entire upstream group.

## Usage, caching, and bounds

The V2-only `TurnEndedUpdate` projection in `src/proto/agent-v2-usage.proto` uses
the optional int64 fields verified in the static
[@cursor/sdk 1.0.31 archive](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz).
When Cursor supplies them, the adapter reports inference input, output, cache
reads/writes, and reasoning.
The AgentService wire input count already includes cache reads and writes.
The adapter reports it as total input and subtracts the two cache counters to
derive uncached input. This was verified against a conversation-correlated Auto
billing row. Adding cache counters to the wire input would double-count them.
Reasoning is a subset of output. Missing fields remain unknown, explicit zeros
remain zero, and negative, unsafe, or inconsistent counters fail validation.

Terminal counts are retained once in `providerMetadata.cursor.turnUsage`, with
`usageScope: "cursor-turn"`. Standard V3 usage describes one host model invocation.
When a Run spans multiple invocations, those per-invocation counts remain unknown;
the adapter cannot allocate the aggregate truthfully. A Run completed within one
invocation still reports its counters as standard usage. OpenCode's built-in
token and cost totals are consequently incomplete for multi-invocation Runs.
The pinned host persists the complete Run counters in exported provider state.
Interrupted or discarded Runs without terminal
usage remain unaccounted for by the stream. Composer, Auto, and Opus reported
terminal counters on the OAuth endpoint. The acceptance harness correlated
abandoned Runs with billing records instead of assuming zero cost.

Checkpoint occupancy is exposed as `providerMetadata.cursor.contextTokens`.
Progress deltas are exposed separately as `outputTokenDelta`. Neither is
substituted for inference usage. Settled charges and account allowance
consumption remain unavailable to the adapter; OpenCode's list-price estimates are not a
billing ledger. The acceptance harness matched Run `conversationId` values to
the dashboard's `UsageEventDisplay.conversationId` for all eleven new test Runs.
The production adapter does not query the billing ledger. Mapping these Runs to
the separate `Agent.getUsage()` API remains unverified.

### Signed reasoning

Opus sends reasoning signatures in assistant root blobs after host tool results
have already been forwarded. The adapter accepts a signature only when a
checkpoint references that root, its text matches one unique emitted reasoning
block, and the reported model name matches the selected public ID.

It persists the late signature as a metadata-only reasoning part in OpenCode,
linked by a generated block ID and text digest. Fresh reconstruction reads that
durable annotation and places the signature on the original reasoning block.
The annotation itself and its local ID never become model text. Edited reasoning
and different selections do not reuse the signature. Plain reasoning boundaries
are preserved independently of signatures.

Both a pinned-host fork test and a live Opus export/import into a new isolated
host verified this path. No separate provider transcript store is required.
Opaque `redacted-reasoning` blocks now use a separate durable annotation. The
adapter keeps each `data` string unchanged and records its position, including
offsets where the host coalesced adjacent text. A digest of the visible assistant
content, with real tool IDs mapped to host IDs, anchors that annotation to one
message. No second transcript is stored. The opaque bytes never become visible
reasoning or ordinary model text.

Only roots referenced by the final checkpoint can contribute new opaque blocks.
A digest of the visible text and tools, ignoring streamed thinking, must match
one assistant message emitted by that Run. Already-stored roots are not emitted
again. Thinking-only roots, extra unmatched conversation roots, and wrong-model
roots are omitted instead of failing an already-streamed answer. Conflicting or
oversized metadata in compile/replay still fails explicitly. On replay, edited
or compacted-away anchors are not reused; changing the selected public model
omits the old opaque blocks. Unreferenced tool/file blobs cannot create
assistant history.

Offline tests cover late delivery after host tool results, either checkpoint/blob
arrival order, `doGenerate`, ordered reconstruction, edits, selection changes,
and malformed metadata. The pinned host persists signed and opaque parts together,
forks them, then restarts and replays them from its database. No live redacted
block has been observed, so server acceptance of this replay remains unverified.

### Resource bounds and cache limits

Stable root IDs help preserve an unchanged history prefix. They do not prove
provider prompt-cache hits. Full replay does not prove uncached billing, and a
retained Run does not prove cached billing. SDK usage visibility is an advantage,
not evidence of intrinsically cheaper inference.

Defaults are four live Runs, five-minute parked leases, 128 MiB of blobs and
continuation history per Run, 8 MiB frames and host-output buffers, 1,024 calls
per Run, and 16 delivery correlations per call. Capacity pressure can discard a
parked lease. Blob capacity failure rejects the Run instead of evicting a
referenced root or image. Premature EOF and transport failures remain errors.

The V2 post-output watchdog defaults to 180 seconds. Existing
`OPENCODE_CURSOR_STALL_TIMEOUT_MS` overrides, including disabled timers, remain
effective. This integrates the separate watchdog mitigation into the replacement;
it does not demonstrate that the original workload finishes within that budget.

## Verification and release gates

```bash
npm run verify
```

The required gate includes `test:v2-host` after the build. It starts an isolated
pinned OpenCode server with synthetic authentication and a loopback Cursor
backend. It proves:

- exact selected model parameters reach the backend;
- dependent tools overlap even when the second call arrives after one second;
- configured permission denial, rejected permission prompts, question dismissal,
  invalid tool input, and cancellation during permission waits are preserved;
- interrupting a running shell preserves its partial side effect and records a
  failed tool, without forwarding an invented result;
- steering admitted during real tool execution reaches a fresh Run before any
  result is forwarded to the old Run;
- losing the connection requires fresh, structured reconstruction;
- the fake backend fetches and checks actual root blobs containing the real
  outcomes and subsequent steering;
- current, historical, and tool-produced images retain their bytes and placement;
- forks reconstruct the parent's history without mutating it, including signed
  and opaque reasoning after restarting the host process;
- manual compaction and automatic compaction triggered by synthetic reported
  usage preserve the host's summary and retained context;
- terminal usage persists with cache counts and reasoning counted correctly;
- a 452k-context retained Run with 1.36M aggregate input does not force compaction
  in a 1M model after the usage correction, while genuine automatic compaction
  still passes;
- successful completion includes the final Connect status.

Adapter regressions cover late calls, retransmissions, account changes,
cancellation, observer failure, bounded handoff, scoped cleanup, premature EOF,
trailing Connect errors, final checkpoint/blob work, compressed frames, empty
tool restrictions, and nonduplicated usage accounting. Image tests check
placement and serialization, not model image interpretation. The root
image representation follows the recorded
[community implementation](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/packages/ai/src/providers/cursor.ts#L4708-L4725);
the later live image cases also verified model interpretation.

`test:v2-probe` runs the opt-in runner against a loopback backend, with synthetic
credentials and a real pinned host. It checks diagnostic capture, failure exports,
and sustained history growth through automatic compaction and a genuine subsequent
tool result. The final tool verifies the original nonce from the retained summary.
These deterministic checks validate the runner, not live model quality.

### Integrated live canary, September 10, 2026

An isolated `0.0.0-beta-18050` host used the built replacement with the exact
account-discovered `composer-2.5` selection, `fast=false`, and max mode off.
A loopback relay limited the test to one upstream Run, two distinct host tool
calls, bounded input/output, and a 60-second deadline. It did not execute tools
or synthesize responses. The two tools ran inside OpenCode, and the second
verified a fresh nonce returned by the first.

The host persisted both successful tools and a successful final response.
Cursor sent `turnEnded` and a successful Connect end status. The complete
fixture, including startup and cleanup, took 18.2 seconds.

Reported terminal usage was 10,203 total input tokens, 4,393 cache-read
tokens, zero cache-write tokens, 191 output tokens, and zero reasoning tokens.
Uncached input was therefore 5,810 tokens. The initial interpretation of 10,203
as uncached input was corrected during the later billing comparison.
Checkpoint occupancy was 3,535 tokens; progress deltas totaled 144 tokens.
These different values confirm why the adapter keeps the three measurements
separate. The sample demonstrates reported cache reads, but does not compare
fresh replay with retained Runs.

At [published Composer rates](https://cursor.com/docs/models-and-pricing), the
reported counts imply $0.0042611 in list-price usage. This is not a verified
settled charge or a claim about included allowance consumption. No billing
ledger was read for this earlier Composer canary.

The test used synthetic content only. No private workload or existing session
was replayed. Subsequent cases are recorded in the release acceptance report.

The later V2-only pass validated live image interpretation on Auto, Composer,
and Opus, but Composer failed instruction precedence and the sustained probe
failed admission before its final continuation. The aggregate/per-invocation
usage mismatch was subsequently reproduced and corrected offline in the plugin.
No OpenCode repository change was needed. See the
[current acceptance report](opencode-v2-release-acceptance.md). Live acceptance of
opaque reasoning and long-session continuation remains open. Tests exercised one
authorized OAuth account. The original private workload was not replayed.
Reliable savings from
reusing large prefixes across Runs need further
investigation; the repeated long case did not demonstrate them. Live tests
require an explicit Run and spending allowance.
AgentService has no verified per-request output-token or dollar cap; catalog
fallback limits are not server-enforced spending controls.

### Host instructions

Host system messages remain in history roots and are also projected, in order,
as always-apply `RequestContext.rules`. Their synthetic paths identify entries;
they do not grant filesystem access. The same context is returned to Cursor's
context requests. User messages and tool results never become rules.

An additional global host-contract rule identifies the host instructions, asks
the model to honor them over conflicting user/tool text, and requires genuine
host-tool outcomes rather than printed simulations. It uses the same supported
rule schema and does not alter user messages. This best-effort reinforcement is
verified on the wire, but its effect on live precedence has not been measured.

The SDK defines the rule fields and source enum; the inspected
[community implementation](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/packages/ai/src/providers/cursor.ts#L4600-L4619)
identifies this additional projection as necessary for Cursor's prompt
reconstruction. Live tests still failed the host-instruction precedence check,
so this change does not establish exclusive system authority. Full prompt
replacement remains disabled in production.
