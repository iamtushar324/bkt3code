// T3-CUSTOM(expbkt3): BEGIN — guarded route seam for experimental project management.
//
// Both sides of the upstream merge created this route independently: upstream
// ships its own project settings page here, and the fork shipped the control
// centre panel. The flag selects between the two rather than redirecting away,
// which would have hidden upstream's page from every default build.
import { createFileRoute } from "@tanstack/react-router";

import { ActiveProjectsSettingsPanel } from "../components/settings/ActiveProjectsSettingsPanel";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../experimentalFeatures";

export const Route = createFileRoute("/settings/projects")({
  component: EXPERIMENTAL_CONTROL_CENTER_ENABLED ? ActiveProjectsSettingsPanel : ProjectsSettings,
});
// T3-CUSTOM(expbkt3): END
