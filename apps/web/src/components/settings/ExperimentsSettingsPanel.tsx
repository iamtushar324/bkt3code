// T3-CUSTOM(expbkt3): the fork-only BK Add-ons page, short by default: feature switches first,
// then per-server connections, this device, and maintenance. Details open on demand.
import { BkAddonsFeaturesSection } from "../../fork/BkAddonsFeaturesSection";
import { BkAddonsIntegrationsSection } from "../../fork/BkAddonsIntegrationsSection";
import { ExperimentsLogoutControl } from "../../fork/ExperimentsLogoutControl";
import { LocalPhonePairingSection } from "../../fork/LocalPhonePairingSection";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../../experimentalFeatures";
import { ExternalMcpSettingsSection } from "./ExternalMcpSettingsSection";
import { SessionArchiveSettingsSection } from "./SessionArchiveSettingsSection";
import { SettingsPageContainer } from "./settingsLayout";

export function ExperimentsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <BkAddonsFeaturesSection />
      {/* Toolyard, the default group and session callbacks, folded per server. */}
      <BkAddonsIntegrationsSection />
      {/* This device: renders only in the managed desktop build. */}
      <LocalPhonePairingSection />
      <ExperimentsLogoutControl />
      {/* Maintenance. */}
      <SessionArchiveSettingsSection />
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? <ExternalMcpSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
