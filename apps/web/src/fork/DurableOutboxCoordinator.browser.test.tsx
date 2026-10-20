// T3-CUSTOM(expbkt3): exercise actual delivery across composer route changes.
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatAttachment,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  resetThreadOutboxDeliveries,
  type QueuedThreadMessage,
  type ThreadSettingsSnapshot,
} from "@t3tools/client-runtime/outbox";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { DurableStartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act, render, type Screen } from "../../test/render";
import { DurableOutboxCoordinator } from "./DurableOutboxCoordinator";
import { useDurableThreadOutbox } from "./useDurableThreadOutbox";
import { startAttachmentUpload } from "../lib/attachmentUploadQueue";

type SendInput = {
  readonly environmentId: EnvironmentId;
  readonly input: DurableStartThreadTurnInput;
};
const state = vi.hoisted(() => ({
  connected: false,
  identityKey: "user-1",
  items: [] as ReadonlyArray<QueuedThreadMessage>,
  threads: new Map<string, ThreadSettingsSnapshot>(),
  uploaded: [] as ReadonlyArray<ChatAttachment>,
  send: vi.fn<(value: SendInput) => Promise<AtomCommandResult<number, unknown>>>(),
  discard: vi.fn<(value: QueuedThreadMessage) => Promise<AtomCommandResult<void, unknown>>>(),
  fail: vi.fn<(value: QueuedThreadMessage) => Promise<AtomCommandResult<void, unknown>>>(),
}));

// These factories replace the state modules outright instead of spreading the originals:
// the coordinator reads only these members, and the real modules build live atoms.
vi.mock(import("@effect/atom-react"), async () => {
  const { createContext } = await import("react");
  return {
    RegistryContext: createContext({ get: () => null }) as never,
    useAtomValue: ((atom: { readonly kind?: string }) => {
      if (atom.kind === "outbox") return state.items;
      if (atom.kind === "shell") return { status: "live" };
      if (atom.kind === "threads") return state.threads;
      return [];
    }) as never,
  };
});
vi.mock(import("../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: [{ environmentId: "environment-1", entry: { enabled: true } }],
  })) as never,
  useEnvironment: (() => ({
    connection: { phase: state.connected ? "connected" : "disconnected" },
  })) as never,
}));
vi.mock(import("../state/identity"), () => ({
  useCurrentUserId: (() => state.identityKey) as never,
}));
vi.mock(import("../state/shell"), () => ({
  environmentShell: { stateValueAtom: () => ({ kind: "shell" }) } as never,
}));
vi.mock(import("../state/threads"), () => ({
  durableThreadOutbox: { itemsValueAtom: () => ({ kind: "outbox" }) } as never,
  environmentThreadShells: { environmentThreadIndexAtom: () => ({ kind: "threads" }) } as never,
  environmentThreadDetails: { threadAtom: () => ({ kind: "detail" }) } as never,
  threadEnvironment: { startTurn: "send", discardOutbox: "discard", queueOutbox: "fail" } as never,
}));
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: ((command: "send" | "discard" | "fail") => state[command]) as never,
}));
vi.mock(import("../lib/attachmentUploadQueue"), async (original) => ({
  ...(await original()),
  awaitAttachmentUploads: vi.fn(async () => undefined),
  getUploadedAttachments: vi.fn(() => state.uploaded) as never,
  readAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
  startAttachmentUpload: vi.fn(),
}));

const environmentId = EnvironmentId.make("environment-1");
const settings: ThreadSettingsSnapshot = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "plan",
};
const queued = (id: string, overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId,
  identityKey: "user-1",
  threadId: ThreadId.make(`thread-${id}`),
  messageId: MessageId.make(`message-${id}`),
  commandId: CommandId.make(`command-${id}`),
  text: `Continue ${id}`,
  attachments: [],
  createdAt: "2026-10-03T10:00:00.000Z",
  ...overrides,
});
let screen: Screen | null = null;
let visibleItems: ReadonlyArray<QueuedThreadMessage> = [];
const reportVisibleItems = (items: ReadonlyArray<QueuedThreadMessage>) => {
  visibleItems = items;
};
function Host({
  selectedRef,
  onItems,
}: {
  readonly selectedRef: ScopedThreadRef | null;
  readonly onItems: (items: ReadonlyArray<QueuedThreadMessage>) => void;
}) {
  const { items } = useDurableThreadOutbox(selectedRef, state.identityKey);
  useEffect(() => {
    onItems(items);
  }, [items, onItems]);
  return <DurableOutboxCoordinator />;
}
async function navigate(threadId: ThreadId | null) {
  const selectedRef = threadId === null ? null : { environmentId, threadId };
  const host = <Host selectedRef={selectedRef} onItems={reportVisibleItems} />;
  if (screen === null) screen = await render(host, { router: false });
  else await screen.rerender(host);
  await act(() => vi.advanceTimersByTimeAsync(0));
}
beforeEach(() => {
  vi.useFakeTimers();
  visibleItems = [];
  resetThreadOutboxDeliveries();
  state.connected = false;
  state.identityKey = "user-1";
  state.items = [];
  state.threads = new Map();
  state.uploaded = [];
  vi.mocked(startAttachmentUpload).mockClear();
  state.send.mockReset().mockResolvedValue(AsyncResult.success(1));
  state.discard.mockReset().mockImplementation(async (message) => {
    state.items = state.items.filter((item) => item.messageId !== message.messageId);
    return AsyncResult.success(undefined);
  });
  state.fail.mockReset().mockImplementation(async (message) => {
    state.items = state.items.map((item) =>
      item.messageId === message.messageId ? message : item,
    );
    return AsyncResult.success(undefined);
  });
});
afterEach(async () => {
  await screen?.[Symbol.asyncDispose]();
  screen = null;
  vi.useRealTimers();
});

