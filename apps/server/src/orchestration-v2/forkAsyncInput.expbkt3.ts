// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** BK message-response questions remain pending independently of provider turn state. */
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
export function forkHasPendingAsyncUserInput(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  const requests = new Map<string, boolean>();
  for (const item of items.toSorted((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))) {
    if (
      item.type !== "dynamic_tool" ||
      !Predicate.isObject(item.input) ||
      !("forkLegacyActivity" in item.input)
    )
      continue;
    const activity = item.input.forkLegacyActivity;
    if (
      !Predicate.isObject(activity) ||
      !("payload" in activity) ||
      !Predicate.isObject(activity.payload)
    )
      continue;
    const payload = activity.payload;
    if (!("requestId" in payload) || typeof payload.requestId !== "string") continue;
    if (activity.kind === "user-input.requested" && payload.responseMode === "message")
      requests.set(payload.requestId, true);
    if (
      activity.kind === "user-input.resolved" ||
      activity.kind === "user-input.dismissed" ||
      activity.kind === "user-input.expired"
    )
      requests.set(payload.requestId, false);
  }
  return [...requests.values()].some(Boolean);
}

export function forkAsyncInputChange(
  item: OrchestrationV2TurnItem,
): { readonly requestId: string; readonly pending: boolean } | undefined {
  if (
    item.type !== "dynamic_tool" ||
    !Predicate.isObject(item.input) ||
    !("forkLegacyActivity" in item.input)
  )
    return undefined;
  const activity = item.input.forkLegacyActivity;
  if (
    !Predicate.isObject(activity) ||
    !Predicate.isObject(activity.payload) ||
    typeof activity.payload.requestId !== "string"
  )
    return undefined;
  if (activity.kind === "user-input.requested" && activity.payload.responseMode === "message")
    return { requestId: activity.payload.requestId, pending: true };
  if (
    activity.kind === "user-input.resolved" ||
    activity.kind === "user-input.dismissed" ||
    activity.kind === "user-input.expired"
  )
    return { requestId: activity.payload.requestId, pending: false };
  return undefined;
}
export function updatePendingAsyncUserInputIds(
  ids: ReadonlyArray<string>,
  change: { readonly requestId: string; readonly pending: boolean },
): ReadonlyArray<string> {
  return change.pending
    ? [...new Set([...ids, change.requestId])]
    : ids.filter((id) => id !== change.requestId);
}
