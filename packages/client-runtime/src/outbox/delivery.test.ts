import { beforeEach, describe, expect, it } from "@effect/vitest";

import {
  beginThreadOutboxDelivery,
  isThreadOutboxDeliveryDelivered,
  isThreadOutboxDeliveryInFlight,
  resetThreadOutboxDeliveries,
  selectThreadOutboxReplay,
  settleThreadOutboxDelivery,
  threadOutboxDeliveryKey,
} from "./delivery.ts";

const ref = (messageId: string, identityKey: string | undefined = "user-1") => ({
  environmentId: "env-1",
  identityKey,
  messageId,
});

describe("thread outbox delivery registry", () => {
  beforeEach(() => {
    resetThreadOutboxDeliveries();
  });

  it("reports a dispatch as in flight until it settles", () => {
    const key = threadOutboxDeliveryKey(ref("message-1"));
    beginThreadOutboxDelivery(key);

    expect(isThreadOutboxDeliveryInFlight(ref("message-1"))).toBe(true);
    expect(isThreadOutboxDeliveryDelivered(ref("message-1"))).toBe(false);

    settleThreadOutboxDelivery(key, true);

    expect(isThreadOutboxDeliveryInFlight(ref("message-1"))).toBe(false);
    expect(isThreadOutboxDeliveryDelivered(ref("message-1"))).toBe(true);
  });

  it("forgets a rejected dispatch so retry and reconnect replay still work", () => {
    const key = threadOutboxDeliveryKey(ref("message-1"));
    beginThreadOutboxDelivery(key);
    settleThreadOutboxDelivery(key, false);

    expect(isThreadOutboxDeliveryInFlight(ref("message-1"))).toBe(false);
    expect(isThreadOutboxDeliveryDelivered(ref("message-1"))).toBe(false);
  });

  it("keeps environments and accounts apart", () => {
    settleThreadOutboxDelivery(threadOutboxDeliveryKey(ref("message-1")), true);

    expect(isThreadOutboxDeliveryDelivered(ref("message-1", "user-2"))).toBe(false);
    expect(
      isThreadOutboxDeliveryDelivered({
        environmentId: "env-2",
        identityKey: "user-1",
        messageId: "message-1",
      }),
    ).toBe(false);
  });

  it("bounds the delivered history so a long-lived tab cannot grow it forever", () => {
    for (let index = 0; index < 300; index += 1) {
      settleThreadOutboxDelivery(threadOutboxDeliveryKey(ref(`message-${index}`)), true);
    }

    expect(isThreadOutboxDeliveryDelivered(ref("message-0"))).toBe(false);
    expect(isThreadOutboxDeliveryDelivered(ref("message-299"))).toBe(true);
  });
});

const row = (
  messageId: string,
  overrides: {
    readonly deliveryState?: "pending" | "failed";
    readonly createdAt?: string;
  } = {},
) => ({
  environmentId: "env-1",
  identityKey: "user-1",
  messageId,
  createdAt: overrides.createdAt ?? "2026-09-01T11:43:00.000Z",
  ...(overrides.deliveryState === undefined ? {} : { deliveryState: overrides.deliveryState }),
});

describe("thread outbox replay selection", () => {
  beforeEach(() => {
    resetThreadOutboxDeliveries();
  });

  it("sends the oldest queued row", () => {
    const older = row("message-1", { createdAt: "2026-09-01T11:40:00.000Z" });
    const newer = row("message-2", { createdAt: "2026-09-01T11:43:00.000Z" });

    const selection = selectThreadOutboxReplay({
      items: [newer, older],
      identityKey: "user-1",
      replayingMessageIds: new Set(),
    });

    expect(selection.next).toBe(older);
    expect(selection.stale).toEqual([]);
  });

  it("leaves a row alone while its own dispatch is on the wire", () => {
    beginThreadOutboxDelivery(threadOutboxDeliveryKey(ref("message-1")));

    const selection = selectThreadOutboxReplay({
      items: [row("message-1")],
      identityKey: "user-1",
      replayingMessageIds: new Set(),
    });

    expect(selection.next).toBeUndefined();
    expect(selection.stale).toEqual([]);
  });

  it("discards a row whose turn was already delivered instead of resending it", () => {
    settleThreadOutboxDelivery(threadOutboxDeliveryKey(ref("message-1")), true);
    const delivered = row("message-1");

    const selection = selectThreadOutboxReplay({
      items: [delivered],
      identityKey: "user-1",
      replayingMessageIds: new Set(),
    });

    expect(selection.next).toBeUndefined();
    expect(selection.stale).toEqual([delivered]);
  });

  it("still sends a row whose dispatch was rejected", () => {
    const key = threadOutboxDeliveryKey(ref("message-1"));
    beginThreadOutboxDelivery(key);
    settleThreadOutboxDelivery(key, false);
    const rejected = row("message-1");

    const selection = selectThreadOutboxReplay({
      items: [rejected],
      identityKey: "user-1",
      replayingMessageIds: new Set(),
    });

    expect(selection.next).toBe(rejected);
    expect(selection.stale).toEqual([]);
  });

  it("skips rows the replay loop already has on the wire and rows marked failed", () => {
    const selection = selectThreadOutboxReplay({
      items: [row("message-1"), row("message-2", { deliveryState: "failed" })],
      identityKey: "user-1",
      replayingMessageIds: new Set(["message-1"]),
    });

    expect(selection.next).toBeUndefined();
    expect(selection.stale).toEqual([]);
  });

  it("falls back to the current identity for legacy rows that omit one", () => {
    settleThreadOutboxDelivery(
      threadOutboxDeliveryKey({
        environmentId: "env-1",
        identityKey: "user-1",
        messageId: "message-1",
      }),
      true,
    );
    const legacy = {
      environmentId: "env-1",
      messageId: "message-1",
      createdAt: "2026-09-01T11:43:00.000Z",
    };

    const selection = selectThreadOutboxReplay({
      items: [legacy],
      identityKey: "user-1",
      replayingMessageIds: new Set(),
    });

    expect(selection.next).toBeUndefined();
    expect(selection.stale).toEqual([legacy]);
  });
});
