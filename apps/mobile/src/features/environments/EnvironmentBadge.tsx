// T3-CUSTOM(expbkt3): one visual identity for an environment on mobile.
//
// Mirrors web's EnvironmentBadge: `glyph` is the bare symbol in the
// environment's colour for dense metadata lanes; `icon` is a small tinted tile
// for settings rows and pickers. Android draws the mapped Tabler icon; a
// symbol with no mapping falls back to a coloured dot.
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import type { MobileEnvironmentAppearance } from "./environmentAppearance";

export function EnvironmentBadge(props: {
  readonly appearance: MobileEnvironmentAppearance;
  readonly variant?: "glyph" | "icon";
  readonly size?: number;
}) {
  const { appearance } = props;
  const variant = props.variant ?? "glyph";
  const size = props.size ?? (variant === "glyph" ? 11 : 14);
  const dot = (
    <View
      style={{
        width: size * 0.7,
        height: size * 0.7,
        borderRadius: size,
        backgroundColor: appearance.color,
      }}
    />
  );
  const symbol = (
    <SymbolView
      accessibilityLabel={appearance.name}
      fallback={dot}
      name={appearance.symbol}
      size={size}
      tintColor={appearance.color}
      type="monochrome"
    />
  );
  if (variant === "glyph") return symbol;
  return (
    <View
      accessibilityLabel={appearance.name}
      className="items-center justify-center rounded-[7px] border"
      style={{
        width: size * 2,
        height: size * 2,
        borderColor: `${appearance.color}66`,
        backgroundColor: `${appearance.color}29`,
      }}
    >
      {symbol}
    </View>
  );
}
