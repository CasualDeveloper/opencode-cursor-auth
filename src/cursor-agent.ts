import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as p from "./proto/agent_pb.js";
import { CURSOR_API_URL } from "./cursor-rpc.js";
import { resolveNodeExecutable } from "./node-runtime.js";
import type { CursorModelSelection } from "./model-selection.js";
import type { CursorToolDefinition } from "./tools.js";
import {
  appendEntry,
  stableJson,
  type HistoryEntry,
  type HostToolResult,
  record,
  opaqueAnchorDigest,
  captureOpaqueReasoning,
  applyOpaqueReasoning,
} from "./opencode/history.js";
import {
  reasoningDigest,
  type ReasoningSignature,
  opaqueReasoning,
  type OpaqueReasoning,
} from "./opencode/reasoning.js";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { buildAgentRequest, decodeArgs } from "./cursor-agent-protocol.js";
import { startAgentTransport } from "./cursor-agent-transport.js";
import type { HostToolObserver } from "./opencode/tool-observer.js";
import { readTurnUsage, type CursorTokenUsage } from "./cursor-agent-usage.js";

export type CursorRunEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; id: string }
  | { type: "reasoning-metadata"; signatures: ReasoningSignature[] }
  | { type: "opaque-reasoning"; annotations: OpaqueReasoning[] }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish";
      reason: "stop" | "tool-calls";
      outputTokenDelta?: number;
      /** Reported usage attributable to this single host invocation, if known. */
      usage?: CursorTokenUsage;
      /** Complete terminal counters for the disposable Cursor Run. */
      turnUsage?: CursorTokenUsage;
      contextTokens?: number;
    };

export interface CursorRunInput {
  accessToken: string;
  selection: CursorModelSelection;
  history: HistoryEntry[];
  results: HostToolResult[];
  tools: CursorToolDefinition[];
  scope: string;
  abortSignal?: AbortSignal;
  apiUrl?: string;
  host?: { sessionID: string; observer: HostToolObserver };
}

interface PendingCall {
  upstreamID: string;
  id: string;
  name: string;
  input: string;
  replies: { id: number; execId: string }[];
  status: "queued" | "delivered" | "forwarded";
  result?: HostToolResult;
}

const runs = new Map<string, AgentRun>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const setting = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function nativeOutputStallTimeoutMs(): number {
  return Number(process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS ?? 180_000);
}

/** Validate the required runtime; workers start lazily and own exactly one Run. */
export function startCursorTransport(): void {
  resolveNodeExecutable();
}
export function stopCursorTransport(scope?: string): void {
  for (const run of runs.values())
    if (
      scope === undefined ||
      run.scope === scope ||
      run.scope.startsWith(`${scope}:`)
    )
      run.dispose();
}
export function nativeCursorTransportStats() {
  return {
    contexts: runs.size,
    parked: [...runs.values()].filter((run) => run.parked).length,
    pendingToolCalls: [...runs.values()].reduce(
      (n, run) => n + run.pendingCount,
      0,
    ),
  };
}

export function runCursorAgent(
  input: CursorRunInput,
): ReadableStream<CursorRunEvent> {
  input.abortSignal?.throwIfAborted();
  // Resolve credentials before this call. Hashes are memory-only, never logged.
  const identity = hash(
    stableJson({
      credential: input.accessToken,
      endpoint: input.apiUrl ?? CURSOR_API_URL,
      selection: input.selection,
      tools: input.tools,
    }),
  );
  const candidates = [...runs.values()].filter(
    (run) => run.scope === input.scope && run.parked,
  );
  const existing = candidates.find((run) => run.canResume(identity, input));
  if (existing) return existing.resume(input);
  for (const run of candidates) run.dispose();
  const capacity = Math.max(
    1,
    Math.floor(setting("OPENCODE_CURSOR_MAX_ACTIVE_RUNS", 4)),
  );
  if (runs.size >= capacity) {
    const idle = [...runs.values()].find((run) => run.parked);
    idle?.dispose();
  }
  if (runs.size >= capacity)
    throw new Error(
      `Cursor AgentService capacity reached (${capacity} active Runs)`,
    );
  const run = new AgentRun(identity, input);
  runs.set(run.id, run);
  return run.open(input.abortSignal);
}