it.each(["another thread", "a draft"])(
  "delivers a queued turn after navigation to %s and reconnect",
  async (route) => {
    const a = queued("a");
    const b = queued("b");
    state.items = [a];
    state.threads = new Map([
      [a.threadId, settings],
      [b.threadId, settings],
    ]);
    await navigate(a.threadId);
    expect(visibleItems).toEqual([a]);
    await navigate(route === "a draft" ? null : b.threadId);
    expect(visibleItems).toEqual([]);
    expect(state.send).not.toHaveBeenCalled();
    state.connected = true;
    await navigate(route === "a draft" ? null : b.threadId);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      input: {
        commandId: a.commandId,
        threadId: a.threadId,
        message: { messageId: a.messageId, text: a.text },
        ...settings,
      },
    });
    expect(state.items).toEqual([]);
  },
);

it("sends a saved first-turn bootstrap from a draft without a thread shell", async () => {
  const message = queued("new", {
    bootstrap: {
      createThread: {
        projectId: ProjectId.make("project-1"),
        title: "First turn",
        ...settings,
        branch: null,
        worktreePath: null,
        createdAt: "2026-10-03T09:59:00.000Z",
      },
    },
  });
  state.items = [message];
  state.connected = true;
  await navigate(null);
  expect(state.send).toHaveBeenCalledTimes(1);
  expect(state.send.mock.calls[0]?.[0]).toMatchObject({
    environmentId,
    input: {
      commandId: message.commandId,
      threadId: message.threadId,
      bootstrap: message.bootstrap,
      message: { messageId: message.messageId, text: message.text },
      ...settings,
    },
  });
  expect(state.items).toEqual([]);
});

it("retries a fulfilled transport Failure with the saved IDs after navigation", async () => {
  const message = queued("a");
  state.items = [message];
  state.threads = new Map([[message.threadId, settings]]);
  state.connected = true;
  state.send.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "RpcClientError", message: "An error occurred during Read" }),
    ),
  );
  await navigate(message.threadId);
  await navigate(null);
  expect(state.send).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(state.send).toHaveBeenCalledTimes(2);
  expect(state.send.mock.calls[1]?.[0]).toEqual(state.send.mock.calls[0]?.[0]);
  expect(state.items).toEqual([]);
});

it("does not send the previous account's saved payload after an identity change", async () => {
  const message = queued("a");
  state.items = [message];
  state.threads = new Map([[message.threadId, settings]]);
  await navigate(message.threadId);
  state.identityKey = "user-2";
  state.connected = true;
  await navigate(null);
  expect(state.send).not.toHaveBeenCalled();
  expect(state.items).toEqual([message]);
});

it("keeps image context bound to its saved ID through inline replay", async () => {
  const image = {
    id: "composer-image",
    type: "image" as const,
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 4,
    dataUrl: "data:image/png;base64,dGVzdA==",
  };
  const message = queued("image", {
    attachments: [image],
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("image_context"),
          kind: "image",
          label: image.name,
          attachmentId: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        },
      ],
    },
  });
  state.items = [message];
  state.threads = new Map([[message.threadId, settings]]);
  state.connected = true;
  await navigate(null);
  const sent = state.send.mock.calls[0]?.[0].input.message;
  expect(sent?.attachments[0]).toMatchObject({ id: image.id, dataUrl: image.dataUrl });
  expect(sent?.context?.records[0]).toMatchObject({ attachmentId: sent?.attachments[0]?.id });
  expect(state.items).toEqual([]);
});

it("reuploads saved file bytes and remaps its context to the new server asset", async () => {
  const file = {
    id: "composer-file",
    type: "file" as const,
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    dataUrl: "data:text/plain;base64,dGVzdA==",
  };
  const message = queued("file", {
    attachments: [file],
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("file_context"),
          kind: "file",
          label: file.name,
          attachmentId: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        },
      ],
    },
  });
  state.items = [message];
  state.threads = new Map([[message.threadId, settings]]);
  state.uploaded = [
    {
      id: "new-uploaded-asset",
      type: "file",
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    },
  ];
  state.connected = true;
  await navigate(null);
  const uploaded = vi.mocked(startAttachmentUpload).mock.calls[0]?.[0].image;
  expect(await uploaded?.file?.text()).toBe("test");
  const sent = state.send.mock.calls[0]?.[0].input.message;
  expect(sent?.attachments[0]).toMatchObject({ id: "new-uploaded-asset", type: "file" });
  expect(sent?.context?.records[0]).toMatchObject({ attachmentId: "new-uploaded-asset" });
  expect(state.items).toEqual([]);
});
