import { View } from "react-native";

import type { RemoteClientConnectionState } from "../../lib/connection";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha, type MobileThemeVariables } from "../../lib/mobileTheme";

export type ConnectionStatusDotState = RemoteClientConnectionState;

function statusDotTone(
  state: ConnectionStatusDotState,
  theme: MobileThemeVariables,
  dark: boolean,
): {
  readonly dotColor: string;
  readonly haloColor: string;
} {
  switch (state) {
    case "available":
    case "unsupported":
      return {
        dotColor: theme["--color-icon-muted"],
        haloColor: themeColorWithAlpha(theme["--color-icon-muted"], 0.42),
      };
    case "connected":
      return {
        dotColor: dark ? "#34d399" : "#059669",
        haloColor: themeColorWithAlpha(dark ? "#34d399" : "#059669", 0.48),
      };
    case "connecting":
    case "reconnecting":
      return {
        dotColor: theme["--color-warning-foreground"],
        haloColor: themeColorWithAlpha(theme["--color-warning-foreground"], 0.5),
      };
    case "offline":
    case "error":
      return {
        dotColor: theme["--color-danger-foreground"],
        haloColor: themeColorWithAlpha(theme["--color-danger-foreground"], 0.48),
      };
  }
}

export function ConnectionStatusDot(props: {
  readonly state: ConnectionStatusDotState;
  readonly pulse: boolean;
  readonly size?: number;
  // T3-CUSTOM(expbkt3): a live but slow session shows the static warning tone (TEC-1837).
  readonly slow?: boolean;
}) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  // T3-CUSTOM(expbkt3): BEGIN — the warning tone for slow, without the reconnect pulse (TEC-1837).
  const tone = statusDotTone(
    props.slow === true && props.state === "connected" ? "connecting" : props.state,
    themeVariables,
    themeAppearance === "dark",
  );
  // T3-CUSTOM(expbkt3): END
  const dotSize = props.size ?? 10;
  const haloSize = dotSize + 4;
  const containerSize = haloSize + 4;

  return (
    <View
      style={{
        width: containerSize,
        height: containerSize,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Looping Reanimated updates can starve React commits while commit pausing is disabled. */}
      {props.pulse ? (
        <View
          style={{
            position: "absolute",
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            backgroundColor: tone.haloColor,
            opacity: 0.3,
          }}
        />
      ) : null}
      <View
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: tone.dotColor,
        }}
      />
    </View>
  );
}
