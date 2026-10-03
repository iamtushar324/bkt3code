// T3-CUSTOM(expbkt3): server-wide availability of the agent plan submission tool.
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function AgentPlanSubmissionSettingsRow() {
  const enabled = usePrimarySettings(
    (settings) => settings.experimental.agentPlanSubmissionEnabled,
  );
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      title="Agent plan tool"
      description="Allow agents to submit plans to the plan panel. Turn this off to require plans in the main chat. Applies to all sessions on this server."
      control={
        <Switch
          checked={enabled}
          disabled={!available}
          onCheckedChange={(checked) =>
            updateSettings({ experimental: { agentPlanSubmissionEnabled: Boolean(checked) } })
          }
          aria-label="Allow agent plan submission"
        />
      }
    />
  );
}
