import { describe, expect, it } from "vite-plus/test";

import {
  isLongPressPointer,
  LONG_PRESS_AFTERMATH_MS,
  LONG_PRESS_DELAY_MS,
  LongPressGesture,
  movedBeyondTolerance,
} from "./longPressGesture";

type ScheduledRun = { readonly handle: number; readonly run: () => void; readonly delayMs: number };

function harness() {
  const opened: { x: number; y: number }[] = [];
  const triggeredBefore: number[] = [];
  let scheduled: ScheduledRun[] = [];
  let nextHandle = 1;
  let clock = 1_000;

  const gesture = new LongPressGesture({
    cancelScheduled: (handle) => {
      scheduled = scheduled.filter((entry) => entry.handle !== handle);
    },
    now: () => clock,
    onTriggered: () => {
      // Proves suppression can be armed before the menu exists to be tapped.
      triggeredBefore.push(opened.length);
    },
    openMenu: (position) => {
      opened.push({ x: position.x, y: position.y });
    },
    schedule: (run, delayMs) => {
      const handle = nextHandle++;
      scheduled.push({ delayMs, handle, run });
      return handle;
    },
  });

  return {
    advance: (ms: number) => {
      clock += ms;
    },
    gesture,
    get delays() {
      return scheduled.map((entry) => entry.delayMs);
    },
    get opened() {
      return opened;
    },
    get triggeredBefore() {
      return triggeredBefore;
    },
    runScheduled: () => {
      const pending = scheduled;
      scheduled = [];
      for (const entry of pending) entry.run();
    },
  };
}

function touch(overrides: Partial<Parameters<LongPressGesture["pointerDown"]>[0]> = {}) {
  return {
    clientX: 100,
    clientY: 200,
    isPrimary: true,
    pointerId: 1,
    pointerType: "touch",
    ...overrides,
  };
}

describe("isLongPressPointer", () => {
  it("tracks primary finger and pen presses", () => {
    expect(isLongPressPointer(touch())).toBe(true);
    expect(isLongPressPointer(touch({ pointerType: "pen" }))).toBe(true);
  });

  it("leaves the mouse to its own right-click menu", () => {
    expect(isLongPressPointer(touch({ pointerType: "mouse" }))).toBe(false);
  });

  it("ignores the second finger of a multi-touch gesture", () => {
    expect(isLongPressPointer(touch({ isPrimary: false }))).toBe(false);
  });
});

describe("movedBeyondTolerance", () => {
  it("allows fingertip jitter", () => {
    expect(movedBeyondTolerance({ x: 0, y: 0 }, { clientX: 5, clientY: 5 }, 10)).toBe(false);
  });

  it("rejects a drag", () => {
    expect(movedBeyondTolerance({ x: 0, y: 0 }, { clientX: 0, clientY: 24 }, 10)).toBe(true);
  });
});

describe("LongPressGesture", () => {
  it("opens the menu at the press origin once the press is held", () => {
    const h = harness();
    expect(h.gesture.pointerDown(touch({ clientX: 42, clientY: 84 }))).toBe(true);
    expect(h.delays).toEqual([LONG_PRESS_DELAY_MS]);

    h.runScheduled();

    expect(h.opened).toEqual([{ x: 42, y: 84 }]);
    // onTriggered ran while no menu was open yet.
    expect(h.triggeredBefore).toEqual([0]);
    expect(h.gesture.isPending).toBe(false);
  });

  it("does not track a mouse press", () => {
    const h = harness();
    expect(h.gesture.pointerDown(touch({ pointerType: "mouse" }))).toBe(false);
    expect(h.delays).toEqual([]);
    h.runScheduled();
    expect(h.opened).toEqual([]);
  });

  it("cancels when the press turns into a scroll", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.pointerMove(touch({ clientY: 240 }));
    h.runScheduled();
    expect(h.opened).toEqual([]);
  });

  it("ignores movement reported by a different pointer", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.pointerMove(touch({ clientY: 400, pointerId: 7 }));
    h.runScheduled();
    expect(h.opened).toHaveLength(1);
  });

  it("cancels when a second finger lands", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    expect(h.gesture.pointerDown(touch({ isPrimary: false, pointerId: 2 }))).toBe(false);
    h.runScheduled();
    expect(h.opened).toEqual([]);
    expect(h.gesture.isPending).toBe(false);
  });

  it("cancels on an early lift", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.pointerUp(touch());
    h.runScheduled();
    expect(h.opened).toEqual([]);
  });

  it("keeps waiting when an unrelated pointer lifts", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.pointerUp(touch({ pointerId: 9 }));
    h.runScheduled();
    expect(h.opened).toHaveLength(1);
  });

  it("yields to the platform's own long-press menu", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.cancelForNativeMenu();
    h.runScheduled();
    expect(h.opened).toEqual([]);
    // The platform suppresses its own trailing tap, so ours must not be armed.
    expect(h.gesture.consumeClickSuppression()).toBe(false);
  });

  it("swallows exactly one trailing tap after opening", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.runScheduled();

    expect(h.gesture.consumeClickSuppression()).toBe(true);
    expect(h.gesture.consumeClickSuppression()).toBe(false);
  });

  it("stops swallowing taps once the press is stale", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.runScheduled();
    h.advance(LONG_PRESS_AFTERMATH_MS + 1);

    expect(h.gesture.consumeClickSuppression()).toBe(false);
  });

  it("never arms tap suppression without opening a menu", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.pointerUp(touch());
    h.runScheduled();

    expect(h.gesture.consumeClickSuppression()).toBe(false);
  });

  it("drops a pending press on dispose", () => {
    const h = harness();
    h.gesture.pointerDown(touch());
    h.gesture.dispose();
    h.runScheduled();

    expect(h.opened).toEqual([]);
    expect(h.gesture.consumeClickSuppression()).toBe(false);
  });
});
