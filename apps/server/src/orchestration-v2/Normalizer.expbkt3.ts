// T3-CUSTOM(expbkt3): normalize retained automation command payloads before native V2 dispatch.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type UserInputAttachments,
  getProviderAttachmentLimitError,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  // T3-CUSTOM(expbkt3): BEGIN — canonicalize embedded durable-bootstrap timestamps with the turn.
  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      ...(canonicalCommand.bootstrap.createThread
        ? {
            createThread: {
              ...canonicalCommand.bootstrap.createThread,
              createdAt: receivedAt,
            },
          }
        : {}),
    },
  };
  // T3-CUSTOM(expbkt3): END
};

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    // T3-CUSTOM(expbkt3): BEGIN — bootstrap initial turns use the same bounded,
    // persisted attachment normalization as ordinary turn starts. The body is
    // upstream's thread.turn.start attachment loop (uploaded-attachment claims
    // plus inline data URLs), parameterized by thread id so both call sites share it.
    const normalizeAttachments = (input: {
      readonly threadId: string;
      readonly attachments: Extract<
        ClientOrchestrationCommand,
        { type: "thread.turn.start" }
      >["message"]["attachments"];
      // Context records bind to attachments by the id the client knew; they follow the rename.
      readonly finalAttachmentIdByClientId?: Map<string, string>;
    }) =>
      Effect.gen(function* () {
        const claimedAttachmentPaths: string[] = [];
        const attachmentsWithDecodedSizes = [...input.attachments];
        const normalizedAttachments = yield* Effect.forEach(
          input.attachments,
          (attachment, index) =>
            Effect.gen(function* () {
              if (!("dataUrl" in attachment)) {
                const claim = planAttachmentClaim({
                  attachmentsDir: serverConfig.attachmentsDir,
                  threadId: input.threadId,
                  attachmentId: attachment.id,
                });
                if (!claim.ok) {
                  return yield* new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
                  });
                }

                const info = yield* fileSystem.stat(claim.currentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationDispatchCommandError({
                        message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                        cause,
                      }),
                  ),
                );
                if (Number(info.size) !== attachment.sizeBytes) {
                  return yield* new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
                  });
                }

                const normalizedAttachment = {
                  ...attachment,
                  id: claim.finalId,
                  mimeType: attachment.mimeType.toLowerCase(),
                };
                const expectedPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment: normalizedAttachment,
                });
                if (expectedPath !== claim.finalPath) {
                  return yield* new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
                  });
                }

                // Keep the pending copy until the turn succeeds. A failed thread
                // bootstrap can then retry with a fresh thread id. A copy, not a
                // hard link: an agent editing the delivered file in place must not
                // mutate the retry source.
                yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationDispatchCommandError({
                        message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                        cause,
                      }),
                  ),
                );
                claimedAttachmentPaths.push(claim.finalPath);
                input.finalAttachmentIdByClientId?.set(attachment.id, claim.finalId);

                return normalizedAttachment;
              }

              const parsed = parseBase64DataUrl(attachment.dataUrl);
              if (!parsed || !parsed.mimeType.startsWith("image/")) {
                return yield* new OrchestrationDispatchCommandError({
                  message: `Invalid image attachment payload for '${attachment.name}'.`,
                });
              }

              const bytes = Buffer.from(parsed.base64, "base64");
              if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                return yield* new OrchestrationDispatchCommandError({
                  message: `Image attachment '${attachment.name}' is empty or too large.`,
                });
              }

              const attachmentId = createAttachmentId(input.threadId);
              if (!attachmentId) {
                return yield* new OrchestrationDispatchCommandError({
                  message: "Failed to create a safe attachment id.",
                });
              }

              const persistedAttachment = {
                type: "image" as const,
                id: attachmentId,
                name: attachment.name,
                mimeType: parsed.mimeType.toLowerCase(),
                sizeBytes: bytes.byteLength,
                ...(attachment.source ? { source: attachment.source } : {}),
              };
              attachmentsWithDecodedSizes[index] = persistedAttachment;
              const decodedLimitError = getProviderAttachmentLimitError(
                attachmentsWithDecodedSizes,
              );
              if (decodedLimitError) {
                return yield* new OrchestrationDispatchCommandError({ message: decodedLimitError });
              }

              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment: persistedAttachment,
              });
              if (!attachmentPath) {
                return yield* new OrchestrationDispatchCommandError({
                  message: `Failed to resolve persisted path for '${attachment.name}'.`,
                });
              }

              yield* fileSystem
                .makeDirectory(path.dirname(attachmentPath), { recursive: true })
                .pipe(
                  Effect.mapError(
                    () =>
                      new OrchestrationDispatchCommandError({
                        message: `Failed to create attachment directory for '${attachment.name}'.`,
                      }),
                  ),
                );
              yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: `Failed to persist attachment '${attachment.name}'.`,
                    }),
                ),
              );
              claimedAttachmentPaths.push(attachmentPath);
              if (attachment.id !== undefined) {
                input.finalAttachmentIdByClientId?.set(attachment.id, attachmentId);
              }

              return persistedAttachment;
            }),
          { concurrency: 1 },
        ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));
        return normalizedAttachments;
      });
    // T3-CUSTOM(expbkt3): END

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type !== "thread.turn.start" &&
      canonicalCommand.type !== "thread.user-input.respond"
    ) {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachments =
      canonicalCommand.type === "thread.turn.start"
        ? canonicalCommand.message.attachments
        : Object.values(canonicalCommand.attachmentsByQuestionId ?? {}).flat();
    const attachmentLimitError = getProviderAttachmentLimitError(attachments);
    if (attachmentLimitError) {
      return yield* new OrchestrationDispatchCommandError({ message: attachmentLimitError });
    }
    if (canonicalCommand.type === "thread.turn.start") {
      const clientAttachmentIds = new Set<string>();
      for (const attachment of attachments) {
        if (attachment.id === undefined) continue;
        if (clientAttachmentIds.has(attachment.id)) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Attachment '${attachment.name}' cannot be sent: duplicate attachment id.`,
          });
        }
        clientAttachmentIds.add(attachment.id);
      }
    }
    // T3-CUSTOM(expbkt3): BEGIN — upstream normalizes attachments inline here; the
    // fork calls its own `normalizeAttachments` helper. Upstream's per-attachment
    // rename bookkeeping and decoded-size limit check (#12620) live in the helper
    // so they are not lost.
    // Context records bind to attachments by the id the client knew; they follow the rename.
    const finalAttachmentIdByClientId = new Map<string, string>();
    const normalizedAttachments = yield* normalizeAttachments({
      threadId: canonicalCommand.threadId,
      attachments,
      finalAttachmentIdByClientId,
    });
    // T3-CUSTOM(expbkt3): END

    if (canonicalCommand.type === "thread.user-input.respond") {
      let index = 0;
      const attachmentsByQuestionId = Object.fromEntries(
        Object.entries(canonicalCommand.attachmentsByQuestionId ?? {}).map(
          ([questionId, original]) => {
            const claimed = normalizedAttachments.slice(
              index,
              index + original.length,
            ) as UserInputAttachments[string];
            index += original.length;
            return [questionId, claimed];
          },
        ),
      );
      return {
        ...canonicalCommand,
        ...(attachments.length > 0 ? { attachmentsByQuestionId } : {}),
      };
    }
    const context = canonicalCommand.message.context;
    const normalizedContext =
      context === undefined
        ? undefined
        : {
            ...context,
            records: context.records.map((record) =>
              (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                ? {
                    ...record,
                    attachmentId:
                      finalAttachmentIdByClientId.get(record.attachmentId) ?? record.attachmentId,
                  }
                : record,
            ),
          };
    // T3-CUSTOM(expbkt3): BEGIN — `normalizedAttachments` comes from the fork's
    // shared helper rather than upstream's inline loop; the context spread is
    // upstream's and is preserved verbatim.
    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
        ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      },
    } satisfies OrchestrationCommand;
    // T3-CUSTOM(expbkt3): END
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  const originalAttachments =
    command.type === "thread.turn.start"
      ? command.message.attachments
      : command.type === "thread.user-input.respond"
        ? Object.values(command.attachmentsByQuestionId ?? {}).flat()
        : [];
  const normalizedAttachments =
    normalizedCommand.type === "thread.turn.start"
      ? normalizedCommand.message.attachments
      : normalizedCommand.type === "thread.user-input.respond"
        ? Object.values(normalizedCommand.attachmentsByQuestionId ?? {}).flat()
        : [];
  if (normalizedAttachments.length === 0) return;

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    const original = originalAttachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
