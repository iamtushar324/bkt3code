// T3-CUSTOM(expbkt3): fork runtime-instruction blocks in recorded upstream prompts.
import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

const UPSTREAM_RUNTIME_INSTRUCTIONS_END = "</pull_request_linking>";

/**
 * The fork appends blocks (such as `<linear_linking>`) after upstream's last
 * runtime-instruction block. Upstream Muse fixtures record that text verbatim
 * inside `turn/start`, so the recorded prompt must carry the same suffix the
 * running adapter sends. Derived from the live builder so a new fork block, or
 * none at all, needs no change here.
 */
function forkRuntimeInstructionsSuffix(): string {
  const current = buildRuntimeInstructions({ harness: "replay" });
  const end = current.indexOf(UPSTREAM_RUNTIME_INSTRUCTIONS_END);
  return end < 0 ? "" : current.slice(end + UPSTREAM_RUNTIME_INSTRUCTIONS_END.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withForkSuffix(part: unknown, suffix: string): unknown {
  if (
    !isRecord(part) ||
    part.type !== "text" ||
    typeof part.text !== "string" ||
    !part.text.startsWith("<runtime_info>") ||
    !part.text.endsWith(UPSTREAM_RUNTIME_INSTRUCTIONS_END)
  ) {
    return part;
  }
  return { ...part, text: `${part.text}${suffix}` };
}

export function materializeForkReplayRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  driver: ProviderDriverKind,
): ProviderReplayTranscript {
  if (driver !== "muse") return transcript;
  const suffix = forkRuntimeInstructionsSuffix();
  if (suffix === "") return transcript;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (
        !isRecord(frame) ||
        frame.method !== "turn/start" ||
        !isRecord(frame.params) ||
        !Array.isArray(frame.params.input)
      ) {
        return entry;
      }
      const input: ReadonlyArray<unknown> = frame.params.input;
      return {
        ...entry,
        frame: {
          ...frame,
          params: { ...frame.params, input: input.map((part) => withForkSuffix(part, suffix)) },
        },
      };
    }),
  };
}