class AgentRun {
  readonly id = randomUUID();
  readonly calls = new Map<string, PendingCall>();
  private readonly payload;
  private readonly nonce = randomUUID();
  private readonly transport;
  private expected: HistoryEntry[];
  private historyBytes: number;
  private controller?: ReadableStreamDefaultController<CursorRunEvent>;
  private queued: Exclude<CursorRunEvent, { type: "finish" }>[] = [];
  private queuedBytes = 0;
  private status: "active" | "parked" | "closed" = "active";
  private turnEnded = false;
  private outputTokens?: number;
  private usage?: CursorTokenUsage;
  private contextTokens?: number;
  private outputStarted = false;
  private resumed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stall?: ReturnType<typeof setTimeout>;
  private delivery?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private handoff?: ReturnType<typeof setTimeout>;
  private readonly watching = new Map<string, () => void>();
  private releaseSession?: () => void;
  private reasoningID?: string;
  private readonly reasoningBlocks = new Map<string, JsonObject>();
  private readonly signedRoots = new Map<
    string,
    { text: string; signature: string; modelName: string }[]
  >();
  private readonly checkpointRoots = new Set<string>();
  private readonly redactedRoots = new Map<string, JsonValue[]>();
  private readonly outputEntries = new Set<number>();
  private signal?: AbortSignal;
  private readonly abort = () =>
    this.dispose(
      this.signal?.reason ?? new DOMException("Aborted", "AbortError"),
    );

  constructor(
    private readonly identity: string,
    private readonly input: CursorRunInput,
  ) {
    this.expected = structuredClone(input.history);
    this.historyBytes = Buffer.byteLength(stableJson(input.history));
    this.payload = buildAgentRequest(
      input.selection,
      input.history,
      input.tools,
    );
    this.transport = startAgentTransport({
      accessToken: input.accessToken,
      url: input.apiUrl ?? CURSOR_API_URL,
      tools: input.tools.length > 0,
      onMessage: (bytes) => {
        try {
          this.receive(fromBinary(p.AgentServerMessageSchema, bytes));
        } catch (error) {
          this.dispose(
            error instanceof Error
              ? error
              : new Error("Invalid Cursor protocol message"),
          );
        }
      },
      onEnd: (error) => {
        if (this.status === "closed") return;
        if (error || !this.turnEnded)
          return this.dispose(
            error ?? new Error("Cursor Run ended without turnEnded"),
          );
        try {
          this.preserveOpaqueReasoning();
          this.finish("stop");
          this.dispose();
        } catch (error) {
          this.dispose(error);
        }
      },
    });
  }

  get parked() {
    return this.status === "parked";
  }
  get scope() {
    return this.input.scope;
  }
  get pendingCount() {
    return [...this.calls.values()].filter(
      (call) => call.status !== "forwarded",
    ).length;
  }

  open(signal?: AbortSignal): ReadableStream<CursorRunEvent> {
    const stream = this.attach(signal);
    if (this.status === "closed") return stream;
    try {
      this.releaseSession = this.input.host?.observer.watchSession(
        this.input.host.sessionID,
        () => {
          if (this.pendingCount) this.dispose();
        },
        (error) => this.dispose(error),
      );
      this.send(this.payload.message.message);
      this.heartbeat = setInterval(() => {
        try {
          this.send({
            case: "clientHeartbeat",
            value: create(p.ClientHeartbeatSchema),
          });
        } catch (error) {
          this.dispose(error);
        }
      }, 5_000);
    } catch (error) {
      this.dispose(error);
    }
    return stream;
  }

  canResume(identity: string, input: CursorRunInput): boolean {
    if (!this.parked || identity !== this.identity) return false;
    const expectedCalls = [...this.calls.values()].filter(
      (call) => call.status === "delivered",
    );
    const last = input.history.at(-1);
    if (!expectedCalls.length || last?.role !== "tool") return false;
    const prefix = input.history.slice(0, -1);
    if (stableJson(prefix) !== stableJson(this.expected)) return false;
    const ids = new Set(
      last.content.map((part) =>
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? part.toolCallId
          : undefined,
      ),
    );
    return (
      ids.size === last.content.length &&
      ids.size === expectedCalls.length &&
      expectedCalls.every(
        (call) =>
          ids.has(call.id) &&
          input.results.some(
            (result) => result.id === call.id && result.name === call.name,
          ),
      )
    );
  }

