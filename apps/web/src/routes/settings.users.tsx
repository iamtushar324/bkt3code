import { createFileRoute } from "@tanstack/react-router";

import { UserManagementSettingsPanel } from "../components/settings/UserManagementSettings";

export const Route = createFileRoute("/settings/users")({
  component: UserManagementSettingsPanel,
});
