import { createFileRoute } from "@tanstack/react-router";

import { ExperimentsSettingsPanel } from "../components/settings/ExperimentsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/experiments")({
  component: ExperimentsSettingsPanel,
});
