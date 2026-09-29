/**
 * T3-CUSTOM(expbkt3): the Settings → Connections entry points for a host's
 * shared appearance.
 *
 * A menu popup unmounts when it closes, so the dialog cannot live inside the
 * menu that opens it. `EnvironmentAppearanceMenuItem` records which environment
 * to edit and `EnvironmentAppearanceDialogHost`, mounted once beside the menus,
 * renders the dialog. Each seam in `ConnectionsSettings.tsx` is one element; the
 * row glyph swap is `EnvironmentAppearanceIcon` in `EnvironmentBadge.tsx`.
 *
 * @module components/environment/EnvironmentAppearanceDialog
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { PaletteIcon } from "lucide-react";
import { create } from "zustand";

import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MenuItem } from "../ui/menu";
import { SettingsRow } from "../settings/settingsLayout";
import { EnvironmentAppearanceEditor } from "./EnvironmentAppearanceEditor";

const useAppearanceDialogStore = create<{
  readonly environmentId: EnvironmentId | null;
  readonly open: (environmentId: EnvironmentId | null) => void;
}>()((set) => ({
  environmentId: null,
  open: (environmentId) => set({ environmentId }),
}));

/** "Appearance…" in an environment's row menu. */
export function EnvironmentAppearanceMenuItem({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const open = useAppearanceDialogStore((state) => state.open);
  return (
    <MenuItem onClick={() => open(environmentId)}>
      <PaletteIcon />
      Appearance…
    </MenuItem>
  );
}

/**
 * Settings row that opens the same dialog. Used where there is no row menu to hang
 * `EnvironmentAppearanceMenuItem` on: a member session (no `access:write`) sees
 * Connections without the primary environment's header menu, but may still write
 * server settings (`orchestration:operate`), so it can rename the host too.
 */
export function EnvironmentAppearanceSettingsRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const open = useAppearanceDialogStore((state) => state.open);
  const environment = useEnvironment(environmentId);
  return (
    <SettingsRow
      title="Appearance"
      description={`Nickname, icon and colour for ${environment?.label ?? "this host"}, shown to everyone connected to it.`}
      control={
        <Button type="button" variant="outline" size="xs" onClick={() => open(environmentId)}>
          <PaletteIcon />
          Edit…
        </Button>
      }
    />
  );
}

/** Mount once on the page that renders `EnvironmentAppearanceMenuItem`s. */
export function EnvironmentAppearanceDialogHost() {
  const environmentId = useAppearanceDialogStore((state) => state.environmentId);
  const open = useAppearanceDialogStore((state) => state.open);
  const environment = useEnvironment(environmentId);
  return (
    <Dialog
      open={environmentId !== null}
      onOpenChange={(next) => {
        if (!next) open(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Appearance{environment ? ` of ${environment.label}` : ""}</DialogTitle>
          <DialogDescription>
            A nickname, icon and colour for this environment, shown to everyone connected to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {environmentId !== null ? (
            <EnvironmentAppearanceEditor environmentId={environmentId} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
