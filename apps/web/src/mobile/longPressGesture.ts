/**
 * Touch long-press → context menu, as a DOM-free state machine.
 *
 * Phones have no right-click, so every row action behind `onContextMenu` is
 * unreachable on a phone. A press held still for {@link LONG_PRESS_DELAY_MS}
 * stands in for it. The gesture only ever tracks finger and pen pointers: a
 * mouse keeps its native menu, and desktop behaviour is untouched.
 *
 * Three platform details drive the shape of this machine, and each one is a
 * bug if it is missed:
 *
 * - A press that moves is a scroll, not a menu. Movement past
 *   {@link LONG_PRESS_MOVE_TOLERANCE_PX} cancels, and so does a second finger.
 * - Lifting the finger after a long press still synthesises a `click`, which
 *   would activate the row underneath — or, worse, whichever menu item the
 *   menu just painted under the fingertip. The caller swallows exactly one
 *   click; {@link LongPressGesture.consumeClickSuppression} is that latch.
 * - Chrome on Android fires its own `contextmenu` at ~500ms. Whichever fires
 *   first wins and the other must be dropped, or the user gets two menus.
 *   {@link LongPressGesture.cancelForNativeMenu} is the "platform won" edge.
 */

/** iOS uses ~500ms for its own callout; landing just under it feels immediate without firing mid-scroll. */
export const LONG_PRESS_DELAY_MS = 450;
/** Roughly a fingertip's jitter while holding still. Anything further is a scroll. */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** How long a triggered press keeps swallowing the platform's trailing tap. */
export const LONG_PRESS_AFTERMATH_MS = 700;

export type LongPressPointerSnapshot = {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
};

export type LongPressGestureDeps = {
  readonly now: () => number;
  readonly schedule: (run: () => void, delayMs: number) => number;
  readonly cancelScheduled: (handle: number) => void;
  /** Called once the press has been held. Position is where the finger went down. */
  readonly openMenu: (position: { readonly x: number; readonly y: number }) => void;
  /**
   * Runs immediately before {@link openMenu}, so the caller can arm its tap
   * suppression before the menu exists to be tapped.
   */
  readonly onTriggered?: () => void;
  readonly delayMs?: number;
  readonly moveTolerancePx?: number;
  readonly aftermathMs?: number;
};

type PendingPress = {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly handle: number;
};

/** Fingers and pens get the gesture; a mouse already has a right button. */
export function isLongPressPointer(pointer: LongPressPointerSnapshot): boolean {
  if (!pointer.isPrimary) return false;
  return pointer.pointerType === "touch" || pointer.pointerType === "pen";
}

export function movedBeyondTolerance(
  start: { readonly x: number; readonly y: number },
  next: { readonly clientX: number; readonly clientY: number },
  tolerancePx: number = LONG_PRESS_MOVE_TOLERANCE_PX,
): boolean {
  const dx = next.clientX - start.x;
  const dy = next.clientY - start.y;
  return dx * dx + dy * dy > tolerancePx * tolerancePx;
}

export class LongPressGesture {
  readonly #deps: LongPressGestureDeps;
  #pending: PendingPress | null = null;
  /** When the menu was opened from a long press, so the trailing tap can be dropped. */
  #armedAt: number | null = null;

  constructor(deps: LongPressGestureDeps) {
    this.#deps = deps;
  }

  get isPending(): boolean {
    return this.#pending !== null;
  }

  /**
   * Starts tracking a press. Returns whether this pointer is a long-press
   * candidate, which is the caller's signal to attach its document listeners.
   */
  pointerDown(pointer: LongPressPointerSnapshot): boolean {
    // A second finger is a pinch or a two-finger scroll, never a menu.
    if (this.#pending !== null) {
      this.cancel();
      return false;
    }
    if (!isLongPressPointer(pointer)) return false;

    const handle = this.#deps.schedule(() => {
      this.#fire();
    }, this.#deps.delayMs ?? LONG_PRESS_DELAY_MS);
    this.#pending = {
      handle,
      pointerId: pointer.pointerId,
      x: pointer.clientX,
      y: pointer.clientY,
    };
    return true;
  }

  pointerMove(pointer: LongPressPointerSnapshot): void {
    const pending = this.#pending;
    if (pending === null || pending.pointerId !== pointer.pointerId) return;
    if (movedBeyondTolerance(pending, pointer, this.#deps.moveTolerancePx)) {
      this.cancel();
    }
  }

  /** Lifting or losing the pointer ends the wait; an already-open menu is unaffected. */
  pointerUp(pointer?: LongPressPointerSnapshot): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (pointer !== undefined && pending.pointerId !== pointer.pointerId) return;
    this.cancel();
  }

  /**
   * The platform is opening its own context menu for this press. Drop ours so
   * the two do not stack; the platform's menu suppresses its own trailing tap.
   */
  cancelForNativeMenu(): void {
    this.cancel();
  }

  cancel(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#deps.cancelScheduled(pending.handle);
  }

  /**
   * True at most once per triggered press, for the `click` the platform
   * synthesises when the finger lifts.
   */
  consumeClickSuppression(): boolean {
    const armedAt = this.#armedAt;
    if (armedAt === null) return false;
    this.#armedAt = null;
    return this.#deps.now() - armedAt <= (this.#deps.aftermathMs ?? LONG_PRESS_AFTERMATH_MS);
  }

  dispose(): void {
    this.cancel();
    this.#armedAt = null;
  }

  #fire(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#armedAt = this.#deps.now();
    // Before the menu exists: the caller arms tap suppression here, and the
    // menu is about to paint under the fingertip.
    this.#deps.onTriggered?.();
    this.#deps.openMenu({ x: pending.x, y: pending.y });
  }
}
