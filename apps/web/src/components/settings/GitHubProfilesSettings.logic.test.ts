import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { SourceControlProfileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { githubProfileActionErrorMessage } from "./GitHubProfilesSettings.logic";

describe("githubProfileActionErrorMessage", () => {
  it("surfaces the actionable source-control profile detail", () => {
    const result = AsyncResult.failure(
      Cause.fail(
        new SourceControlProfileError({
          operation: "validate-email",
          reason: "invalid-email",
          detail:
            'GitHub could not verify this email. Grant the token "Email addresses: read", or use 42+alice@users.noreply.github.com.',
        }),
      ),
    );

    expect(githubProfileActionErrorMessage(result)).toBe(
      'GitHub could not verify this email. Grant the token "Email addresses: read", or use 42+alice@users.noreply.github.com.',
    );
  });

  it("returns null after a successful profile action", () => {
    const result: AtomCommandResult<void, never> = AsyncResult.success(undefined);
    expect(githubProfileActionErrorMessage(result)).toBeNull();
  });
});
