// T3-CUSTOM(expbkt3): the mobile plan-review screen.
//
// Web reviews plans in a rich-text editor (Plate). That does not port: on a
// phone the useful operations are read the plan, question a specific line, and
// decide. So this surface is read-plus-annotate — tap lines to select, comment,
// then approve or request changes — and reviewer edits to the plan body stay a
// desktop affordance. `editedMarkdown` is therefore always null on submit here,
// which the contract already allows.
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  EnvironmentId,
  PlanReviewDecision,
  PlanReviewSnapshotResult,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentQuery } from "../../state/query";
import { planReviewEnvironment } from "../../state/planReview";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildPlanReviewView,
  quotedTextForLineRange,
  type PlanReviewLineRow,
} from "./planReviewDocumentModel";
import {
  formatPlanReviewSelectionLabel,
  setPlanReviewSelection,
  togglePlanReviewLine,
  usePlanReviewSelection,
} from "./planReviewSelection";

type PlanReviewSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly documentId: string;
}>;

function PlanReviewLine(props: {
  readonly row: PlanReviewLineRow;
  readonly isSelected: boolean;
  readonly onPress: (lineIndex: number) => void;
}) {
  const { row, isSelected, onPress } = props;
  const handlePress = useCallback(() => onPress(row.lineIndex), [onPress, row.lineIndex]);

  return (
    <Pressable
      accessibilityHint="Double tap to select this line. Select another line to extend the range."
      accessibilityLabel={`Line ${row.lineIndex + 1}${row.discussionIds.length > 0 ? `, ${row.discussionIds.length} open comment${row.discussionIds.length === 1 ? "" : "s"}` : ""}: ${row.text || "blank"}`}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      className={cn(
        "flex-row items-start px-3 py-0.5",
        isSelected && "bg-primary/15",
        !isSelected && row.discussionIds.length > 0 && "bg-amber-500/10",
      )}
      onPress={handlePress}
    >
      <Text className="w-8 shrink-0 pt-0.5 text-right font-t3-mono text-[10px] text-foreground-muted">
        {row.lineIndex + 1}
      </Text>
      <Text className="ml-2 flex-1 font-t3-mono text-xs leading-relaxed text-foreground">
        {row.text.length > 0 ? row.text : " "}
      </Text>
      {row.discussionIds.length > 0 ? (
        <Text className="ml-2 pt-0.5 font-t3-mono text-[10px] text-adaptive-amber-700-400">
          {row.discussionIds.length}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function PlanReviewSheet(props: PlanReviewSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconTint = String(useUniwindTheme()["--color-icon"]);
  const { environmentId, threadId, documentId } = props.route.params;
  const selection = usePlanReviewSelection();
  const [pendingDecision, setPendingDecision] = useState<PlanReviewDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initial = useEnvironmentQuery(
    planReviewEnvironment.review({ environmentId, input: { documentId } }),
  );
  // The subscription supersedes the one-shot read as soon as it produces a
  // frame, so the screen never renders stale state after the agent revises the
  // plan or another client comments. Same precedence as the web panel.
  const live = useEnvironmentQuery(
    planReviewEnvironment.subscription({ environmentId, input: { documentId } }),
  );
  const snapshot: PlanReviewSnapshotResult | null = live.data ?? initial.data ?? null;
  const submit = useAtomCommand(planReviewEnvironment.submit, "plan review submit");

  const view = useMemo(
    () => (snapshot === null ? null : buildPlanReviewView(snapshot)),
    [snapshot],
  );

  const handleLinePress = useCallback(
    (lineIndex: number) => {
      if (view === null) return;
      setPlanReviewSelection(
        togglePlanReviewLine({
          current: selection,
          documentId,
          lineIndex,
          quoteFor: (startIndex, endIndex) =>
            quotedTextForLineRange(view.lines, startIndex, endIndex),
        }),
      );
    },
    [documentId, selection, view],
  );

  const handleOpenComposer = useCallback(() => {
    navigation.navigate("ThreadPlanReviewComment", { environmentId, threadId, documentId });
  }, [documentId, environmentId, navigation, threadId]);

  const handleDecide = useCallback(
    (decision: PlanReviewDecision) => {
      setPendingDecision(decision);
      setError(null);
      void submit({
        environmentId,
        input: { documentId, decision, globalComment: "", editedMarkdown: null },
      })
        .then((result) => {
          if (result._tag === "Failure") {
            setError("The decision could not be sent. Try again.");
            return;
          }
          // The agent picks the turn up from here; the thread is where the
          // reviewer watches it happen.
          navigation.goBack();
        })
        .finally(() => {
          setPendingDecision(null);
        });
    },
    [documentId, environmentId, navigation, submit],
  );

  if (initial.isPending && view === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <ActivityIndicator />
      </View>
    );
  }

  if (view === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-screen px-8">
        <Text className="text-center text-sm text-foreground-muted">
          {initial.error ?? "This plan is no longer available."}
        </Text>
        <Pressable
          accessibilityLabel="Retry plan review"
          accessibilityRole="button"
          hitSlop={8}
          onPress={initial.refresh}
        >
          <Text className="text-sm font-t3-bold text-primary">Try again</Text>
        </Pressable>
      </View>
    );
  }

  const isDecided = snapshot?.document.status !== "open";
  const isSubmitting = pendingDecision !== null;

  return (
    <View className="flex-1 bg-screen">
      <FlatList
        ListFooterComponent={
          <PlanReviewDiscussionList
            environmentId={environmentId}
            documentId={documentId}
            threads={view.threads}
          />
        }
        ListHeaderComponent={
          <View className="border-b border-border px-4 py-3">
            <Text className="text-base font-t3-bold text-foreground">
              {snapshot?.document.title ?? "Plan"}
            </Text>
            <Text className="mt-0.5 text-xs text-foreground-muted">
              Revision {view.currentVersion?.revision ?? 0}
              {view.unresolvedCount > 0
                ? ` · ${view.unresolvedCount} open comment${view.unresolvedCount === 1 ? "" : "s"}`
                : ""}
            </Text>
            <Text className="mt-2 text-xs text-foreground-muted">
              Tap a line to select it, tap another to extend, then comment.
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        data={view.lines}
        initialNumToRender={40}
        keyExtractor={(row) => String(row.lineIndex)}
        renderItem={({ item }) => (
          <PlanReviewLine
            isSelected={
              selection !== null &&
              item.lineIndex >= selection.startIndex &&
              item.lineIndex <= selection.endIndex
            }
            onPress={handleLinePress}
            row={item}
          />
        )}
        windowSize={11}
      />

      {error === null ? null : (
        <View className="absolute inset-x-0 px-4" style={{ bottom: insets.bottom + 96 }}>
          <View className="rounded-md bg-destructive px-3 py-2">
            <Text className="text-xs text-destructive-foreground">{error}</Text>
          </View>
        </View>
      )}

      {selection === null ? (
        isDecided ? null : (
          <View
            className="absolute inset-x-0 flex-row gap-3 border-t border-border bg-screen px-4 pt-3"
            style={{ bottom: 0, paddingBottom: insets.bottom + 12 }}
          >
            <Pressable
              accessibilityLabel="Request changes to this plan"
              accessibilityRole="button"
              accessibilityState={{
                disabled: isSubmitting,
                busy: pendingDecision === "changes-requested",
              }}
              className="flex-1 items-center rounded-lg border border-border py-3"
              disabled={isSubmitting}
              onPress={() => handleDecide("changes-requested")}
            >
              {pendingDecision === "changes-requested" ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text className="text-sm font-t3-bold text-foreground">Request changes</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="Approve this plan"
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting, busy: pendingDecision === "approved" }}
              className="flex-1 items-center rounded-lg bg-primary py-3"
              disabled={isSubmitting}
              onPress={() => handleDecide("approved")}
            >
              {pendingDecision === "approved" ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text className="text-sm font-t3-bold text-primary-foreground">Approve</Text>
              )}
            </Pressable>
          </View>
        )
      ) : (
        <View
          className="absolute inset-x-0 flex-row items-center gap-3 border-t border-border bg-screen px-4 pt-3"
          style={{ bottom: 0, paddingBottom: insets.bottom + 12 }}
        >
          <Text className="flex-1 text-sm text-foreground-muted">
            {formatPlanReviewSelectionLabel(selection)}
          </Text>
          <Pressable
            accessibilityLabel={`Comment on ${formatPlanReviewSelectionLabel(selection).toLowerCase()}`}
            accessibilityRole="button"
            className="flex-row items-center gap-2 rounded-lg bg-primary px-4 py-3"
            onPress={handleOpenComposer}
          >
            <SymbolView name="text.bubble" size={14} tintColor={iconTint} type="monochrome" />
            <Text className="text-sm font-t3-bold text-primary-foreground">Comment</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function PlanReviewDiscussionList(props: {
  readonly environmentId: EnvironmentId;
  readonly documentId: string;
  readonly threads: ReturnType<typeof buildPlanReviewView>["threads"];
}) {
  const resolveDiscussion = useAtomCommand(
    planReviewEnvironment.resolveDiscussion,
    "plan review resolve discussion",
  );

  if (props.threads.length === 0) return null;

  return (
    <View className="mt-4 border-t border-border pt-4">
      <Text className="px-4 text-xs font-t3-bold uppercase text-foreground-muted">Comments</Text>
      {props.threads.map((thread) => (
        <View className="mt-3 px-4" key={thread.discussion.discussionId}>
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-foreground-muted">
              {thread.startIndex === null
                ? "Anchor no longer in the plan"
                : `Line ${thread.startIndex + 1}${
                    thread.endIndex !== null && thread.endIndex !== thread.startIndex
                      ? `-${thread.endIndex + 1}`
                      : ""
                  }`}
            </Text>
            {thread.discussion.isResolved ? (
              <Text className="text-xs text-foreground-muted">· resolved</Text>
            ) : null}
          </View>
          <View className="mt-1 rounded-md bg-subtle px-3 py-2">
            <Text className="font-t3-mono text-[11px] text-foreground-muted" numberOfLines={2}>
              {thread.discussion.quotedText}
            </Text>
          </View>
          {thread.comments.map((comment) => (
            <Text className="mt-2 text-sm leading-relaxed text-foreground" key={comment.commentId}>
              {comment.bodyMarkdown}
            </Text>
          ))}
          <Pressable
            accessibilityLabel={
              thread.discussion.isResolved ? "Reopen discussion" : "Resolve discussion"
            }
            accessibilityRole="button"
            accessibilityState={{ checked: thread.discussion.isResolved }}
            className="mt-2 self-start"
            hitSlop={8}
            onPress={() => {
              void resolveDiscussion({
                environmentId: props.environmentId,
                input: {
                  documentId: props.documentId,
                  discussionId: thread.discussion.discussionId,
                  isResolved: !thread.discussion.isResolved,
                },
              });
            }}
          >
            <Text className="text-xs font-t3-bold text-primary">
              {thread.discussion.isResolved ? "Reopen" : "Resolve"}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
