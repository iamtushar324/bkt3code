import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
// T3-CUSTOM(expbkt3): fork actions (review comments) share the selection toolbar.
import type { AssistantSelectionToolbarExtras } from "~/fork/threadComments/selectionToolbarExtras";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
  // T3-CUSTOM(expbkt3): fork actions rendered beside Cite, inside the same action element.
  extraActions: ExtraActions,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  // T3-CUSTOM(expbkt3): fork actions rendered beside Cite, inside the same action element.
  extraActions?: AssistantSelectionToolbarExtras;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  // T3-CUSTOM(expbkt3): the group wraps Cite and the fork actions; it is what gets positioned.
  const groupRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = groupRef.current; // T3-CUSTOM(expbkt3): position the group, not the button.
    if (!toolbar || !selection) return;
    // T3-CUSTOM(expbkt3): BEGIN re-clamp when the fork's comment editor grows the group.
    const place = () => {
      const rect = toolbar.getBoundingClientRect();
      toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
      toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(toolbar);
    return () => observer.disconnect();
    // T3-CUSTOM(expbkt3): END
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => groupRef.current, // T3-CUSTOM(expbkt3): the group is the action element.
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        (groupRef.current ?? toolbar).contains(event.target as Node) // T3-CUSTOM(expbkt3): fork actions count as inside.
      ) {
        return;
      }
      if (toolbar.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    // T3-CUSTOM(expbkt3): BEGIN — the group carries the position and hosts the fork actions.
    <div
      ref={groupRef}
      className="fixed z-50 flex w-max max-w-[calc(100vw-1rem)] flex-wrap items-center gap-1"
      style={{ left: selection.position.x, top: selection.position.y }}
    >
      <Button
        ref={toolbarRef}
        type="button"
        size="xs"
        variant="glass"
        disabled={tooLong}
        aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={cite}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            dismiss();
          }
        }}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {tooLong ? "Shorten selection" : "Cite"}
      </Button>
      {ExtraActions ? (
        <ExtraActions
          citation={selection.citation}
          sourceAnchor={selection.sourceAnchor}
          threadRef={threadRef}
          dismiss={dismiss}
        />
      ) : null}
    </div>,
    // T3-CUSTOM(expbkt3): END
    document.body,
  );
}
