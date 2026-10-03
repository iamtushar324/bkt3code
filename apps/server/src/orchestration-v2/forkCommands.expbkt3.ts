// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const forkTypes = [
  "thread.member.add",
  "thread.member.remove",
  "thread.owner.transfer",
  "thread.source-control-profile.set",
] as const;
export type ForkThreadCommand = Extract<
  OrchestrationV2ServerCommand,
  { type: (typeof forkTypes)[number] }
>;
const types: ReadonlySet<string> = new Set(forkTypes);
export const isForkThreadCommand = (
  command: OrchestrationV2ServerCommand,
): command is ForkThreadCommand => types.has(command.type);

export class ForkThreadCommandError extends Schema.TaggedError<ForkThreadCommandError>()(
  "ForkThreadCommandError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** Fold fork metadata changes into a native V2 thread snapshot. */
export const planForkThreadCommand = Effect.fn("planForkThreadCommand")(function* (
  command: ForkThreadCommand,
  thread: OrchestrationV2AppThread,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const members = thread.memberUserIds ?? [];
  switch (command.type) {
    case "thread.member.add":
      if (members.includes(command.userId))
        return yield* new ForkThreadCommandError({
          detail: "The user is already a thread member.",
        });
      return { ...thread, memberUserIds: [...members, command.userId] };
    case "thread.member.remove":
      if (thread.ownerUserId === command.userId)
        return yield* new ForkThreadCommandError({
          detail: "Transfer ownership before you remove the owner.",
        });
      if (!members.includes(command.userId))
        return yield* new ForkThreadCommandError({ detail: "The user is not a thread member." });
      return { ...thread, memberUserIds: members.filter((userId) => userId !== command.userId) };
    case "thread.owner.transfer":
      if (thread.ownerUserId === command.userId)
        return yield* new ForkThreadCommandError({ detail: "The user already owns the thread." });
      return {
        ...thread,
        ownerUserId: command.userId,
        memberUserIds: [...new Set([...members, command.userId])],
      };
    case "thread.source-control-profile.set":
      if (
        runs.some((run) =>
          ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
        )
      )
        return yield* new ForkThreadCommandError({
          detail: "The thread is busy. Its source-control profile cannot change.",
        });
      return { ...thread, sourceControlProfileId: command.sourceControlProfileId };
  }
});
