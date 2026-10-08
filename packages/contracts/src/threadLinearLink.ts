// T3-CUSTOM(expbkt3): Linear tags on a session.
//
// A session can carry several tags — the project it belongs to, the main issue,
// and each sub-issue it touched — set by people from the sidebar and by agents
// through the `t3_link_linear` / `t3_unlink_linear` MCP tools. Whether an issue
// is a sub-issue comes from Linear at read time, not from the tag.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Most Linear tags one session holds; further additions are ignored. */
export const THREAD_LINEAR_LINKS_MAX = 25;

export const ThreadLinearLink = Schema.Struct({
  url: TrimmedNonEmptyString,
  kind: Schema.Literals(["issue", "project"]),
});
export type ThreadLinearLink = typeof ThreadLinearLink.Type;

/** A batch of tags to add, or of URLs to remove, in one metadata update. */
export const ThreadLinearLinksAdd = Schema.Array(ThreadLinearLink).check(
  Schema.isMaxLength(THREAD_LINEAR_LINKS_MAX),
);
export const ThreadLinearLinksRemove = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMaxLength(THREAD_LINEAR_LINKS_MAX),
);
