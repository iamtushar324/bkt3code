import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): ReactNode types the fork banners rendered in the lane.
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  dismissProviderStatusBannerForSession,
  ProviderStatusBanner,
} from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusDismissalKey: string | null;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
  // T3-CUSTOM(expbkt3): fork banners (durable outbox recovery) share the lane.
  children?: ReactNode;
}) {
  const {
    providerStatus,
    providerStatusDismissalKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
    // T3-CUSTOM(expbkt3): fork banners share the lane.
    children,
  } = props;
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => dismissProviderStatusBannerForSession(providerStatusDismissalKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
      {/* T3-CUSTOM(expbkt3): fork banners share the lane. */}
      {children}
    </div>
  );
}
