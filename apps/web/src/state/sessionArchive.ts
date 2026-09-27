// T3-CUSTOM(expbkt3): archived-session worktree reclaim commands.
import { createSessionArchiveEnvironmentAtoms } from "@t3tools/client-runtime/state/session-archive";

import { connectionAtomRuntime } from "../connection/runtime";

export const sessionArchiveEnvironment =
  createSessionArchiveEnvironmentAtoms(connectionAtomRuntime);
