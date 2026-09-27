// T3-CUSTOM(expbkt3): the bottom sheet the Group-by and Filter panels open in.
//
// A modal rather than a view pushed into the pane: the pane sits under a
// translucent navigation header, so anything laid out at its top renders
// behind the title. A modal owns the whole window, slides up from the bottom
// like every other iOS sheet, and closes on a backdrop tap or the Done button.
import type { ReactNode } from "react";
import { Modal, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function PhaseSidebarSheetModal(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      navigationBarTranslucent
      onRequestClose={props.onClose}
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="flex-1 bg-backdrop"
          onPress={props.onClose}
        />
        <View
          className="rounded-t-[24px] bg-sheet-solid"
          style={{
            maxHeight: Math.round(windowHeight * 0.72),
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          <View className="items-center pt-2">
            <View className="h-1 w-9 rounded-full bg-subtle-strong" />
          </View>
          {props.children}
        </View>
      </View>
    </Modal>
  );
}
