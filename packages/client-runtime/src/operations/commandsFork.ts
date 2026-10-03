// T3-CUSTOM(expbkt3): native V2 membership commands and project mutation parity.
import {
  CommandId,
  type OrchestrationV2Command,
  type ProjectMutation,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";
import {
  commandIdInternal,
  dispatchCommandInternal,
  stopThreadSession,
  type StopThreadSessionInput,
} from "./commands.ts";

type ThreadInput<T extends OrchestrationV2Command["type"]> = Omit<
  Extract<OrchestrationV2Command, { readonly type: T }>,
  "type" | "commandId"
> & { readonly commandId?: CommandId };
type ProjectInput<T extends ProjectMutation["type"]> = Omit<
  Extract<ProjectMutation, { readonly type: T }>,
  "type" | "commandId"
> & { readonly commandId?: CommandId };
export type AddThreadMemberInput = ThreadInput<"thread.member.add">;
export type RemoveThreadMemberInput = ThreadInput<"thread.member.remove">;
export type TransferThreadOwnershipInput = ThreadInput<"thread.owner.transfer">;
export type AddProjectMemberInput = ProjectInput<"project.member.add">;
export type RemoveProjectMemberInput = ProjectInput<"project.member.remove">;
export type TransferProjectOwnershipInput = ProjectInput<"project.owner.transfer">;
export type RestartThreadSessionInput = StopThreadSessionInput;

export const addThreadMember = Effect.fn("ForkCommands.addThreadMember")(function* (
  input: AddThreadMemberInput,
) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "thread.member.add",
    commandId: yield* commandIdInternal(input),
  });
});
export const removeThreadMember = Effect.fn("ForkCommands.removeThreadMember")(function* (
  input: RemoveThreadMemberInput,
) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "thread.member.remove",
    commandId: yield* commandIdInternal(input),
  });
});
export const transferThreadOwnership = Effect.fn("ForkCommands.transferThreadOwnership")(function* (
  input: TransferThreadOwnershipInput,
) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "thread.owner.transfer",
    commandId: yield* commandIdInternal(input),
  });
});
export const addProjectMember = Effect.fn("ForkCommands.addProjectMember")(function* (
  input: AddProjectMemberInput,
) {
  return yield* request(WS_METHODS.projectsMutate, {
    ...input,
    type: "project.member.add",
    commandId: yield* commandIdInternal(input),
  });
});
export const removeProjectMember = Effect.fn("ForkCommands.removeProjectMember")(function* (
  input: RemoveProjectMemberInput,
) {
  return yield* request(WS_METHODS.projectsMutate, {
    ...input,
    type: "project.member.remove",
    commandId: yield* commandIdInternal(input),
  });
});
export const transferProjectOwnership = Effect.fn("ForkCommands.transferProjectOwnership")(
  function* (input: TransferProjectOwnershipInput) {
    return yield* request(WS_METHODS.projectsMutate, {
      ...input,
      type: "project.owner.transfer",
      commandId: yield* commandIdInternal(input),
    });
  },
);
// Native V2 detachment resets the provider runtime and its next turn resumes the durable conversation.
export const restartThreadSession = stopThreadSession;
