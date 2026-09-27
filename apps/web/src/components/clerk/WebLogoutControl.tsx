import { useAuth } from "@clerk/react";
import { LoaderCircleIcon, LogOutIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { hasClerkPublicConfig } from "../../cloud/publicConfig";
import { logoutPrimaryEnvironment } from "../../environments/primary";
import { isElectron } from "../../env";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

export async function performWebLogout(input: {
  readonly logoutEnvironment: () => Promise<void>;
  readonly signOutClerk: () => Promise<unknown>;
  readonly redirectToSignIn: () => void;
}): Promise<void> {
  await input.logoutEnvironment();
  await input.signOutClerk();
  input.redirectToSignIn();
}

export function WebLogoutControl() {
  if (isElectron || !hasClerkPublicConfig()) return null;

  return <ConfiguredWebLogoutControl />;
}

function ConfiguredWebLogoutControl() {
  const { isLoaded, isSignedIn, signOut } = useAuth({ treatPendingAsSignedOut: false });
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = useCallback(() => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    void performWebLogout({
      logoutEnvironment: logoutPrimaryEnvironment,
      signOutClerk: () => signOut(),
      redirectToSignIn: () => {
        window.location.assign(new URL("/pair", window.location.href).toString());
      },
    }).catch((error: unknown) => {
      setIsLoggingOut(false);
      toastManager.add({
        type: "error",
        title: "Could not log out",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    });
  }, [isLoggingOut, signOut]);

  if (!isLoaded || !isSignedIn) return null;

  return <WebLogoutControlView isLoggingOut={isLoggingOut} onLogout={handleLogout} />;
}

export function WebLogoutControlView({
  isLoggingOut,
  onLogout,
}: {
  readonly isLoggingOut: boolean;
  readonly onLogout: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton disabled={isLoggingOut} onClick={onLogout} type="button">
          {isLoggingOut ? <LoaderCircleIcon className="animate-spin" /> : <LogOutIcon />}
          <span>{isLoggingOut ? "Logging out…" : "Log out"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
