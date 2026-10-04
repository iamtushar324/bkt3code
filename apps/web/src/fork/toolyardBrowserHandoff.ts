/** T3-CUSTOM(expbkt3): Reserve a web tab before asynchronous handoff; native desktop uses OS browser. */
import { ensureLocalApi } from "../localApi";
export interface ToolyardBrowserHandoffTarget {
  open: (url: string) => Promise<void>;
  close: () => void;
}
export function createToolyardBrowserHandoffTarget(): ToolyardBrowserHandoffTarget {
  if (window.desktopBridge)
    return { open: (url) => ensureLocalApi().shell.openExternal(url), close: () => undefined };
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("The browser blocked the Toolyard tab.");
  tab.opener = null;
  let used = false;
  return {
    open: async (url) => {
      tab.location.replace(url);
      used = true;
    },
    close: () => {
      if (!used) tab.close();
    },
  };
}
