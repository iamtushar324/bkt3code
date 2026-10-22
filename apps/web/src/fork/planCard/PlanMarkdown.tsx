/**
 * T3-CUSTOM(expbkt3): the plan card's body, a drop-in for `ChatMarkdown`.
 *
 * Upstream's `ProposedPlanCard` imports this under the name `ChatMarkdown`, so
 * its JSX stays unchanged. Inside a timeline row it renders the plan the way
 * an assistant message renders: the same Markdown features (skills, runnable
 * shell commands, image preview, artifact templates), HTML parts as live
 * themed pages, and a citation source so a selection offers Cite and the
 * comment actions, with comment highlights painted back on the text.
 */
import { MessageId } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { type ComponentProps, use, useMemo } from "react";

import { AssistantCitationSource } from "../../components/chat/AssistantCitationSource";
import ChatMarkdown from "../../components/ChatMarkdown";
import { ThreadCommentMarks } from "../threadComments/threadCommentsSurface";
import { PlanCardContext } from "./planCardContext";
import { splitPlanSegments } from "./planContent";
import { PlanHtmlFrame } from "./PlanHtmlFrame";

export default function PlanMarkdown(props: ComponentProps<typeof ChatMarkdown>) {
  const card = use(PlanCardContext);
  const segments = useMemo(() => splitPlanSegments(props.text), [props.text]);
  const timeline = card?.timeline;
  const body = segments.map((segment, index) =>
    segment.kind === "html" ? (
      <PlanHtmlFrame key={`html-${index}`} html={segment.html} title={segment.title} />
    ) : (
      <ChatMarkdown
        key={`markdown-${index}`}
        {...(timeline
          ? {
              skills: timeline.skills,
              onRunShellCommand: timeline.onRunShellCommand,
              onImageExpand: timeline.onImageExpand,
              onUseArtifactTemplate: timeline.onUseArtifactTemplate,
            }
          : {})}
        lineBreaks={shouldPreserveAssistantLineBreaks(segment.text)}
        {...props}
        text={segment.text}
      />
    ),
  );
  if (!card || !timeline) return <>{body}</>;

  return (
    // Comment marks position against this box, and a collapsed card clips them
    // together with the text they mark. The start padding is the gutter that
    // their bars sit in, taken from the card's own padding.
    <div className="relative -ms-2 ps-2" data-plan-card-body>
      <AssistantCitationSource
        messageId={MessageId.make(card.plan.id)}
        {...(timeline.threadRef ? { threadRef: timeline.threadRef } : {})}
        itemKey={card.itemKey}
        request={timeline.citationRequest}
        listRef={timeline.listRef}
      >
        {body}
      </AssistantCitationSource>
      {timeline.threadRef ? (
        <ThreadCommentMarks threadRef={timeline.threadRef} messageId={card.plan.id} />
      ) : null}
    </div>
  );
}
