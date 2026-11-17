/**
 * T3-CUSTOM(expbkt3): the one-line Toolyard and session-callback status shown on a folded
 * server in BK Add-ons. It reads the same query atoms the open cards read, so a fold adds no
 * extra request.
 */
import { useAtomValue } from "@effect/atom-react";
import { toolyardConnectionPresentation } from "@t3tools/client-runtime/bk-toolyard-presentation";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentSessionState } from "../state/session";
import { serverEnvironment } from "../state/server";
import { sessionWebhookAttentionText, summarizeSessionWebhooks } from "./sessionWebhookSummary";

export function BkAddonsServerSummary({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: EnvironmentServerConfig;
}) {
  const { data: session } = useEnvironmentSessionState(environmentId);
  // The cards scope their queries the same way; another scope would be another request.
  const userScope = session?.authenticated
    ? (session.userId ?? (serverConfig.auth.clerk ? null : "local-user"))
    : null;
  if (!userScope) return <span>Sign in to this server to see its connections</span>;
  return <ScopedSummary environmentId={environmentId} userScope={userScope} />;
}

function ScopedSummary({
  environmentId,
  userScope,
}: {
  readonly environmentId: EnvironmentId;
  readonly userScope: string;
}) {
  const target = useMemo(
    () => ({ environmentId, input: { userScope } }),
    [environmentId, userScope],
  );
  const toolyardAtom = useMemo(() => serverEnvironment.toolyardIntegrationStatus(target), [target]);
  const webhooksAtom = useMemo(() => serverEnvironment.sessionWebhooksList(target), [target]);
  const toolyardResult = useAtomValue(toolyardAtom);
  const webhooksResult = useAtomValue(webhooksAtom);
  const toolyard = toolyardConnectionPresentation(
    Option.getOrNull(AsyncResult.value(toolyardResult)),
  );
  const webhooks = Option.getOrNull(AsyncResult.value(webhooksResult));
  const callbacks = webhooks === null ? null : summarizeSessionWebhooks(webhooks);
  const callbackAttention = callbacks === null ? null : sessionWebhookAttentionText(callbacks);
  const toolyardNeedsYou = toolyard.tone === "warning" || toolyard.tone === "error";
  return (
    <>
      <span className={toolyardNeedsYou ? "text-warning-foreground" : undefined}>
        Toolyard: {toolyard.label}
      </span>
      {callbacks === null ? null : (
        <>
          {" · "}
          <span className={callbackAttention ? "text-warning-foreground" : undefined}>
            {callbackAttention ??
              (callbacks.total === 1 ? "1 callback" : `${callbacks.total} callbacks`)}
          </span>
        </>
      )}
    </>
  );
}
