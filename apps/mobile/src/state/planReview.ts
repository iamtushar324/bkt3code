// T3-CUSTOM(expbkt3): mobile binding for the fork's native plan review.
//
// The atoms themselves are platform-agnostic and already live in
// client-runtime; web binds them the same way. Only the runtime differs.
import { createPlanReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/planReview";

import { connectionAtomRuntime } from "../connection/runtime";

export const planReviewEnvironment = createPlanReviewEnvironmentAtoms(connectionAtomRuntime);
