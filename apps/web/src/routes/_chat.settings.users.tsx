import { createFileRoute } from "@tanstack/react-router";

import { UserManagementSettingsPanel } from "../components/settings/UserManagementSettings";

export const Route = createFileRoute("/_chat/settings/users")({
  component: UserManagementSettingsPanel,
});
