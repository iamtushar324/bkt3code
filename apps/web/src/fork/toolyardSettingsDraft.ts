/** T3-CUSTOM(expbkt3): Credential-free settings drafts scoped to environment and user. */
export interface ToolyardSettingsDraft {
  baseUrl: string;
  enabled: boolean;
  revision: number;
}
const prefix = "t3-toolyard-settings-draft:";
const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
export const toolyardDraftKey = (environmentId: string, userId: string) =>
  `${prefix}${encodeURIComponent(environmentId)}:${encodeURIComponent(userId)}`;
export function readToolyardSettingsDraft(key: string): ToolyardSettingsDraft | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ToolyardSettingsDraft>;
    return typeof value.baseUrl === "string" &&
      typeof value.enabled === "boolean" &&
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision)
      ? (value as ToolyardSettingsDraft)
      : null;
  } catch {
    return null;
  }
}
export function writeToolyardSettingsDraft(key: string, draft: ToolyardSettingsDraft | null) {
  try {
    if (draft === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(draft));
  } catch {
    /* The current component retains drafts when storage is unavailable. */
  }
}
export function clearToolyardSettingsDrafts() {
  const store = storage();
  if (!store) return;
  try {
    for (const key of Object.keys(store)) if (key.startsWith(prefix)) store.removeItem(key);
  } catch {
    /* Logout must still proceed. */
  }
}
