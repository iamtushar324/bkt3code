/**
 * T3-CUSTOM(expbkt3): choose the project a new thread starts in.
 *
 * Nicknames are collapsed to one row each, so a project registered on several
 * machines no longer renders as a set of identical-looking rows. Which machine
 * to use is then asked separately, in {@link NewThreadHostPicker}, and only
 * when the chosen nickname really does resolve to more than one place.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, FolderPlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { Project } from "../../types";
import type { ResolvedEnvironmentAppearance } from "../../state/environmentAppearance";
import { ProjectFavicon } from "../ProjectFavicon";
import { EnvironmentBadgeView } from "../environment/EnvironmentBadge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  buildNewThreadProjectOptions,
  findNewThreadProjectOption,
  type NewThreadProjectHost,
  type NewThreadProjectOption,
} from "./NewThreadProjectPicker.logic";

export function NewThreadProjectPicker({
  open,
  projects,
  activeProject,
  primaryEnvironmentId,
  resolveEnvironmentLabel,
  appearanceFor,
  onOpenChange,
  onSelect,
  onAddProject,
}: {
  readonly open: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly activeProject: Project | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly appearanceFor: (environmentId: EnvironmentId) => ResolvedEnvironmentAppearance | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (project: Project) => void;
  readonly onAddProject: () => void;
}) {
  // Which nickname the host overlay is asking about; null while it is closed.
  const [hostChoiceKey, setHostChoiceKey] = useState<string | null>(null);

  const options = useMemo(
    () =>
      buildNewThreadProjectOptions({
        projects,
        activeProject,
        primaryEnvironmentId,
        resolveEnvironmentLabel,
      }),
    [activeProject, primaryEnvironmentId, projects, resolveEnvironmentLabel],
  );
  const hostChoiceOption = findNewThreadProjectOption(options, hostChoiceKey);

  // The nickname can stop existing while the overlay is open — the machine
  // holding it disconnects, or the project is removed elsewhere. Drop the
  // selection rather than leaving a dialog that can never be reopened.
  useEffect(() => {
    if (hostChoiceKey !== null && hostChoiceOption === null) setHostChoiceKey(null);
  }, [hostChoiceKey, hostChoiceOption]);

  const chooseOption = useCallback(
    (option: NewThreadProjectOption) => {
      if (!option.requiresHostChoice) {
        onSelect(option.defaultHost.project);
        return;
      }
      // Hand over to the host overlay: one question on screen at a time.
      onOpenChange(false);
      setHostChoiceKey(option.key);
    },
    [onOpenChange, onSelect],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose a project</DialogTitle>
            <DialogDescription>
              Start the new thread in one of your available projects.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-1" data-testid="new-thread-project-options">
            <NewThreadProjectOptionList options={options} onChoose={chooseOption} />
            <button
              type="button"
              className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
              onClick={onAddProject}
            >
              <FolderPlusIcon className="size-4" />
              Add project
            </button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <NewThreadHostPicker
        option={hostChoiceOption}
        appearanceFor={appearanceFor}
        onBack={() => {
          setHostChoiceKey(null);
          onOpenChange(true);
        }}
        onDismiss={() => setHostChoiceKey(null)}
        onSelect={(host) => {
          setHostChoiceKey(null);
          onSelect(host.project);
        }}
      />
    </>
  );
}

/**
 * The collapsed project rows.
 *
 * Split out of the dialog so it can be rendered — and asserted on — without a
 * portal: the dialog renders nothing until it is mounted in a browser.
 */
export function NewThreadProjectOptionList({
  options,
  onChoose,
}: {
  readonly options: readonly NewThreadProjectOption[];
  readonly onChoose: (option: NewThreadProjectOption) => void;
}) {
  return (
    <>
      {options.map((option) => (
        <button
          type="button"
          key={option.key}
          autoFocus={option.containsActiveProject}
          data-testid={`new-thread-project-option-${option.key}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent",
            option.containsActiveProject && "bg-accent/70",
          )}
          onClick={() => onChoose(option)}
        >
          <ProjectFavicon
            // T3-CUSTOM(expbkt3): upstream takes the project record whole so the
            // saved title, favicon and icon override always travel together.
            project={option.defaultHost.project}
          />
          <span className="min-w-0 flex-1 truncate">{option.title}</span>
          {option.requiresHostChoice ? (
            // Says the row leads to a second question, and how many places it
            // can start in — the information the duplicate rows used to convey
            // by being duplicated.
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
              {option.hosts.length} hosts
              <ChevronRightIcon className="size-3.5" />
            </span>
          ) : (
            <span className="shrink-0 truncate text-muted-foreground text-xs">
              {option.defaultHost.label}
            </span>
          )}
        </button>
      ))}
    </>
  );
}

/**
 * The host rows, portal-free for the same reason as
 * {@link NewThreadProjectOptionList}.
 */
export function NewThreadHostList({
  option,
  appearanceFor,
  onSelect,
}: {
  readonly option: NewThreadProjectOption;
  readonly appearanceFor: (environmentId: EnvironmentId) => ResolvedEnvironmentAppearance | null;
  readonly onSelect: (host: NewThreadProjectHost) => void;
}) {
  return (
    <>
      {option.hosts.map((host) => {
        const appearance = appearanceFor(host.environmentId);
        return (
          <button
            type="button"
            key={`${host.environmentId}:${host.project.id}`}
            autoFocus={host === option.defaultHost}
            data-testid={`new-thread-host-option-${host.environmentId}-${host.project.id}`}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent",
              host.isActive && "bg-accent/70",
            )}
            onClick={() => onSelect(host)}
          >
            {appearance ? (
              <EnvironmentBadgeView appearance={appearance} variant="icon" title={host.label} />
            ) : (
              <ProjectFavicon
                // T3-CUSTOM(expbkt3): upstream takes the project record whole so the
                // saved title, favicon and icon override always travel together.
                project={host.project}
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{host.label}</span>
              {/* The workspace path is the only thing telling two checkouts on
                  the same machine apart. */}
              <span className="truncate text-muted-foreground text-xs">{host.workspaceRoot}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

/**
 * The dedicated second step: which machine should this project's thread run on.
 *
 * Only reached for a nickname that resolves to more than one host, so it never
 * asks a question with a single possible answer.
 */
export function NewThreadHostPicker({
  option,
  appearanceFor,
  onBack,
  onDismiss,
  onSelect,
}: {
  /** Null closes the overlay; the chosen nickname is its identity. */
  readonly option: NewThreadProjectOption | null;
  readonly appearanceFor: (environmentId: EnvironmentId) => ResolvedEnvironmentAppearance | null;
  readonly onBack: () => void;
  readonly onDismiss: () => void;
  readonly onSelect: (host: NewThreadProjectHost) => void;
}) {
  return (
    <Dialog
      open={option !== null}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Choose a host</DialogTitle>
          <DialogDescription>
            “{option?.title}” is set up on {option?.hosts.length} hosts. Pick where this thread
            should run.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1" data-testid="new-thread-host-options">
          {option ? (
            <NewThreadHostList option={option} appearanceFor={appearanceFor} onSelect={onSelect} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onBack}>
            <ChevronLeftIcon className="size-4" />
            Back
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
