import { createFileRoute } from "@tanstack/react-router";

import { ExperimentsSettingsPanel } from "../components/settings/ExperimentsSettingsPanel";

export const Route = createFileRoute("/settings/experiments")({
  component: ExperimentsSettingsPanel,
});
