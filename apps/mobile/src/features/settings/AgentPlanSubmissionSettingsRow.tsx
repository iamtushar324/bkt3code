// T3-CUSTOM(expbkt3): agent plan tool availability applies to all sessions on each selected server.
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

function AgentPlanSubmissionEnvironmentRow({ target }: { readonly target: SettingsTarget }) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agent plan tool setting",
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const change = async (enabled: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await updateSettings({
        environmentId: target.environmentId,
        input: { patch: { experimental: { agentPlanSubmissionEnabled: enabled } } },
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <SettingsSwitchRow
      icon="doc.text"
      label="Agent plan tool"
      subtitle={`${target.label}. Allow agents to submit plans to the plan panel. Turn this off to require plans in the main chat. Applies to all sessions on this server.`}
      value={target.serverConfig.settings.experimental.agentPlanSubmissionEnabled}
      disabled={pending}
      onValueChange={(enabled) => {
        void change(enabled);
      }}
    />
  );
}

export function AgentPlanSubmissionSettingsRow() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      {selectedTargets.map((target) => (
        <AgentPlanSubmissionEnvironmentRow key={target.environmentId} target={target} />
      ))}
    </>
  );
}
