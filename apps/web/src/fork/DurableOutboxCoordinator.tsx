// T3-CUSTOM(expbkt3): offline delivery survives navigation away from its thread.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createDurableOutboxReplay } from "@t3tools/client-runtime/outbox";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { useContext, useEffect, useMemo, useRef } from "react";
import { useEnvironment, useEnvironments } from "../state/environments";
import { useCurrentUserId } from "../state/identity";
import { environmentShell } from "../state/shell";
import {
  durableThreadOutbox,
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { outboxAttachments } from "./useDurableThreadOutbox";

function EnvironmentOutboxRunner({
  environmentId,
  identityKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly identityKey: string;
}) {
  const registry = useContext(RegistryContext);
  const items = useAtomValue(durableThreadOutbox.itemsValueAtom(environmentId, identityKey));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadIndexAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const send = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const discard = useAtomCommand(threadEnvironment.discardOutbox);
  const fail = useAtomCommand(threadEnvironment.queueOutbox, { reportFailure: false });
  const replay = useRef<ReturnType<typeof createDurableOutboxReplay> | null>(null);
  const state = useMemo(
    () => ({
      items,
      connected: environment?.connection.phase === "connected",
      shellLive: shellState.status === "live",
      threadSettings: (message: (typeof items)[number]) => threads.get(message.threadId) ?? null,
      isCommitted: (message: (typeof items)[number]) => {
        const ref: ScopedThreadRef = { environmentId, threadId: message.threadId };
        return (
          registry
            .get(environmentThreadDetails.threadAtom(ref))
            ?.projection.messages.some((committed) => committed.id === message.messageId) ?? false
        );
      },
    }),
    [environment?.connection.phase, environmentId, items, registry, shellState.status, threads],
  );
  const latestState = useRef(state);
  latestState.current = state;
  useEffect(() => {
    const runner = createDurableOutboxReplay({
      environmentId,
      identityKey,
      discard,
      fail,
      dispatch: async (message, settings, stillCurrent) => {
        const attachments = await outboxAttachments(message);
        if (!stillCurrent()) return null;
        const context = remapComposerContextAttachments(
          message.context,
          message.attachments,
          attachments,
        );
        return send({
          environmentId,
          input: {
            threadId: message.threadId,
            commandId: message.commandId,
            message: {
              messageId: message.messageId,
              role: "user",
              text: message.text,
              attachments,
              ...(context ? { context } : {}),
            },
            ...settings,
            outboxIdentityKey: identityKey,
            createdAt: message.createdAt,
            ...(message.dispatchMode ? { dispatchMode: message.dispatchMode } : {}),
            ...(message.bootstrap ? { bootstrap: message.bootstrap } : {}),
            ...(message.sourceProposedPlan
              ? { sourceProposedPlan: message.sourceProposedPlan }
              : {}),
            ...(message.titleSeed ? { titleSeed: message.titleSeed } : {}),
            ...(message.manualContinuationOfRunId
              ? { manualContinuationOfRunId: message.manualContinuationOfRunId }
              : {}),
            ...(message.creationSource ? { creationSource: message.creationSource } : {}),
          },
        });
      },
    });
    replay.current = runner;
    runner.update(latestState.current);
    return () => {
      runner.dispose();
      replay.current = null;
    };
  }, [discard, environmentId, fail, identityKey, send]);
  useEffect(() => replay.current?.update(state), [state]);
  return null;
}

/** Mounted above the outlet so draft, settings, and other thread routes keep delivery live. */
export function DurableOutboxCoordinator() {
  const { environments } = useEnvironments();
  const identityKey = useCurrentUserId() ?? "anonymous";
  return environments
    .filter((environment) => environment.entry.enabled)
    .map((environment) => (
      <EnvironmentOutboxRunner
        key={`${environment.environmentId}:${identityKey}`}
        environmentId={environment.environmentId}
        identityKey={identityKey}
      />
    ));
}
