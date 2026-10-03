// T3-CUSTOM(expbkt3): batched head lookups retain the PR readiness badges.
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const decodeHeadCommitRollup = Schema.decodeUnknownExit(
  Schema.Struct({
    commits: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                commit: Schema.NullOr(
                  Schema.Struct({
                    statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
);

/** Keep the cheap GraphQL verdict in the existing gh CLI decoder's format. */
export function withGitHubHeadReadiness(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const decoded = decodeHeadCommitRollup(node);
  if (!Exit.isSuccess(decoded) || decoded.value.commits === undefined) return node;
  return {
    ...node,
    statusCheckRollup: (decoded.value.commits?.nodes ?? []).flatMap((commitNode) => {
      const state = commitNode?.commit?.statusCheckRollup?.state.trim();
      return state ? [{ state }] : [];
    }),
  };
}
