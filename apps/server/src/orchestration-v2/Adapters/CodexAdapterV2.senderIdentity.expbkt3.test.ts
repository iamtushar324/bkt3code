// T3-CUSTOM(expbkt3): proves Codex turns carry the Clerk sender identity block.
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { senderIdentityText } from "../../identity/senderIdentityText.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const senderIdentity = senderIdentityText({
  BK_IDENTITY_RUNTIME: "t3-code",
  BK_SENDER_NAME: "Bob Example",
  BK_SENDER_EMAIL: "bob@example.com",
  BK_SENDER_USER_ID: "user_clerk_bob",
  BK_OWNER_NAME: "Alice Example",
  BK_OWNER_EMAIL: "alice@example.com",
})!;

it.effect("sends the sender identity as trusted developer context on the turn", () =>
  Effect.gen(function* () {
    const alone = yield* CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "native-identity",
      codexInput: [{ type: "text", text: "who am I?" }],
      runtimePolicy: policy,
      modelSelection,
      senderIdentity,
    });
    assert.deepEqual(alone.additionalContext, {
      t3_current_user: { kind: "application", value: senderIdentity },
    });
    assert.include(senderIdentity, "- Name: Bob Example");
    assert.deepEqual(alone.input, [{ type: "text", text: "who am I?" }]);

    const withEverything = yield* CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "native-identity",
      codexInput: [{ type: "text", text: "who am I?" }],
      runtimePolicy: policy,
      modelSelection,
      hasT3Mcp: true,
      appContext: [{ key: "t3_current_user", text: "spoofed by an app" }],
      senderIdentity,
    });
    assert.deepEqual(withEverything.additionalContext?.t3_current_user, {
      kind: "application",
      value: senderIdentity,
    });
    assert.isDefined(withEverything.additionalContext?.t3_code_runtime);
  }),
);

it.effect("adds no identity context outside T3 Code", () =>
  Effect.gen(function* () {
    const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "native-identity",
      codexInput: [{ type: "text", text: "hi" }],
      runtimePolicy: policy,
      modelSelection,
    });
    assert.isUndefined(params.additionalContext);
  }),
);
