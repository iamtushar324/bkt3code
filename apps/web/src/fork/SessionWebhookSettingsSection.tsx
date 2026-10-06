/** T3-CUSTOM(expbkt3): inspect agent-created destinations without exposing callback secrets. */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  callbackDispatchLabel,
  callbackTransportLabel,
  sessionCallbackAttempts,
  sessionCallbackAttentionCount,
  sessionCallbackEvents,
  sessionCallbackHistoryWarning,
  sessionCallbackOpen,
  sessionCallbackReason,
  sessionCallbackSessionName,
  sessionWebhookChangeConfirmation,
  sessionWebhookChangeFailureMessage,
  sessionWebhookLifecycleLabel,
  sessionWebhookLifecycleNotice,
  sessionWebhookRemovedIssues,
  type SessionCallbackEvent,
  type SessionCallbackLabel,
  type SessionCallbackTone,
  type SessionWebhookAction,
} from "@t3tools/client-runtime/bk-session-callback-presentation";
import { toolyardSettingsFailureCode } from "@t3tools/client-runtime/toolyard-trust-setup";
import type { EnvironmentId, ServerConfig, SessionWebhookView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleXIcon,
  ClockIcon,
  MinusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useEnvironmentSessionState } from "../state/session";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { SettingsSection } from "../components/settings/settingsLayout";

interface PendingChange {
  readonly webhook: SessionWebhookView;
  readonly action: SessionWebhookAction;
  readonly sessionName: string;
}

const toneBadge = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  neutral: "outline",
} as const satisfies Record<SessionCallbackTone, string>;
const toneText: Record<SessionCallbackTone, string> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  info: "text-info-foreground",
  neutral: "text-muted-foreground",
};
const toneIcon = {
  success: CheckIcon,
  warning: TriangleAlertIcon,
  error: CircleXIcon,
  info: ClockIcon,
  neutral: MinusIcon,
} satisfies Record<SessionCallbackTone, unknown>;

const sectionTitle = (compact: boolean, label: string) =>
  compact ? "Session callbacks" : `Session webhooks — ${label}`;

/** Known codes get a plain explanation; the raw code always stays visible for audit. */
const reasonWithCode = (code: string) => {
  const explanation = sessionCallbackReason(code);
  return explanation === code ? code : `${explanation} (${code})`;
};

const formatTime = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

export function SessionWebhookSettingsSection() {
  const { connectedEnvironments } = useSettingsScope();
  return connectedEnvironments.length === 0 ? (
    <SettingsSection title="Session webhooks">
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Connect a selected server to inspect session webhooks.
      </p>
    </SettingsSection>
  ) : (
    connectedEnvironments.map((environment) =>
      environment.serverConfig ? (
        <EnvironmentSessionWebhookSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          serverConfig={environment.serverConfig}
        />
      ) : null,
    )
  );
}

/**
 * Session callbacks for one server. `compact` renders the card inside a per-server group whose
 * Refresh bumps `refreshVersion`; the standalone form keeps its own Refresh.
 */
export function EnvironmentSessionWebhookSettings({
  environmentId,
  label,
  serverConfig,
  compact = false,
  refreshVersion,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig;
  readonly compact?: boolean;
  readonly refreshVersion?: number;
}) {
  const { data: session } = useEnvironmentSessionState(environmentId);
  const userScope = session?.authenticated
    ? (session.userId ?? (serverConfig.auth.clerk ? null : "local-user"))
    : null;
  return userScope ? (
    <SessionWebhookSettingsContent
      key={`${environmentId}:${userScope}`}
      environmentId={environmentId}
      label={label}
      userScope={userScope}
      compact={compact}
      refreshVersion={refreshVersion}
    />
  ) : (
    <SettingsSection title={sectionTitle(compact, label)}>
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Authenticate with this server to inspect session callbacks.
      </p>
    </SettingsSection>
  );
}

