import { useEffect, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  LONG_PRESS_AFTERMATH_MS,
  LongPressGesture,
  type LongPressPointerSnapshot,
} from "./longPressGesture";

/**
 * Long-press-anything a phone cannot right-click. Spread the returned props on
 * the same element that carries `onContextMenu`, and pass the same menu opener:
 *
 * ```tsx
 * const longPressContextMenu = useLongPressContextMenu((position) =>
 *   onContextMenu(threadRef, position),
 * );
 * // ...
 * <div onContextMenu={handleContextMenu} {...longPressContextMenu} />
 * ```
 *
 * The element's own `onContextMenu` stays authoritative for mouse and trackpad;
 * this hook never sees a mouse pointer. The gesture machine and the reasons
 * behind each edge live in {@link LongPressGesture}.
 */

/**
 * A press on these has a native meaning worth more than the row's menu: text
 * selection, a caret, or the platform's own link sheet.
 */
const NATIVE_GESTURE_TARGETS =
  "input, textarea, select, a[href], [contenteditable=''], [contenteditable='true']";

export type LongPressContextMenuProps = {
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onPointerMove: (event: ReactPointerEvent) => void;
  readonly onPointerUp: (event: ReactPointerEvent) => void;
  readonly onPointerCancel: (event: ReactPointerEvent) => void;
  /** Styling hook: suppresses the platform callout and text selection on touch. */
  readonly "data-long-press-menu": "";
};

function snapshot(event: ReactPointerEvent): LongPressPointerSnapshot {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    isPrimary: event.isPrimary,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
  };
}

function requestHaptic(): void {
  // Android only — iOS Safari has no vibration API, and its absence is normal.
  try {
    navigator.vibrate?.(8);
  } catch {
    // A refused haptic must never cost the menu.
  }
}

type Controller = {
  readonly props: LongPressContextMenuProps;
  readonly dispose: () => void;
};

function createController(readOpenMenu: () => (position: { x: number; y: number }) => void) {
  let listening = false;
  let aftermathHandle: number | null = null;
  let swallowNextClick = false;

  const gesture = new LongPressGesture({
    cancelScheduled: (handle) => window.clearTimeout(handle),
    now: () => Date.now(),
    onTriggered: () => {
      // Armed before the menu paints: the finger is still down, and the click
      // it synthesises on lift would land on whatever the menu drew there.
      swallowNextClick = true;
      requestHaptic();
      aftermathHandle = window.setTimeout(stopListening, LONG_PRESS_AFTERMATH_MS);
    },
    openMenu: (position) => readOpenMenu()({ x: position.x, y: position.y }),
    schedule: (run, delayMs) => window.setTimeout(run, delayMs),
  });

  const onDocumentContextMenu = (event: Event) => {
    if (gesture.isPending) {
      // Chrome on Android beat our timer to it. Let its menu through — the
      // element's own onContextMenu opens exactly the menu we would have.
      gesture.cancelForNativeMenu();
      stopListening();
      return;
    }
    // Ours is already open, and the platform's event would open a second one.
    event.preventDefault();
    event.stopPropagation();
  };

  const onDocumentClick = (event: Event) => {
    if (!swallowNextClick || !gesture.consumeClickSuppression()) {
      swallowNextClick = false;
      return;
    }
    swallowNextClick = false;
    // Capture on the document, so this runs before React's root listener and
    // before the fallback menu's own buttons.
    event.preventDefault();
    event.stopPropagation();
    stopListening();
  };

  function startListening() {
    if (listening) return;
    listening = true;
    document.addEventListener("contextmenu", onDocumentContextMenu, true);
    document.addEventListener("click", onDocumentClick, true);
  }

  function stopListening() {
    if (aftermathHandle !== null) {
      window.clearTimeout(aftermathHandle);
      aftermathHandle = null;
    }
    swallowNextClick = false;
    if (!listening) return;
    listening = false;
    document.removeEventListener("contextmenu", onDocumentContextMenu, true);
    document.removeEventListener("click", onDocumentClick, true);
  }

  const endPress = (event: ReactPointerEvent) => {
    gesture.pointerUp(snapshot(event));
    // A menu that opened keeps the listeners until its aftermath window ends.
    if (aftermathHandle === null) stopListening();
  };

  const controller: Controller = {
    dispose: () => {
      gesture.dispose();
      stopListening();
    },
    props: {
      "data-long-press-menu": "",
      onPointerCancel: endPress,
      onPointerDown: (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(NATIVE_GESTURE_TARGETS) !== null) {
          gesture.cancel();
          return;
        }
        if (!gesture.pointerDown(snapshot(event))) {
          if (aftermathHandle === null) stopListening();
          return;
        }
        startListening();
      },
      onPointerMove: (event) => gesture.pointerMove(snapshot(event)),
      onPointerUp: endPress,
    },
  };
  return controller;
}

export function useLongPressContextMenu(
  openMenu: (position: { x: number; y: number }) => void,
): LongPressContextMenuProps {
  const openMenuRef = useRef(openMenu);
  useEffect(() => {
    openMenuRef.current = openMenu;
  }, [openMenu]);

  const controller = useMemo(() => createController(() => openMenuRef.current), []);
  useEffect(() => () => controller.dispose(), [controller]);

  return controller.props;
}
