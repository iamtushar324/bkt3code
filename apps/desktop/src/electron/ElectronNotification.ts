import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/**
 * Native OS notifications.
 *
 * Fork-owned. Added for the desktop updater: teammates should be told a new
 * build is ready without having to notice a button in the sidebar, and clicking
 * that notification should restart straight into it.
 */
export interface ElectronNotificationRequest {
  readonly title: string;
  readonly body: string;
  /** Invoked when the user clicks the notification body. */
  readonly onClick: () => void;
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /**
     * Shows a notification, or does nothing where the OS has none available.
     *
     * Resolves to whether it was shown, so callers can fall back to an in-app
     * surface. Notifications are advisory — a suppressed one must never mean a
     * user is stuck, which is why the update flow also keeps its sidebar button.
     */
    readonly show: (request: ElectronNotificationRequest) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export const make = ElectronNotification.of({
  show: (request) =>
    Effect.sync(() => {
      if (!Electron.Notification.isSupported()) return false;
      const notification = new Electron.Notification({
        title: request.title,
        body: request.body,
      });
      notification.on("click", request.onClick);
      notification.show();
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false))),
});

export const layer = Layer.succeed(ElectronNotification, make);
