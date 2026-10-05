/** T3-CUSTOM(expbkt3): session callback management through the authenticated environment RPC. */
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
  sessionCallbackSessionName,
  sessionWebhookChangeConfirmation,
  sessionWebhookChangeFailureMessage,
  sessionWebhookLifecycleLabel,
  sessionWebhookLifecycleNotice,
  sessionWebhookRemovedIssues,
  type SessionCallbackEvent,
  type SessionCallbackLabel,
  type SessionWebhookAction,
} from "@t3tools/client-runtime/bk-session-callback-presentation";
import { shortToolyardId } from "@t3tools/client-runtime/bk-toolyard-presentation";
import { toolyardSettingsFailureCode } from "@t3tools/client-runtime/toolyard-trust-setup";
import type { SessionWebhookView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";
import {
  BkAddonButton,
  BkAddonDisclosure,
  bkAddonTime,
  bkAddonTone,
  useBkAddonRefresh,
} from "./ToolyardSettingsSection";

/**
 * Splits each session's joined events with the same rule as web: failures and work in progress
 * stay visible, everything else is collapsed history. Removed webhooks are listed apart and
 * left out of the attention count. Sessions with failures sort first; order is otherwise kept.
 */
export function sessionCallbackGroups(webhooks: ReadonlyArray<SessionWebhookView>) {
  const groups = webhooks.map((webhook) => {
    const events = sessionCallbackEvents(webhook);
    return {
      webhook,
      events,
      attentionCount: sessionCallbackAttentionCount(events),
      visible: events.filter(sessionCallbackOpen),
      history: events.filter((event) => !sessionCallbackOpen(event)),
    };
  });
  const current = groups.filter((group) => group.webhook.status !== "removed");
  return {
    attentionCount: current.reduce((total, group) => total + group.attentionCount, 0),
    groups: current.sort(
      (left, right) => Number(right.attentionCount > 0) - Number(left.attentionCount > 0),
    ),
    removed: groups.filter((group) => group.webhook.status === "removed"),
  };
}

const ACTION_LABELS: Record<SessionWebhookAction, string> = {
  rotate: "Rotate secret",
  disable: "Disable",
  remove: "Remove",
};

type SessionCallbacksServerProps = {
  readonly target: SettingsTarget;
  readonly userScope: string;
  readonly refreshToken: number;
};
/** Session callbacks for one selected server. The caller supplies the authenticated user scope. */
export function SessionCallbacksServerSettings(props: SessionCallbacksServerProps) {
  return (
    <EnvironmentWebhooks key={`${props.target.environmentId}:${props.userScope}`} {...props} />
  );
}
function EnvironmentWebhooks({ target, userScope, refreshToken }: SessionCallbacksServerProps) {
  const atom = useMemo(
    () =>
      serverEnvironment.sessionWebhooksList({
        environmentId: target.environmentId,
        input: { userScope },
      }),
    [target.environmentId, userScope],
  );
  const result = useAtomValue(atom);
  useBkAddonRefresh(atom, refreshToken);
  const webhooks = Option.getOrNull(AsyncResult.value(result));
  const refreshFailed = AsyncResult.isFailure(result);
  const update = useAtomCommand(serverEnvironment.sessionWebhooksUpdate, "session webhook update");
  const [busy, setBusy] = useState(false);
  // Keyed by webhook so a failure stays on the card that names its session.
  const [errors, setErrors] = useState<Readonly<Record<string, string | null>>>({});
  const [removedOpen, setRemovedOpen] = useState(false);
  const { attentionCount, groups, removed } = useMemo(
    () => sessionCallbackGroups(webhooks ?? []),
    [webhooks],
  );
  const change = async (webhook: SessionWebhookView, action: SessionWebhookAction) => {
    setBusy(true);
    setErrors((value) => ({ ...value, [webhook.id]: null }));
    try {
      // The revision the user saw is the compare-and-set guard; a newer one fails inline.
      const changed = await update({
        environmentId: target.environmentId,
        input: { id: webhook.id, action, expectedRevision: webhook.revision },
      });
      appAtomRegistry.refresh(atom);
      if (!AsyncResult.isSuccess(changed))
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
      setBusy(false);
    }
  };
  const card = (group: (typeof groups)[number]) => (
    <SessionCallbackCard
      key={group.webhook.id}
      target={target}
      webhook={group.webhook}
      visible={group.visible}
      history={group.history}
      busy={busy}
      error={errors[group.webhook.id] ?? null}
      onChange={(action) => void change(group.webhook, action)}
    />
  );
  return (
    <View className="gap-3 p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-base font-t3-bold text-foreground">Session callbacks</Text>
        {attentionCount > 0 ? (
          <StatusPill
            size="compact"
            {...bkAddonTone(
              attentionCount === 1
                ? "1 event needs attention"
                : `${attentionCount} events need attention`,
              "warning",
            )}
          />
        ) : null}
      </View>
      <Text className="text-sm text-foreground-muted">
        Callbacks report decisions. They do not grant permission; Toolyard Inbox stays where you
        decide.
      </Text>
      {refreshFailed && webhooks ? (
        <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
          Refresh failed. This shows the last list the server returned.
        </Text>
      ) : null}
      {webhooks === null ? (
        <Text className="text-sm text-foreground-muted">
          {refreshFailed
            ? "The session callback status is unavailable. Select Refresh to try again."
            : "Reading session callbacks from this server."}
        </Text>
      ) : webhooks.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          None yet. Agents create these for a session.
        </Text>
      ) : (
        <>
          {groups.map(card)}
          {removed.length > 0 ? (
            <>
              {removed.map((group) => (
                <RemovedWebhookIssues
                  key={group.webhook.id}
                  target={target}
                  webhook={group.webhook}
                  events={group.events}
                />
              ))}
              <BkAddonDisclosure
                label={`Removed webhooks (${removed.length})`}
                accessibilityLabel={`Removed callback webhooks, ${removed.length}`}
                expanded={removedOpen}
                onToggle={() => setRemovedOpen((value) => !value)}
              >
                {removed.map(card)}
              </BkAddonDisclosure>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
function SessionCallbackCard({
  target,
  webhook,
  visible,
  history,
  busy,
  error,
  onChange,
}: {
  readonly target: SettingsTarget;
  readonly webhook: SessionWebhookView;
  readonly visible: ReadonlyArray<SessionCallbackEvent>;
  readonly history: ReadonlyArray<SessionCallbackEvent>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (action: SessionWebhookAction) => void;
}) {
  // Titles come only from thread shells this client is already authorized to hold.
  const shell = useThreadShell(scopeThreadRef(target.environmentId, webhook.threadId));
  const name = sessionCallbackSessionName(webhook.threadId, shell?.title);
  const lifecycle = sessionWebhookLifecycleLabel(webhook.status);
  const historyWarning = sessionCallbackHistoryWarning(webhook);
  const historyAvailable = historyWarning === null;
  const lifecycleNotice = sessionWebhookLifecycleNotice(webhook);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const confirm = (action: SessionWebhookAction) => {
    const copy = sessionWebhookChangeConfirmation(action, name.text);
    Alert.alert(copy.title, copy.description, [
      { text: "Cancel", style: "cancel" },
      {
        text: copy.confirm,
        style: action === "rotate" ? "default" : "destructive",
        onPress: () => onChange(action),
      },
    ]);
  };
  const actions = (["rotate", "disable", "remove"] as const).filter((action) =>
    action === "remove" ? webhook.status !== "removed" : webhook.status === "active",
  );
  return (
    <View className="gap-2 rounded-2xl border border-border p-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">{name.text}</Text>
        <StatusPill size="compact" {...bkAddonTone(lifecycle.text, lifecycle.tone)} />
      </View>
      {name.fallback ? (
        <Text className="text-xs text-foreground-muted">
          The session title is not loaded in this client.
        </Text>
      ) : null}
      {lifecycleNotice ? (
        <Text
          accessibilityRole={lifecycleNotice.tone === "error" ? "alert" : undefined}
          className={cn("text-xs", STAGE_TEXT_CLASS[lifecycleNotice.tone])}
        >
          {STAGE_GLYPH[lifecycleNotice.tone]}
          {lifecycleNotice.text}
        </Text>
      ) : null}
      {historyWarning ? (
        <Text accessibilityRole="alert" className="text-xs text-warning-foreground">
          {historyWarning}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {visible.map((event) => (
        <CallbackEventRow
          key={event.eventId}
          event={event}
          sessionName={name.text}
          historyAvailable={historyAvailable}
        />
      ))}
      {history.length > 0 ? (
        <BkAddonDisclosure
          label={`Earlier callbacks (${history.length})`}
          accessibilityLabel={`Earlier callbacks for ${name.text}, ${history.length} events`}
          expanded={historyOpen}
          onToggle={() => setHistoryOpen((value) => !value)}
        >
          {history.map((event) => (
            <CallbackEventRow
              key={event.eventId}
              event={event}
              sessionName={name.text}
              historyAvailable={historyAvailable}
            />
          ))}
          <Text className="text-xs text-foreground-muted">
            The server keeps a bounded recent history. Older events may not appear.
          </Text>
        </BkAddonDisclosure>
      ) : visible.length === 0 ? (
        <Text className="text-xs text-foreground-muted">No callbacks have arrived yet.</Text>
      ) : null}
      <BkAddonDisclosure
        label="Details"
        accessibilityLabel={`Callback details for ${name.text}`}
        expanded={detailsOpen}
        onToggle={() => setDetailsOpen((value) => !value)}
      >
        {[
          ["Session ID", webhook.threadId],
          ["Webhook ID", webhook.id],
          ["Toolyard instance", webhook.instanceId],
          ["Toolyard callback", webhook.callbackRef ?? "Not registered"],
          ["Created", bkAddonTime(webhook.createdAt)],
          ["Updated", bkAddonTime(webhook.updatedAt)],
          ["Revision", String(webhook.revision)],
          ["Reason code", webhook.terminalReason ?? "None"],
          ["History error", webhook.deliveryHistoryError ?? "None"],
        ].map(([label, value]) => (
          <Text key={label} selectable className="text-xs text-foreground-muted">
            {label}: <Text className="text-xs text-foreground">{value}</Text>
          </Text>
        ))}
      </BkAddonDisclosure>
      {actions.length > 0 ? (
        <BkAddonDisclosure
          label="Manage webhook"
          accessibilityLabel={`Manage the callback webhook for ${name.text}`}
          expanded={manageOpen}
          onToggle={() => setManageOpen((value) => !value)}
        >
          <View className="flex-row flex-wrap gap-2">
            {actions.map((action) => (
              <BkAddonButton
                key={action}
                tone={action === "rotate" ? "secondary" : "danger"}
                label={ACTION_LABELS[action]}
                accessibilityLabel={`${ACTION_LABELS[action]} for ${name.text}`}
                disabled={busy}
                onPress={() => confirm(action)}
              />
            ))}
          </View>
        </BkAddonDisclosure>
      ) : null}
    </View>
  );
}
/** A removed webhook's sync, history and failure issues, kept outside its closed section. */
function RemovedWebhookIssues({
  target,
  webhook,
  events,
}: {
  readonly target: SettingsTarget;
  readonly webhook: SessionWebhookView;
  readonly events: ReadonlyArray<SessionCallbackEvent>;
}) {
  const shell = useThreadShell(scopeThreadRef(target.environmentId, webhook.threadId));
  const issues = sessionWebhookRemovedIssues(webhook, events);
  if (issues.length === 0) return null;
  const name = sessionCallbackSessionName(webhook.threadId, shell?.title);
  return issues.map((issue) => (
    <Text
      key={issue.text}
      accessibilityRole={issue.tone === "error" ? "alert" : undefined}
      className={cn("text-xs", STAGE_TEXT_CLASS[issue.tone])}
    >
      {STAGE_GLYPH[issue.tone]}Removed webhook for {name.text}: {issue.text} Open Removed webhooks
      for details.
    </Text>
  ));
}
function CallbackEventRow({
  event,
  sessionName,
  historyAvailable,
}: {
  readonly event: SessionCallbackEvent;
  readonly sessionName: string;
  readonly historyAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const transport = event.transport;
  const dispatch = event.dispatch;
  return (
    <View className="gap-1 border-t border-border pt-2">
      <CallbackStage
        label="Toolyard → server"
        value={callbackTransportLabel(transport, historyAvailable)}
      />
      <CallbackStage label="Server → session" value={callbackDispatchLabel(dispatch)} />
      <BkAddonDisclosure
        label={`Attempts and event ${shortToolyardId(event.eventId)}`}
        accessibilityLabel={`Attempts and audit details for ${sessionName}, event ${shortToolyardId(event.eventId)}`}
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
      >
        <Text selectable className="text-xs text-foreground-muted">
          Event ID: <Text className="text-xs text-foreground">{event.eventId}</Text>
        </Text>
        {transport ? (
          <>
            <Text selectable className="text-xs text-foreground-muted">
              Toolyard: {transport.status}, {transport.attempts} attempt(s), inbox{" "}
              {transport.inboxId}
              {transport.terminalReason ? `, reason ${transport.terminalReason}` : ""}.
            </Text>
            {sessionCallbackAttempts(transport).map((attempt) => (
              <Text key={attempt.attempt} selectable className="text-xs text-foreground-muted">
                Attempt {attempt.attempt}, {bkAddonTime(attempt.at)}:{" "}
                {attempt.httpStatus === null ? "No HTTP response." : `HTTP ${attempt.httpStatus}.`}{" "}
                {attempt.outcome}
              </Text>
            ))}
          </>
        ) : (
          <Text className="text-xs text-foreground-muted">
            No Toolyard delivery record was returned for this event.
          </Text>
        )}
        {dispatch ? (
          <Text selectable className="text-xs text-foreground-muted">
            Server: {dispatch.state}, {dispatch.attempts} dispatch attempt(s), received{" "}
            {bkAddonTime(dispatch.receivedAt)}, updated {bkAddonTime(dispatch.updatedAt)}
            {dispatch.terminalReason ? `, reason ${dispatch.terminalReason}` : ""}.
          </Text>
        ) : (
          <Text className="text-xs text-foreground-muted">
            This server has no record of receiving this event.
          </Text>
        )}
      </BkAddonDisclosure>
    </View>
  );
}
const STAGE_TEXT_CLASS: Record<SessionCallbackLabel["tone"], string> = {
  success: "text-adaptive-emerald-700-300",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
  info: "text-foreground",
  neutral: "text-foreground-muted",
};
const STAGE_GLYPH: Record<SessionCallbackLabel["tone"], string> = {
  success: "✓ ",
  warning: "! ",
  error: "! ",
  info: "",
  neutral: "",
};
/** One delivery stage. The two stages never merge into a single success state. */
function CallbackStage(props: { readonly label: string; readonly value: SessionCallbackLabel }) {
  return (
    <View className="flex-row flex-wrap gap-x-2">
      <Text className="w-32 text-xs text-foreground-muted">{props.label}</Text>
      <Text className={cn("min-w-0 flex-1 text-xs", STAGE_TEXT_CLASS[props.value.tone])}>
        {STAGE_GLYPH[props.value.tone]}
        {props.value.text}
      </Text>
    </View>
  );
}