  resume(input: CursorRunInput): ReadableStream<CursorRunEvent> {
    this.expected = structuredClone(input.history);
    for (const entry of this.expected)
      if (entry.role !== "system")
        for (const part of entry.content) {
          const block = record(part);
          if (
            typeof block?.cursorReasoningID === "string" &&
            this.reasoningBlocks.has(block.cursorReasoningID)
          )
            this.reasoningBlocks.set(
              block.cursorReasoningID,
              part as JsonObject,
            );
        }
    this.historyBytes = Buffer.byteLength(stableJson(input.history));
    this.resumed = true;
    const delivered = [...this.calls.values()].filter(
      (call) => call.status === "delivered",
    );
    const stream = this.attach(input.abortSignal);
    if (this.status === "closed") return stream;
    try {
      // The authoritative host checkpoint has happened. Only previously delivered
      // calls require results; queued late calls have never been shown to the host.
      for (const call of delivered) {
        call.result = input.results.find((result) => result.id === call.id)!;
        call.status = "forwarded";
        for (const reply of call.replies) this.replyResult(reply, call.result);
      }
      const queued = this.queued;
      this.queued = [];
      this.queuedBytes = 0;
      for (const event of queued) this.emit(event);
    } catch (error) {
      this.dispose(error);
    }
    return stream;
  }

  private attach(signal?: AbortSignal): ReadableStream<CursorRunEvent> {
    clearTimeout(this.expiry);
    this.signal?.removeEventListener("abort", this.abort);
    this.signal = signal;
    this.status = "active";
    this.outputStarted = false;
    return new ReadableStream<CursorRunEvent>(
      {
        start: (controller) => {
          this.controller = controller;
          if (signal?.aborted) return this.abort();
          signal?.addEventListener("abort", this.abort, { once: true });
          this.progress();
        },
        cancel: () => this.dispose(),
      },
      {
        highWaterMark: 8 * 1024 * 1024,
        size: (event) => Buffer.byteLength(stableJson(event)),
      },
    );
  }

