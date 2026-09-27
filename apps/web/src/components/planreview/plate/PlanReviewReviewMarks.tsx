/**
 * T3-CUSTOM(expbkt3): the two marks that make a review readable at a glance.
 *
 * A commented span is highlighted so the reviewer can see what they annotated
 * without opening the rail, and a tracked edit is coloured the way every diff
 * in this app is: green for what an edit adds, red struck through for what it
 * removes.
 *
 * A comment highlight has three states, which is what tells the reviewer where
 * they are: the span being composed against is bright, a saved anchor is amber
 * and underlined, and a resolved one recedes to a hairline. The active state
 * pairs with the rail — hovering or selecting a card brightens its span here.
 *
 * State arrives through React context rather than plugin options: the focus
 * options Plate would carry this on are not exposed by the base `CommentPlugin`
 * config, and a leaf is already inside the provider's tree.
 */
import { PlateLeaf, type PlateLeafProps } from "platejs/react";
import { createContext, use, useMemo, type ReactNode } from "react";

import { cn } from "../../../lib/utils";

const COMMENT_KEY_PREFIX = "comment_";
const DRAFT_COMMENT_KEY = "comment_draft";

interface PlanReviewMarkState {
  readonly resolvedDiscussionIds: ReadonlySet<string>;
  readonly activeDiscussionId: string | null;
  readonly onSelectDiscussion: ((discussionId: string) => void) | null;
}

const PlanReviewMarkStateContext = createContext<PlanReviewMarkState>({
  resolvedDiscussionIds: new Set<string>(),
  activeDiscussionId: null,
  onSelectDiscussion: null,
});

export function PlanReviewMarkStateProvider({
  resolvedDiscussionIds,
  activeDiscussionId,
  onSelectDiscussion,
  children,
}: {
  readonly resolvedDiscussionIds: ReadonlySet<string>;
  readonly activeDiscussionId: string | null;
  readonly onSelectDiscussion: (discussionId: string) => void;
  readonly children: ReactNode;
}) {
  const value = useMemo(
    () => ({ resolvedDiscussionIds, activeDiscussionId, onSelectDiscussion }),
    [resolvedDiscussionIds, activeDiscussionId, onSelectDiscussion],
  );
  return (
    <PlanReviewMarkStateContext.Provider value={value}>
      {children}
    </PlanReviewMarkStateContext.Provider>
  );
}

/** Reads the discussion ids a leaf carries, ignoring the draft marker. */
function readDiscussionIds(leaf: object): ReadonlyArray<string> {
  return Object.keys(leaf).flatMap((key) =>
    key.startsWith(COMMENT_KEY_PREFIX) && key !== DRAFT_COMMENT_KEY
      ? [key.slice(COMMENT_KEY_PREFIX.length)]
      : [],
  );
}

export function CommentLeaf(props: PlateLeafProps) {
  const { resolvedDiscussionIds, activeDiscussionId, onSelectDiscussion } = use(
    PlanReviewMarkStateContext,
  );
  const leaf = props.leaf as unknown as Record<string, unknown>;
  const isDraft = leaf[DRAFT_COMMENT_KEY] === true;
  const discussionIds = readDiscussionIds(leaf);

  // Overlapping comments put several ids on one leaf. The newest wins the click
  // target, matching the rail's ordering.
  const discussionId = discussionIds.at(-1) ?? null;
  const isActive = discussionId !== null && discussionId === activeDiscussionId;
  // Only fully resolved spans recede; a span shared with an open discussion is
  // still something the reviewer needs to see.
  const isResolved =
    discussionIds.length > 0 && discussionIds.every((id) => resolvedDiscussionIds.has(id));

  return (
    <PlateLeaf
      {...props}
      className={cn(
        "rounded-[3px] transition-colors",
        isDraft
          ? "bg-yellow-300/45 text-foreground dark:bg-yellow-300/35"
          : isResolved
            ? "border-border border-b bg-transparent text-muted-foreground"
            : isActive
              ? "border-amber-400 border-b-2 bg-amber-300/40 dark:bg-amber-300/30"
              : "border-amber-400/60 border-b-2 bg-amber-300/15 hover:bg-amber-300/30",
      )}
      attributes={{
        ...props.attributes,
        ...(discussionId !== null && !isDraft
          ? {
              "data-plan-discussion-id": discussionId,
              onClick: () => onSelectDiscussion?.(discussionId),
            }
          : {}),
      }}
    >
      {props.children}
    </PlateLeaf>
  );
}

export function SuggestionLeaf(props: PlateLeafProps) {
  // `type: "remove"` marks text the reviewer deleted while suggesting; it stays
  // visible until the suggestion is accepted, which is the point of tracking.
  const data = (props.leaf as { suggestion?: { type?: string } }).suggestion;
  const isRemoval = data?.type === "remove";

  return (
    <PlateLeaf
      {...props}
      className={cn(
        "transition-colors",
        isRemoval
          ? "bg-red-500/15 text-red-700 line-through dark:text-red-300"
          : "bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}
