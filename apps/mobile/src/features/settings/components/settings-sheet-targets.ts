export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsNotifications"
  | "SettingsThreads"
  | "SettingsAbout"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsOrganization"
  | "SettingsProjectOverview"
  | "SettingsEnvironmentNewThreads"
  | "SettingsEnvironmentSourceControl"
  | "SettingsEnvironmentAgentBehavior"
  | "SettingsEnvironmentMaintenance"
  | "SettingsProviderAccounts"
  | "SettingsKeyboard"
  | "SettingsFollowUp"
  | "SettingsScheduledTasks"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  // T3-CUSTOM(expbkt3): BEGIN — fork source-control identity settings screen.
  | "SettingsUsage"
  | "SettingsSourceControl";
// T3-CUSTOM(expbkt3): END

export type SettingsLegalDocumentTarget = "SettingsLegal";
