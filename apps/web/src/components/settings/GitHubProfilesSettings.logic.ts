import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { SourceControlProfileError } from "@t3tools/contracts";
import { Schema } from "effect";

const isSourceControlProfileError = Schema.is(SourceControlProfileError);

export function githubProfileActionErrorMessage(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  if (isSourceControlProfileError(error)) return error.detail;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The GitHub profile action failed.";
}
