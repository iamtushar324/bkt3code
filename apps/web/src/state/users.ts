import { createUserManagementEnvironmentAtoms } from "@t3tools/client-runtime/state/users";

import { connectionAtomRuntime } from "../connection/runtime";

export const userManagementEnvironment =
  createUserManagementEnvironmentAtoms(connectionAtomRuntime);
