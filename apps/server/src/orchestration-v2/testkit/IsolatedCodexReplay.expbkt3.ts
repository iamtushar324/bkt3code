import type * as CodexReplay from "effect-codex-app-server/replay";

type Entry = CodexReplay.CodexAppServerReplayEntry;
type Transcript = CodexReplay.CodexAppServerReplayTranscript;

const sharedProcessRecordings = new Set([
  "thread_fork_native",
  "thread_fork_native_prior_turn",
  "thread_merge_back_continue",
  "thread_merge_back_siblings",
  "delegated_task_status",
]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

interface RuntimeRecording {
  readonly nativeThreadId: string;
  readonly entries: Array<Entry>;
  readonly requestIds: Map<unknown, number>;
  nextRequestId: number;
}

function createdNativeThreadId(
  entries: ReadonlyArray<Entry>,
  requestId: unknown,
): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "emit_inbound") continue;
    const frame = record(entry.frame);
    if (frame === undefined || frame.id !== requestId) continue;
    const nativeId = record(record(frame.result)?.thread)?.id;
    if (typeof nativeId === "string") return nativeId;
  }
  return undefined;
}

/** Preserve every recorded operation while giving each app thread its own process and RPC namespace. */
export function isolatedCodexReplayTranscripts(
  transcript: Transcript,
): ReadonlyArray<Transcript> | undefined {
  if (!sharedProcessRecordings.has(transcript.scenario)) return undefined;
  const firstCreation = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && record(entry.frame)?.method === "thread/start",
  );
  if (firstCreation < 0) return undefined;
  // The handshake ends at the first request: the config read before thread/start.
  const firstRequest = transcript.entries.findIndex((entry) => {
    const method = entry.type === "expect_outbound" ? record(entry.frame)?.method : undefined;
    return method !== undefined && method !== "initialize" && method !== "initialized";
  });
  const handshake = transcript.entries.slice(0, firstRequest);
  const initialization = handshake.find(
    (entry) => entry.type === "expect_outbound" && record(entry.frame)?.method === "initialize",
  );
  const initializationId =
    initialization?.type === "expect_outbound" ? record(initialization.frame)?.id : undefined;
  const runtimes = new Map<string, RuntimeRecording>();
  const requestOwners = new Map<unknown, RuntimeRecording>();
  let current: RuntimeRecording | undefined;
  // A config read names no thread; it belongs to the runtime of the next request that does.
  let pending: Array<Entry> = [];
  const pendingRequestIds = new Set<unknown>();
  const append = (runtime: RuntimeRecording, entry: Entry) => {
    const frame = entry.type === "runtime_exit" ? undefined : record(entry.frame);
    if (entry.type === "expect_outbound" && frame?.method !== undefined && frame.id !== undefined) {
      const localId = runtime.nextRequestId++;
      runtime.requestIds.set(frame.id, localId);
      requestOwners.set(frame.id, runtime);
      runtime.entries.push({ ...entry, frame: { ...frame, id: localId } });
    } else if (
      entry.type === "emit_inbound" &&
      frame?.id !== undefined &&
      frame.method === undefined
    ) {
      runtime.entries.push({
        ...entry,
        frame: { ...frame, id: runtime.requestIds.get(frame.id) ?? frame.id },
      });
    } else runtime.entries.push(entry);
  };
  const flushPending = (runtime: RuntimeRecording) => {
    for (const entry of pending) append(runtime, entry);
    pending = [];
    pendingRequestIds.clear();
  };
  for (let index = firstRequest; index < transcript.entries.length; index += 1) {
    const entry = transcript.entries[index]!;
    if (entry.type === "runtime_exit") {
      // The recording's one shared process exits after all threads finish.
      // Independent processes stay alive until the enclosing replay scope closes.
      continue;
    }
    const frame = record(entry.frame);
    if (frame === undefined) continue;
    if (entry.type === "expect_outbound") {
      const nativeThreadId = record(frame.params)?.threadId;
      if (frame.method === "thread/start" || frame.method === "thread/fork") {
        const createdThreadId = createdNativeThreadId(
          transcript.entries.slice(index + 1),
          frame.id,
        );
        if (createdThreadId === undefined)
          throw new Error(`Missing native thread response in ${transcript.scenario}.`);
        current = {
          nativeThreadId: createdThreadId,
          entries: [...handshake],
          requestIds: new Map([[initializationId, 1]]),
          nextRequestId: 2,
        };
        runtimes.set(createdThreadId, current);
      } else if (frame.method === "config/read" && typeof nativeThreadId !== "string") {
        pending.push(entry);
        if (frame.id !== undefined) pendingRequestIds.add(frame.id);
        continue;
      } else if (typeof nativeThreadId === "string") {
        current = runtimes.get(nativeThreadId) ?? current;
      }
      if (current === undefined)
        throw new Error(`Missing runtime owner in ${transcript.scenario}.`);
      flushPending(current);
      append(current, entry);
      continue;
    }
    if (frame.id !== undefined && frame.method === undefined && pendingRequestIds.has(frame.id)) {
      pending.push(entry);
      continue;
    }
    const nativeThreadId =
      record(frame.params)?.threadId ?? record(record(frame.params)?.thread)?.id;
    const owner =
      frame.id === undefined
        ? typeof nativeThreadId === "string"
          ? (runtimes.get(nativeThreadId) ?? current)
          : current
        : (requestOwners.get(frame.id) ?? current);
    if (owner === undefined)
      throw new Error(`Missing inbound runtime owner in ${transcript.scenario}.`);
    append(owner, entry);
  }
  if (current !== undefined) flushPending(current);
  return [...runtimes.values()].map((runtime) => ({ ...transcript, entries: runtime.entries }));
}
