import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CurrentSourceControlExecutionEnvironment } from "../sourceControl/SourceControlExecutionEnvironment.ts";

/** The profile resolver already verified this login; host-wide viewer caches cannot substitute another owner. */
export const CurrentPullRequestProfileViewer = Context.Reference<string | null>(
  "t3/pullRequest/CurrentProfileViewer",
  { defaultValue: () => null },
);

const encodeNamespace = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      profileId: Schema.String,
      routingFingerprint: Schema.NullOr(Schema.String),
      credentials: Schema.Array(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)])),
    }),
  ),
);

/** Cache keys carry an opaque namespace, never the profile's token. Credential replacement gets a fresh cache. */
export const sourceControlCredentialNamespace = Effect.fnUntraced(function* (
  routingFingerprint: string | null,
) {
  const execution = yield* CurrentSourceControlExecutionEnvironment;
  if (execution === null) return routingFingerprint;
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      encodeNamespace({
        profileId: execution.profileId,
        routingFingerprint,
        credentials: [
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "GH_ENTERPRISE_TOKEN",
          "GITHUB_ENTERPRISE_TOKEN",
          "GH_CONFIG_DIR",
        ].map((key) => [key, execution.environment[key] ?? null] as const),
      }),
    )
    .digest("hex");
  return `bk-source-control:${fingerprint}`;
});