  private emit(event: Exclude<CursorRunEvent, { type: "finish" }>) {
    if (this.status === "closed") return;
    if (this.parked) {
      this.queuedBytes += Buffer.byteLength(stableJson(event));
      if (this.queuedBytes > 8 * 1024 * 1024 || this.queued.length >= 4096)
        throw new Error("Cursor pending output capacity exceeded");
      this.queued.push(event);
      return;
    }
    if ((this.controller?.desiredSize ?? 0) <= 0)
      throw new Error("Cursor host stream capacity exceeded");
    this.historyBytes += Buffer.byteLength(stableJson(event));
    if (this.historyBytes > 128 * 1024 * 1024)
      throw new Error("Cursor continuation history capacity exceeded");
    if (event.type === "tool-call") {
      const call = [...this.calls.values()].find(
        (item) => item.id === event.toolCallId,
      )!;
      call.status = "delivered";
      appendEntry(this.expected, {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            args: JSON.parse(call.input),
          },
        ],
      });
      const host = this.input.host;
      if (host) {
        clearTimeout(this.delivery);
        this.delivery = undefined;
        this.watching.set(
          call.id,
          host.observer.watch(
            host.sessionID,
            call.id,
            () => {
              this.watching.delete(call.id);
              if (!this.watching.size) this.scheduleDelivery();
            },
            (error) => this.dispose(error),
          ),
        );
        // A finite retention bound, never an assertion of upstream batch completion.
        this.handoff ??= setTimeout(
          () => this.finish("tool-calls"),
          setting("OPENCODE_CURSOR_NATIVE_TOOL_WAIT_MS", 300_000),
        );
      } else this.scheduleDelivery();
    } else if (event.type === "opaque-reasoning") {
      applyOpaqueReasoning(this.expected, event.annotations);
    } else if (event.type === "reasoning-metadata") {
      for (const signature of event.signatures) {
        const block = this.reasoningBlocks.get(signature.id);
        if (!block || reasoningDigest(String(block.text)) !== signature.digest)
          throw new Error("Cursor reasoning signature correlation failed");
        block.signature = signature.signature;
        block.providerOptions = { cursor: { modelName: signature.modelName } };
      }
    } else if (event.type === "reasoning") {
      const block = this.reasoningBlocks.get(event.id);
      if (block) block.text = String(block.text) + event.text;
      else {
        const content = {
          type: "reasoning",
          text: event.text,
          cursorReasoningID: event.id,
        };
        this.reasoningBlocks.set(event.id, content);
        appendEntry(this.expected, { role: "assistant", content: [content] });
      }
    } else
      appendEntry(this.expected, {
        role: "assistant",
        content: [
          {
            type: "text",
            text: event.text,
          },
        ],
      });
    if (
      event.type === "text" ||
      event.type === "reasoning" ||
      event.type === "tool-call"
    )
      this.outputEntries.add(this.expected.length - 1);
    this.outputStarted = true;
    this.progress();
    this.controller?.enqueue(event);
  }

  private progress() {
    if (this.turnEnded) return;
    clearTimeout(this.stall);
    if (this.status !== "active" || this.watching.size) return;
    const timeout = this.outputStarted
      ? nativeOutputStallTimeoutMs()
      : this.resumed
        ? Number(
            process.env.OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS ??
              90_000,
          )
        : Number(
            process.env.OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS ?? 180_000,
          );
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    this.stall = setTimeout(
      () =>
        this.dispose(
          new Error(
            `Cursor AgentService Run stalled for ${timeout}ms without model progress`,
          ),
        ),
      timeout,
    );
  }

  private scheduleDelivery() {
    if (this.status !== "active") return;
    this.delivery ??= setTimeout(
      () => this.finish("tool-calls"),
      setting("OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS", 1_000),
    );
  }

  private releaseWatches() {
    clearTimeout(this.handoff);
    this.handoff = undefined;
    for (const release of this.watching.values()) release();
    this.watching.clear();
  }

  private finish(reason: "tool-calls" | "stop") {
    if (this.status !== "active") return;
    this.releaseWatches();
    clearTimeout(this.delivery);
    this.delivery = undefined;
    clearTimeout(this.stall);
    this.controller?.enqueue({
      type: "finish",
      reason,
      outputTokenDelta: this.outputTokens,
      // After a handoff, terminal counters span several host invocations.
      // Per-invocation counts are unknown; do not allocate or invent them.
      usage: this.resumed ? undefined : this.usage,
      turnUsage: this.usage,
      contextTokens: this.contextTokens,
    });
    this.outputTokens = undefined;
    this.controller?.close();
    this.controller = undefined;
    this.status = "parked";
    if (reason === "tool-calls")
      this.expiry = setTimeout(
        () => this.dispose(),
        setting("OPENCODE_CURSOR_NATIVE_PARK_TTL_MS", 300_000),
      );
  }

  dispose(error?: unknown) {
    if (this.status === "closed") return;
    this.status = "closed";
    this.releaseWatches();
    this.releaseSession?.();
    clearInterval(this.heartbeat);
    clearTimeout(this.stall);
    clearTimeout(this.delivery);
    clearTimeout(this.expiry);
    this.signal?.removeEventListener("abort", this.abort);
    if (!this.turnEnded) {
      try {
        this.send({
          case: "conversationAction",
          value: create(p.ConversationActionSchema, {
            action: {
              case: "cancelAction",
              value: create(p.CancelActionSchema),
            },
          }),
        });
      } catch {
        /* Best effort; termination is bounded by the worker lifetime. */
      }
    }
    this.transport.cancel();
    this.controller?.error(
      error ?? new DOMException("Cursor Run disposed", "AbortError"),
    );
    this.controller = undefined;
    this.queued = [];
    runs.delete(this.id);
  }

  private send(message: p.AgentClientMessage["message"]) {
    this.transport.send(
      toBinary(
        p.AgentClientMessageSchema,
        create(p.AgentClientMessageSchema, { message }),
      ),
    );
  }

  private replyResult(
    reply: { id: number; execId: string },
    result: HostToolResult,
  ) {
    this.send({
      case: "execClientMessage",
      value: create(p.ExecClientMessageSchema, {
        ...reply,
        message: {
          case: "mcpResult",
          value: create(p.McpResultSchema, {
            result: {
              case: "success",
              value: create(p.McpSuccessSchema, {
                isError: result.isError,
                content: [
                  create(p.McpToolResultContentItemSchema, {
                    content: {
                      case: "text",
                      value: create(p.McpTextContentSchema, {
                        text: result.text,
                      }),
                    },
                  }),
                ],
              }),
            },
          }),
        },
      }),
    });
  }

  private receive(message: p.AgentServerMessage) {
    if (this.status === "closed") return;
    const item = message.message;
    if (item.case === "interactionUpdate") {
      const update = item.value.message;
      // SDK 1.0.31: field 21 is a feedback-form notification; 25 is an
      // optional timestamp. Neither is model output or an execution request.
      // The base AgentService descriptor retains these as unknown fields.
      if (
        update.case === undefined &&
        item.value.$unknown?.some((field) => field.no === 21) &&
        item.value.$unknown.every((field) => field.no === 21 || field.no === 25)
      )
        return;
      if (this.turnEnded && update.case !== "heartbeat")
        throw new Error("Cursor sent output after turnEnded");
      if (update.case === "textDelta" || update.case === "thinkingDelta") {
        if (update.value.text)
          this.emit(
            update.case === "textDelta"
              ? { type: "text", text: update.value.text }
              : {
                  type: "reasoning",
                  text: update.value.text,
                  id: (this.reasoningID ??= randomUUID()),
                },
          );
      } else if (update.case === "thinkingCompleted") {
        this.reasoningID = undefined;
      } else if (update.case === "tokenDelta") {
        if (update.value.tokens < 0)
          throw new Error("Cursor reported a negative output token delta");
        this.outputTokens = (this.outputTokens ?? 0) + update.value.tokens;
        if (update.value.tokens > 0) {
          this.outputStarted = true;
          this.progress();
        }
      } else if (update.case === "turnEnded") {
        if (this.pendingCount)
          throw new Error("Cursor ended its turn with unresolved host tools");
        this.turnEnded = true;
        this.usage = readTurnUsage(update.value);
        clearInterval(this.heartbeat);
        clearTimeout(this.stall);
        this.stall = setTimeout(
          () =>
            this.dispose(
              new Error("Cursor transport did not finish after turnEnded"),
            ),
          5_000,
        );
        // Keep the request writable for final blob operations/checkpoints. The
        // server's validated Connect end status, not turnEnded, closes the Run.
      }
      return;
    }
    if (item.case === "conversationCheckpointUpdate") {
      // Context occupancy is not inference input or billed usage.
      this.contextTokens = item.value.tokenDetails?.usedTokens;
      this.checkpointRoots.clear();
      for (const id of item.value.rootPromptMessagesJson) {
        const key = Buffer.from(id).toString("hex");
        if (this.checkpointRoots.size >= 8192 && !this.checkpointRoots.has(key))
          throw new Error("Cursor checkpoint root capacity exceeded");
        this.checkpointRoots.add(key);
        const signed = this.signedRoots.get(key);
        if (!signed) continue;
        const signatures: ReasoningSignature[] = [];
        for (const part of signed) {
          const blocks = [...this.reasoningBlocks].filter(
            ([, block]) =>
              block.text === part.text && block.signature === undefined,
          );
          if (blocks.length !== 1) continue;
          signatures.push({
            id: blocks[0]![0],
            digest: reasoningDigest(part.text),
            signature: part.signature,
            modelName: part.modelName,
          });
        }
        this.signedRoots.delete(key);
        if (signatures.length)
          this.emit({ type: "reasoning-metadata", signatures });
      }
      return;
    }
    if (item.case === "kvServerMessage") {
      const action = item.value.message;
      let result: p.KvClientMessage["message"];
      if (action.case === "getBlobArgs")
        result = {
          case: "getBlobResult",
          value: create(p.GetBlobResultSchema, {
            blobData: this.payload.blobs.get(action.value.blobId),
          }),
        };
      else if (action.case === "setBlobArgs") {
        this.payload.blobs.set(action.value.blobId, action.value.blobData);
        // Only assistant roots later referenced by a checkpoint can enrich
        // reasoning. Arbitrary tool/file blobs are never promoted to history.
        let json: unknown;
        try {
          json = JSON.parse(Buffer.from(action.value.blobData).toString());
        } catch {
          /* Other blobs are protobuf or binary. */
        }
        const root = record(json);
        const key = Buffer.from(action.value.blobId).toString("hex");
        this.redactedRoots.delete(key);
        if (root?.role === "assistant" && Array.isArray(root.content)) {
          if (
            root.content.some(
              (part: unknown) => record(part)?.type === "redacted-reasoning",
            )
          ) {
            this.redactedRoots.set(key, root.content as JsonValue[]);
          }
          const signed = root.content.flatMap((item: unknown) => {
            const part = record(item);
            const modelName = record(
              record(part?.providerOptions)?.cursor,
            )?.modelName;
            return part?.type === "reasoning" &&
              typeof part.text === "string" &&
              typeof part.signature === "string" &&
              part.signature.length > 0 &&
              part.signature.length <= 65536 &&
              modelName === this.input.selection.publicId
              ? [{ text: part.text, signature: part.signature, modelName }]
              : [];
          });
          if (signed.length)
            this.signedRoots.set(
              Buffer.from(action.value.blobId).toString("hex"),
              signed,
            );
        }
        result = {
          case: "setBlobResult",
          value: create(p.SetBlobResultSchema),
        };
      } else throw new Error("Unsupported Cursor blob operation");
      this.send({
        case: "kvClientMessage",
        value: create(p.KvClientMessageSchema, {
          id: item.value.id,
          message: result,
        }),
      });
      return;
    }
    if (this.turnEnded) throw new Error("Cursor sent work after turnEnded");
    if (item.case === "execServerMessage") {
      const exec = item.value;
      const action = exec.message;
      if (action.case === "requestContextArgs") {
        this.send({
          case: "execClientMessage",
          value: create(p.ExecClientMessageSchema, {
            id: exec.id,
            execId: exec.execId,
            message: {
              case: "requestContextResult",
              value: create(p.RequestContextResultSchema, {
                result: {
                  case: "success",
                  value: create(p.RequestContextSuccessSchema, {
                    requestContext: this.payload.context,
                  }),
                },
              }),
            },
          }),
        });
        return;
      }
      if (action.case !== "mcpArgs")
        throw new Error(
          `Cursor requested unsupported execution: ${action.case ?? "unknown"}`,
        );
      const args = action.value;
      const name = args.toolName || args.name;
      if (!this.input.tools.some((tool) => tool.function.name === name))
        throw new Error("Cursor requested an unadvertised MCP tool");
      if (!args.toolCallId) throw new Error("Cursor omitted the tool call ID");
      const input = decodeArgs(args.args);
      const reply = { id: exec.id, execId: exec.execId };
      const existing = this.calls.get(args.toolCallId);
      if (existing) {
        if (existing.name !== name || existing.input !== input)
          throw new Error("Conflicting Cursor tool call retransmission");
        if (
          existing.replies.some(
            (item) => item.id === reply.id && item.execId === reply.execId,
          )
        ) {
          if (existing.result) this.replyResult(reply, existing.result);
          return;
        }
        if (existing.replies.length >= 16)
          throw new Error("Cursor tool retransmission capacity exceeded");
        existing.replies.push(reply);
        if (existing.result) this.replyResult(reply, existing.result);
        return;
      }
      if (this.calls.size >= 1024)
        throw new Error("Cursor Run tool capacity exceeded");
      const call: PendingCall = {
        upstreamID: args.toolCallId,
        id: `cursor_${hash(`${this.nonce}:${args.toolCallId}`).slice(0, 32)}`,
        name,
        input,
        replies: [reply],
        status: "queued",
      };
      this.calls.set(args.toolCallId, call);
      this.emit({
        type: "tool-call",
        toolCallId: call.id,
        toolName: name,
        input,
      });
      return;
    }
    if (item.case === "interactionQuery" || item.case === undefined)
      throw new Error("Unsupported Cursor interaction");
  }

  private preserveOpaqueReasoning() {
    const annotations: OpaqueReasoning[] = [];
    for (const key of this.checkpointRoots) {
      try {
        const root = this.redactedRoots.get(key);
        if (!root) continue;
        const incompatible = root.some((value) => {
          const modelName = record(
            record(record(value)?.providerOptions)?.cursor,
          )?.modelName;
          return (
            modelName !== undefined &&
            modelName !== this.input.selection.publicId
          );
        });
        if (incompatible) continue;
        const content = root.map((value): JsonValue => {
          const part = record(value);
          if (part?.type !== "tool-call" || typeof part.toolCallId !== "string")
            return value;
          const call = this.calls.get(part.toolCallId);
          return call
            ? { ...(value as JsonObject), toolCallId: call.id }
            : value;
        });
        const annotation = captureOpaqueReasoning(
          content,
          this.input.selection.publicId,
        );
        const alreadyStored = this.input.history.some(
          (entry) =>
            entry.role === "assistant" &&
            entry.content.some(
              (part) => record(part)?.type === "redacted-reasoning",
            ) &&
            stableJson(
              captureOpaqueReasoning(
                entry.content,
                this.input.selection.publicId,
              ),
            ) === stableJson(annotation),
        );
        if (alreadyStored) continue;
        const matches = [...this.outputEntries].filter((index) => {
          const entry = this.expected[index];
          return (
            entry?.role === "assistant" &&
            opaqueAnchorDigest(entry.content) === annotation.digest
          );
        });
        // Unmatched extra checkpoint roots are common for Grok. Omit them
        // instead of failing an already-streamed answer.
        if (matches.length !== 1) continue;
        annotations.push(annotation);
      } catch {
        continue;
      }
    }
    if (!annotations.length) return;
    try {
      this.emit({
        type: "opaque-reasoning",
        annotations: opaqueReasoning(annotations),
      });
    } catch {
      return;
    }
  }
}
