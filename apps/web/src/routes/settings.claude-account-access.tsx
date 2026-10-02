// T3-CUSTOM(expbkt3): admin-only Claude account access per user.
import { createFileRoute } from "@tanstack/react-router";

import { ClaudeAccountAccessSettingsPanel } from "../components/settings/ClaudeAccountAccessSettingsPanel";

export const Route = createFileRoute("/settings/claude-account-access")({
  component: ClaudeAccountAccessSettingsPanel,
});
