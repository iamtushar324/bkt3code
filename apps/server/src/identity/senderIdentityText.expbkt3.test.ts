// T3-CUSTOM(expbkt3): proves the one identity text every provider receives.
import { ProviderDriverKind } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";

import { withSenderIdentityTurnInput } from "../orchestration-v2/senderIdentityTurnInput.expbkt3.ts";
import { buildSessionIdentityEnvironment } from "./SessionIdentityEnvironment.ts";
import { appendSenderIdentityText, senderIdentityText } from "./senderIdentityText.ts";

const WARNING =
  "The context section titled `# userEmail`, Git identity and the operating-system user describe the shared machine or the rotating Claude subscription, not the person. Never use them for attribution.";
const alice = { userId: "user_clerk_alice", name: "Alice Example", email: "alice@example.com" };
const bob = { userId: "user_clerk_bob", name: "Bob Example", email: "bob@example.com" };

describe("senderIdentityText", () => {
  it("names the human sender and the session owner", () => {
    assert.equal(
      senderIdentityText(buildSessionIdentityEnvironment({ owner: alice, sender: bob })),
      [
        "CURRENT USER (from the T3 Clerk login; authoritative for this message):",
        "- Name: Bob Example",
        "- Email: bob@example.com",
        "- T3 user id: user_clerk_bob",
        "Session owner: Alice Example <alice@example.com>",
        WARNING,
      ].join("\n"),
    );
  });

  it("says no human sent an automation message and never guesses one", () => {
    assert.equal(
      senderIdentityText(buildSessionIdentityEnvironment({ owner: alice, sender: null })),
      [
        "CURRENT USER: no human sender for this message (automation). Session owner: Alice Example <alice@example.com>",
        "Do not guess who sent this message. If a task needs a person, name the session owner and say that no human sent this message.",
        WARNING,
      ].join("\n"),
    );
  });

  it("marks a name the Clerk profile does not set", () => {
    const text = senderIdentityText(
      buildSessionIdentityEnvironment({
        owner: { ...alice, name: null },
        sender: { ...bob, name: "  " },
      }),
    );
    assert.include(
      text!,
      "- Name: unknown (not set in the Clerk profile)\n- Email: bob@example.com",
    );
    assert.include(text!, "Session owner: alice@example.com\n");
  });

  it("keeps a sender with no directory record as a human by user id", () => {
    const text = senderIdentityText(
      buildSessionIdentityEnvironment({
        owner: null,
        sender: { userId: "user_clerk_carol", name: null, email: null },
      }),
    );
    assert.include(text!, "- T3 user id: user_clerk_carol");
    assert.include(text!, "- Email: unknown (not set in the Clerk profile)");
    assert.include(text!, "Session owner: unknown");
  });

  it("does not change sessions outside T3 Code", () => {
    assert.isUndefined(senderIdentityText({ BK_SENDER_EMAIL: "bob@example.com" }));
  });
});

describe("appendSenderIdentityText", () => {
  it("appends a tagged block and leaves slash commands intact", () => {
    assert.equal(
      appendSenderIdentityText("hi", "ID"),
      "hi\n\n<t3_current_user>\nID\n</t3_current_user>",
    );
    assert.equal(appendSenderIdentityText(" /compact", "ID"), " /compact");
    assert.equal(appendSenderIdentityText("hi", undefined), "hi");
  });
});

describe("withSenderIdentityTurnInput", () => {
  const identityEnvironment = buildSessionIdentityEnvironment({ owner: alice, sender: bob });
  const input = {
    message: { text: "who am I?" },
  } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;

  it("appends the identity to the provider input of adapters without a native channel", () => {
    for (const driver of ["opencode", "cursor", "acpRegistry", "pi", "grok", "antigravity"]) {
      const result = withSenderIdentityTurnInput(
        input,
        ProviderDriverKind.make(driver),
        identityEnvironment,
      );
      assert.equal(
        result.message.text,
        appendSenderIdentityText("who am I?", senderIdentityText(identityEnvironment)),
      );
      assert.include(result.message.text, "- Name: Bob Example");
    }
    assert.equal(input.message.text, "who am I?");
  });

  it("leaves Claude, Codex and remote turns to their own channels", () => {
    for (const driver of ["claudeAgent", "codex", "remote"]) {
      assert.equal(
        withSenderIdentityTurnInput(input, ProviderDriverKind.make(driver), identityEnvironment),
        input,
      );
    }
    assert.equal(
      withSenderIdentityTurnInput(input, ProviderDriverKind.make("opencode"), undefined),
      input,
    );
  });
});
