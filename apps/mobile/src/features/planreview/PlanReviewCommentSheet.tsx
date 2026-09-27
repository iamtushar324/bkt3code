// T3-CUSTOM(expbkt3): composer for a plan-review discussion on mobile.
//
// A separate route rather than an inline sheet, matching the diff reviewer's
// comment composer: the keyboard needs the whole screen on a phone, and Android
// cannot host a keyboard-driven composer inside a formSheet.
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { nextPlanDiscussionId } from "@t3tools/client-runtime/state/planReviewMarkdown";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { planReviewEnvironment } from "../../state/planReview";
import { useAtomCommand } from "../../state/use-atom-command";
import { clearPlanReviewSelection, usePlanReviewSelection } from "./planReviewSelection";
import { formatPlanReviewSelectionLabel } from "./planReviewSelection";

const QUOTE_PREVIEW_MAX_LINES = 6;

type PlanReviewCommentSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly documentId: string;
}>;

export function PlanReviewCommentSheet(props: PlanReviewCommentSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const selection = usePlanReviewSelection();
  const { environmentId, documentId } = props.route.params;
  const [body, setBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upsertDiscussion = useAtomCommand(
    planReviewEnvironment.upsertDiscussion,
    "plan review upsert discussion",
  );

  const quoteLines = useMemo(
    () => (selection ? selection.quotedText.split("\n") : []),
    [selection],
  );
  const canSubmit = body.trim().length > 0 && selection !== null && !isSaving;

  const dismiss = useCallback(() => {
    clearPlanReviewSelection();
    navigation.goBack();
  }, [navigation]);

  const handleSubmit = useCallback(() => {
    if (selection === null || body.trim().length === 0) return;
    setIsSaving(true);
    setError(null);
    void upsertDiscussion({
      environmentId,
      input: {
        documentId,
        discussionId: nextPlanDiscussionId(),
        quotedText: selection.quotedText,
        bodyMarkdown: body.trim(),
      },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          // Keep the text: the reviewer's words are the expensive part.
          setError("The comment could not be saved. Try again.");
          return;
        }
        dismiss();
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [body, dismiss, documentId, environmentId, selection, upsertDiscussion]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="flex-1 bg-screen"
    >
      <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <Pressable
            // T3-CUSTOM(expbkt3): keep route actions visible to native accessibility.
            accessible
            accessibilityLabel="Cancel comment"
            accessibilityRole="button"
            hitSlop={8}
            onPress={dismiss}
          >
            <Text className="text-base text-foreground-muted">Cancel</Text>
          </Pressable>
          <Text className="text-base font-t3-bold text-foreground">Comment</Text>
          <Pressable
            accessible
            accessibilityLabel="Save comment"
            accessibilityRole="button"
            accessibilityState={{ busy: isSaving, disabled: !canSubmit }}
            disabled={!canSubmit}
            hitSlop={8}
            onPress={handleSubmit}
          >
            {isSaving ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text
                className={cn(
                  "text-base font-t3-bold",
                  canSubmit ? "text-primary" : "text-foreground-muted",
                )}
              >
                Save
              </Text>
            )}
          </Pressable>
        </View>

        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
          {selection === null ? (
            <View className="px-4 py-6">
              <Text className="text-sm text-foreground-muted">
                The selection was lost. Go back and pick the lines again.
              </Text>
            </View>
          ) : (
            <>
              <View className="border-b border-border px-4 py-3">
                <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
                  {formatPlanReviewSelectionLabel(selection)}
                </Text>
                <View className="mt-2 rounded-md bg-subtle px-3 py-2">
                  {quoteLines.slice(0, QUOTE_PREVIEW_MAX_LINES).map((line, index) => (
                    <Text
                      className="font-t3-mono text-xs leading-relaxed text-foreground"
                      // Identical lines are common in a plan, so the plan's own
                      // line number is the only stable identity here.
                      key={`line-${selection.startIndex + index}`}
                      numberOfLines={1}
                    >
                      {line.length > 0 ? line : " "}
                    </Text>
                  ))}
                  {quoteLines.length > QUOTE_PREVIEW_MAX_LINES ? (
                    <Text className="mt-1 text-xs text-foreground-muted">
                      +{quoteLines.length - QUOTE_PREVIEW_MAX_LINES} more lines
                    </Text>
                  ) : null}
                </View>
              </View>

              <TextInput
                autoFocus
                className="px-4 py-3 text-base leading-relaxed text-foreground"
                multiline
                onChangeText={setBody}
                placeholder="What should change here?"
                style={{ minHeight: 140 }}
                textAlignVertical="top"
                value={body}
              />

              {error === null ? null : (
                <View className="px-4 pb-4">
                  <Text className="text-sm text-destructive">{error}</Text>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
