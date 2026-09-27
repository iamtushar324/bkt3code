// T3-CUSTOM(expbkt3): native plan review atoms bound to the web connection.
import { createPlanReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/planReview";

import { connectionAtomRuntime } from "../connection/runtime";

export const planReviewEnvironment = createPlanReviewEnvironmentAtoms(connectionAtomRuntime);
