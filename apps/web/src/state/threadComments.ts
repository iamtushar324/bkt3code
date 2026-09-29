// T3-CUSTOM(expbkt3): review-comment atoms bound to the web connection.
import { createThreadCommentsEnvironmentAtoms } from "@t3tools/client-runtime/state/threadComments";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadCommentsEnvironment =
  createThreadCommentsEnvironmentAtoms(connectionAtomRuntime);