function SessionWebhookSettingsContent({
  environmentId,
  label,
  userScope,
  compact,
  refreshVersion,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly userScope: string;
  readonly compact: boolean;
  readonly refreshVersion: number | undefined;
}) {
  const atom = useMemo(
    () => serverEnvironment.sessionWebhooksList({ environmentId, input: { userScope } }),
    [environmentId, userScope],
  );
  const result = useAtomValue(atom);
  // A failed refresh keeps the last loaded list, flagged below.
  const webhooks = Option.getOrNull(AsyncResult.value(result));
  const refreshFailed = AsyncResult.isFailure(result);
  const seenVersion = useRef(refreshVersion);
  useEffect(() => {
    if (refreshVersion === seenVersion.current) return;
    seenVersion.current = refreshVersion;
    appAtomRegistry.refresh(atom);
  }, [atom, refreshVersion]);
  const update = useAtomCommand(serverEnvironment.sessionWebhooksUpdate, "session webhook update");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string | null>>>({});
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A confirmed Remove moves the card into a closed section, unmounting the focus target.
  const listRef = useRef<HTMLDivElement>(null);
  const [focusList, setFocusList] = useState(false);
  const views = useMemo(
    () => (webhooks ?? []).map((webhook) => ({ webhook, events: sessionCallbackEvents(webhook) })),
    [webhooks],
  );
  const current = views.filter(({ webhook }) => webhook.status !== "removed");
  const removed = views.filter(({ webhook }) => webhook.status === "removed");
  // Removed webhooks surface their issues beside the section instead of in this badge.
  const attentionCount = current.reduce(
    (count, { events }) => count + sessionCallbackAttentionCount(events),
    0,
  );
  const change = async ({ webhook, action }: PendingChange) => {
    setBusy(webhook.id);
    setFocusList(false);
    setErrors((value) => ({ ...value, [webhook.id]: null }));
    try {
      // The revision the user saw is the compare-and-set guard; a newer one fails inline.
      const changed = await update({
        environmentId,
        input: { id: webhook.id, action, expectedRevision: webhook.revision },
      });
      if (AsyncResult.isSuccess(changed) && action === "remove") setFocusList(true);
      if (AsyncResult.isFailure(changed))
        setErrors((value) => ({
          ...value,
          [webhook.id]: sessionWebhookChangeFailureMessage(
            toolyardSettingsFailureCode(changed.cause),
          ),
        }));
    } catch {
      setErrors((value) => ({
        ...value,
        [webhook.id]: sessionWebhookChangeFailureMessage(null),
      }));
    } finally {
      setBusy(null);
      setConfirmOpen(false);
      appAtomRegistry.refresh(atom);
    }
  };
  const requestChange = (next: PendingChange) => {
    setFocusList(false);
    setPending(next);
    setConfirmOpen(true);
  };
  const copy = pending
    ? sessionWebhookChangeConfirmation(pending.action, pending.sessionName)
    : null;
  const card = (view: (typeof views)[number]) => (
    <SessionWebhookCard
      key={view.webhook.id}
      environmentId={environmentId}
      label={label}
      webhook={view.webhook}
      events={view.events}
      busy={busy !== null}
      error={errors[view.webhook.id] ?? null}
      onChange={requestChange}
    />
  );
  return (
    <SettingsSection
      title={sectionTitle(compact, label)}
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {attentionCount > 0 ? (
            <Badge variant="warning">
              <TriangleAlertIcon aria-hidden />
              {attentionCount === 1
                ? "1 event needs attention"
                : `${attentionCount} events need attention`}
            </Badge>
          ) : null}
          {compact ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={result.waiting}
              onClick={() => appAtomRegistry.refresh(atom)}
            >
              {result.waiting ? "Refreshing…" : "Refresh status"}
            </Button>
          )}
        </div>
      }
    >
      <div ref={listRef} tabIndex={-1} className="min-w-0 space-y-3 px-3 py-3 outline-none sm:px-4">
        <p className="text-xs text-muted-foreground">
          Agents create a callback for one session. Toolyard decisions queue after the active turn.
          Callbacks report decisions; they do not grant permission. Only recent events are listed.
        </p>
        {refreshFailed && webhooks !== null ? (
          <Notice tone="warning">
            The last refresh failed. Showing the status loaded earlier.
          </Notice>
        ) : null}
        {webhooks === null ? (
          <p className="text-sm text-muted-foreground">
            {refreshFailed
              ? "Callback status is unavailable. Check the server connection, then refresh."
              : "Loading callback status…"}
          </p>
        ) : views.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Agents create these for a session.
          </p>
        ) : (
          <>
            {current.map(card)}
            {removed.length > 0 ? (
              <>
                {removed.map((view) => (
                  <RemovedWebhookIssues
                    key={view.webhook.id}
                    environmentId={environmentId}
                    webhook={view.webhook}
                    events={view.events}
                  />
                ))}
                <Disclosure title={`Removed webhooks (${removed.length})`}>
                  <div className="space-y-3 pt-2">{removed.map(card)}</div>
                </Disclosure>
              </>
            ) : null}
          </>
        )}
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && busy === null) setConfirmOpen(false);
        }}
      >
        <AlertDialogPopup finalFocus={focusList ? listRef : true}>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={busy !== null}
              render={<Button variant="outline" disabled={busy !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant={pending?.action === "rotate" ? "default" : "destructive"}
              disabled={busy !== null || pending === null}
              onClick={() => {
                if (pending) void change(pending);
              }}
            >
              {busy !== null ? copy?.busy : copy?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function SessionWebhookCard({
  environmentId,
  label,
  webhook,
  events,
  busy,
  error,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly webhook: SessionWebhookView;
  readonly events: ReadonlyArray<SessionCallbackEvent>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (change: PendingChange) => void;
}) {
  // Titles come only from threads this client is already authorized to load.
  const shell = useThreadShell(scopeThreadRef(environmentId, webhook.threadId));
  const name = sessionCallbackSessionName(webhook.threadId, shell?.title);
  const lifecycle = sessionWebhookLifecycleLabel(webhook.status);
  const historyWarning = sessionCallbackHistoryWarning(webhook);
  const historyAvailable = !webhook.deliveryHistoryError && webhook.deliveryHistory !== undefined;
  const open = events.filter(sessionCallbackOpen);
  const past = events.filter((event) => !sessionCallbackOpen(event));
  const lifecycleNotice = sessionWebhookLifecycleNotice(webhook);
  const request = (action: SessionWebhookAction) =>
    onChange({ webhook, action, sessionName: name.text });
  return (
    <div className="min-w-0 space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="wrap-anywhere text-sm font-medium">{name.text}</p>
          {name.fallback ? (
            <p className="text-xs text-muted-foreground">
              Session title is not loaded in this client. The full session ID is in Webhook details.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={toneBadge[lifecycle.tone]}>{lifecycle.text} webhook</Badge>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || webhook.status === "removed"}
                  aria-label={`Manage webhook for ${name.text} on ${label}`}
                />
              }
            >
              Manage
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={webhook.status !== "active"} onClick={() => request("rotate")}>
                Rotate secret
              </MenuItem>
              <MenuItem disabled={webhook.status !== "active"} onClick={() => request("disable")}>
                Disable
              </MenuItem>
              <MenuItem variant="destructive" onClick={() => request("remove")}>
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {lifecycleNotice ? <Notice tone={lifecycleNotice.tone}>{lifecycleNotice.text}</Notice> : null}
      {historyWarning ? <Notice tone="warning">{historyWarning}</Notice> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {open.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {events.length === 0 ? "No callbacks have arrived." : "No callbacks need attention."}
        </p>
      ) : (
        open.map((event) => (
          <CallbackEventRow key={event.eventId} event={event} historyAvailable={historyAvailable} />
        ))
      )}
      {past.length > 0 ? (
        <Disclosure
          title={`Earlier callbacks (${past.length})`}
          accessibleSuffix={` for ${name.text}`}
        >
          {past.map((event) => (
            <CallbackEventRow
              key={event.eventId}
              event={event}
              historyAvailable={historyAvailable}
            />
          ))}
        </Disclosure>
      ) : null}
      <Disclosure title="Webhook details" accessibleSuffix={` for ${name.text}`}>
        <DetailList
          items={[
            ["Session", webhook.threadId],
            ["Webhook", webhook.id],
            ["Toolyard instance", webhook.instanceId],
            ["Toolyard callback", webhook.callbackRef ?? "Not registered yet"],
            ["Revision", String(webhook.revision)],
            ["Created", formatTime(webhook.createdAt)],
            ["Updated", formatTime(webhook.updatedAt)],
            [
              "Last reason",
              webhook.terminalReason ? reasonWithCode(webhook.terminalReason) : "None",
            ],
          ]}
        />
      </Disclosure>
    </div>
  );
}

/** A removed webhook's sync, history and failure issues, kept outside its closed section. */
function RemovedWebhookIssues({
  environmentId,
  webhook,
  events,
}: {
  readonly environmentId: EnvironmentId;
  readonly webhook: SessionWebhookView;
  readonly events: ReadonlyArray<SessionCallbackEvent>;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, webhook.threadId));
  const issues = sessionWebhookRemovedIssues(webhook, events);
  if (issues.length === 0) return null;
  const name = sessionCallbackSessionName(webhook.threadId, shell?.title);
  return issues.map((issue) => (
    <Notice key={issue.text} tone={issue.tone}>
      Removed webhook for {name.text}: {issue.text} Open Removed webhooks for details.
    </Notice>
  ));
}

function CallbackEventRow({
  event,
  historyAvailable,
}: {
  readonly event: SessionCallbackEvent;
  readonly historyAvailable: boolean;
}) {
  const { transport, dispatch } = event;
  return (
    <div className="min-w-0 space-y-1 border-t pt-2 text-xs">
      <Stage name="Toolyard → server" label={callbackTransportLabel(transport, historyAvailable)} />
      <Stage name="Server → session" label={callbackDispatchLabel(dispatch)} />
      <Disclosure title="Audit details" accessibleSuffix={` for event ${event.eventId}`}>
        <DetailList
          items={[
            ["Event", event.eventId],
            ...(transport
              ? ([
                  ["Toolyard inbox", transport.inboxId],
                  ["Toolyard status", transport.status],
                  ["Toolyard attempts", String(transport.attempts)],
                  [
                    "Toolyard reason",
                    transport.terminalReason ? reasonWithCode(transport.terminalReason) : "None",
                  ],
                ] as const)
              : []),
            ...(dispatch
              ? ([
                  ["Server state", dispatch.state],
                  ["Server attempts", String(dispatch.attempts)],
                  ["Received", formatTime(dispatch.receivedAt)],
                  ["Updated", formatTime(dispatch.updatedAt)],
                  [
                    "Server reason",
                    dispatch.terminalReason ? reasonWithCode(dispatch.terminalReason) : "None",
                  ],
                ] as const)
              : []),
          ]}
        />
        {transport && transport.history.length > 0 ? (
          <ol className="mt-2 space-y-1 text-muted-foreground">
            {sessionCallbackAttempts(transport).map((attempt) => (
              <li key={attempt.attempt} className="wrap-anywhere">
                Attempt {attempt.attempt} · {formatTime(attempt.at)} ·{" "}
                {attempt.httpStatus === null ? "No HTTP response" : `HTTP ${attempt.httpStatus}`}
                {" · "}
                {reasonWithCode(attempt.outcome)}
              </li>
            ))}
          </ol>
        ) : null}
      </Disclosure>
    </div>
  );
}

function Stage({ name, label }: { readonly name: string; readonly label: SessionCallbackLabel }) {
  const Icon = toneIcon[label.tone];
  return (
    <div className="grid min-w-0 gap-x-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <span className="text-muted-foreground">{name}</span>
      <span className={`flex min-w-0 items-start gap-1.5 ${toneText[label.tone]}`}>
        <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span className="wrap-anywhere">{label.text}</span>
      </span>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  readonly tone: SessionCallbackTone;
  readonly children: ReactNode;
}) {
  const Icon = toneIcon[tone];
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={`flex items-start gap-1.5 text-xs ${toneText[tone]}`}
    >
      <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="wrap-anywhere">{children}</span>
    </p>
  );
}

/** Closed by default; reopened sections keep no draft state, so unmounting is safe. */
function Disclosure({
  title,
  accessibleSuffix,
  children,
}: {
  readonly title: string;
  readonly accessibleSuffix?: string;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-7 items-center gap-1 text-left">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90"
        />
        <span className="text-xs text-muted-foreground group-hover:text-foreground">
          {title}
          {accessibleSuffix ? <span className="sr-only">{accessibleSuffix}</span> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-2 pb-1 pl-4.5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function DetailList({ items }: { readonly items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid min-w-0 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="wrap-anywhere font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
