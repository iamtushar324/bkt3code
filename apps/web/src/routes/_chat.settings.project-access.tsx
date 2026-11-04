import { createFileRoute } from "@tanstack/react-router";

import { ProjectAccessSettingsPanel } from "../components/settings/ProjectAccessSettingsPanel";

export const Route = createFileRoute("/_chat/settings/project-access")({
  component: ProjectAccessSettingsPanel,
});
