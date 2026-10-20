// T3-CUSTOM(expbkt3): an async (message-mode) question says the agent keeps working.
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("async-question"),
  createdAt: "2026-08-15T00:00:00.000Z",
  dismissible: true,
  responseCapability: "live" as const,
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPanel(dismissible: boolean) {
  await act(async () =>
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...prompt, dismissible }]}
        cwd="/repo"
        threadRef={threadRef}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
    ),
  );
}

describe("ComposerPendingUserInputPanel async questions", () => {
  it("marks a message-mode question as async without a blocking state", async () => {
    await renderPanel(true);

    expect(container.textContent).toContain("Async");
    expect(container.textContent).toContain("Agent can continue while you decide.");
  });

  it("keeps a blocking question free of the async hint", async () => {
    await renderPanel(false);

    expect(container.textContent).not.toContain("Async");
    expect(container.textContent).not.toContain("Agent can continue while you decide.");
  });
});
