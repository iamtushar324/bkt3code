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
  const handshake = transcript.entries.slice(0, firstCreation);
  const initialization = handshake.find(
    (entry) => entry.type === "expect_outbound" && record(entry.frame)?.method === "initialize",
  );
  const initializationId =
    initialization?.type === "expect_outbound" ? record(initialization.frame)?.id : undefined;
  const runtimes = new Map<string, RuntimeRecording>();
  const requestOwners = new Map<unknown, RuntimeRecording>();
  let current: RuntimeRecording | undefined;
  for (let index = firstCreation; index < transcript.entries.length; index += 1) {
    const entry = transcript.entries[index]!;
    if (entry.type === "runtime_exit") {
      // The recording's one shared process exits after all threads finish.
      // Independent processes stay alive until the enclosing replay scope closes.
      continue;
    }
    const frame = record(entry.frame);
    if (frame === undefined) continue;
    if (entry.type === "expect_outbound") {
      if (frame.method === "thread/start" || frame.method === "thread/fork") {
        const nativeThreadId = createdNativeThreadId(transcript.entries.slice(index + 1), frame.id);
        if (nativeThreadId === undefined)
          throw new Error(`Missing native thread response in ${transcript.scenario}.`);
        current = {
          nativeThreadId,
          entries: [...handshake],
          requestIds: new Map([[initializationId, 1]]),
          nextRequestId: 2,
        };
        runtimes.set(nativeThreadId, current);
      } else {
        const nativeThreadId = record(frame.params)?.threadId;
        if (typeof nativeThreadId === "string") current = runtimes.get(nativeThreadId) ?? current;
      }
      if (current === undefined)
        throw new Error(`Missing runtime owner in ${transcript.scenario}.`);
      if (frame.method !== undefined && frame.id !== undefined) {
        const localId = current.nextRequestId++;
        current.requestIds.set(frame.id, localId);
        requestOwners.set(frame.id, current);
        current.entries.push({ ...entry, frame: { ...frame, id: localId } });
      } else current.entries.push(entry);
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
    owner.entries.push(
      frame.id !== undefined && frame.method === undefined
        ? { ...entry, frame: { ...frame, id: owner.requestIds.get(frame.id) ?? frame.id } }
        : entry,
    );
  }
  return [...runtimes.values()].map((runtime) => ({ ...transcript, entries: runtime.entries }));
}
