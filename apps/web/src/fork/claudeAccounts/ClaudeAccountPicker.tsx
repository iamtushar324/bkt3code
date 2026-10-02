/**
 * T3-CUSTOM(expbkt3): the composer's Claude account picker.
 *
 * Sits next to the model picker while a Claude instance is selected and the
 * server has `experimental.claudeAccountProfiles` on. The trigger is the
 * Claude mark with the account's badge letter and its weekly limit left;
 * the menu offers "Auto (account)" (the default: the server places the
 * thread) or any account by hand, each with its live limits.
 */
import {
  CLAUDE_ACCOUNT_MODE_AUTO,
  type ClaudeAccountMode,
  type ClaudeAccountsSnapshot,
  type EnvironmentId,
  ProviderDriverKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { type ReactNode, useEffect, useState } from "react";

import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "../../components/chat/ComposerControl";
import { composerFloatingLayerProps } from "../../components/chat/composerEventScope";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { useComposerMenuState } from "../../components/chat/useComposerMenuState";
import { Badge } from "../../components/ui/badge";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { barColor } from "../../components/usage/UsageLimits";
import { cn } from "../../lib/utils";
import { useClaudeAccountsSnapshot, useThreadClaudeAccount } from "./hooks";
import {
  type AccountChipTone,
  type AccountRowView,
  type AccountWarning,
  accountRows,
  AUTO_ACCOUNT_DESCRIPTION,
  AUTO_ACCOUNT_LABEL,
  modeEquals,
  PENDING_RESTART_HINT,
  SWITCH_RESTARTS_CACHE_HINT,
  switchRestartsCache,
  triggerTooltip,
  triggerView,
  unavailableLine,
} from "./model";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const AUTO_VALUE = "auto";
const PROFILE_VALUE_PREFIX = "profile:";
/** Countdowns only need minute precision, and only while the menu is open. */
const OPEN_MENU_CLOCK_MS = 30_000;

function modeValue(mode: ClaudeAccountMode): string {
  return mode.kind === "auto" ? AUTO_VALUE : `${PROFILE_VALUE_PREFIX}${mode.profile}`;
}

function valueMode(value: string): ClaudeAccountMode {
  return value.startsWith(PROFILE_VALUE_PREFIX)
    ? { kind: "profile", profile: value.slice(PROFILE_VALUE_PREFIX.length) }
    : CLAUDE_ACCOUNT_MODE_AUTO;
}

const WARNING_TEXT_CLASS: Record<AccountWarning, string> = {
  near: "text-warning-foreground",
  limit: "text-destructive-foreground",
  logged_out: "text-destructive-foreground",
};

const CHIP_VARIANT: Record<AccountChipTone, "error" | "warning" | "outline"> = {
  destructive: "error",
  warning: "warning",
  muted: "outline",
};

function indicatorBackgroundFor(size: ComposerControlSize): string {
  return size === "xs"
    ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
    : "var(--contrast-input)";
}

/** The Claude mark with the account's badge letter at its corner. */
function AccountMark(props: {
  readonly label: string | null;
  readonly auto: boolean;
  readonly indicatorBackground: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <ProviderInstanceIcon
        driverKind={CLAUDE_DRIVER}
        displayName="Claude"
        showBadge={false}
        badgeContent="none"
        className="size-4"
        iconClassName="size-4"
        indicatorBackground={props.indicatorBackground}
        {...(props.auto ? { statusDotClassName: "size-1.5 bg-info" } : {})}
      />
      {props.label ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-1 -bottom-1 z-40 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 font-semibold text-5xs text-background leading-none"
          style={{ boxShadow: `0 0 0 1.5px ${props.indicatorBackground}` }}
        >
          {props.label}
        </span>
      ) : null}
    </span>
  );
}

function RemainingBar({ remaining }: { readonly remaining: number }) {
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${remaining}%`, backgroundColor: barColor(CLAUDE_DRIVER) }}
      />
    </span>
  );
}

function AccountRow({ row }: { readonly row: AccountRowView }) {
  return (
    <span className="grid w-full gap-1 py-1">
      <span className="flex min-w-0 items-center gap-2">
        <AccountMark label={row.shortLabel} auto={false} indicatorBackground="var(--popover)" />
        <span className="shrink-0 font-medium">{row.name}</span>
        {row.emailMasked ? (
          <span className="min-w-0 truncate text-muted-foreground text-xs">{row.emailMasked}</span>
        ) : null}
        {row.current ? (
          <span className="shrink-0 text-muted-foreground text-2xs">this thread</span>
        ) : null}
        {row.elected ? (
          <span className="shrink-0 text-muted-foreground text-2xs">host default</span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {row.chips.map((chip) => (
            <Badge key={chip.id} variant={CHIP_VARIANT[chip.tone]} size="sm">
              {chip.label}
            </Badge>
          ))}
          <MenuRadioItemIndicator />
        </span>
      </span>
      {row.windows.length > 0 ? (
        <span className="grid grid-cols-3 gap-3 ps-6">
          {row.windows.map((win) => (
            <span key={win.id} className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 items-baseline justify-between gap-1 text-2xs">
                <span className="truncate text-muted-foreground">{win.label}</span>
                <span className="shrink-0 font-medium tabular-nums">{win.remaining}% left</span>
              </span>
              <RemainingBar remaining={win.remaining} />
              <span className="truncate text-3xs text-muted-foreground tabular-nums">
                {win.resetsIn ?? " "}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function ClaudeAccountPicker(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ClaudeAccountsSnapshot;
  readonly running: boolean;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const { snapshot, size } = props;
  const { account, setMode } = useThreadClaudeAccount(props.threadRef, true);
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [now, setNow] = useState(() => Date.now());
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), OPEN_MENU_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [open]);

  const view = triggerView(snapshot, account);
  const tooltip = triggerTooltip(view);
  const mode = account?.mode ?? CLAUDE_ACCOUNT_MODE_AUTO;
  const rows = accountRows(snapshot, account, now);
  const unavailable = unavailableLine(snapshot);
  const indicatorBackground = indicatorBackgroundFor(size);
  const hoveredSwitches =
    hoveredValue !== null && switchRestartsCache(account, valueMode(hoveredValue));
  const resolvedProfile = account?.resolvedProfile;

  const triggerText =
    view.kind === "auto-unresolved"
      ? "Auto"
      : view.weeklyRemaining === null
        ? null
        : `${view.weeklyRemaining}%`;

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (next) setNow(Date.now());
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  aria-label={`Claude account: ${tooltip}`}
                  data-claude-account-picker="true"
                  size={size}
                  className="shrink-0 whitespace-nowrap"
                />
              }
            />
          }
        >
          <AccountMark
            label={view.kind === "account" ? view.label : null}
            auto={view.kind === "auto-unresolved" || view.auto}
            indicatorBackground={indicatorBackground}
          />
          {triggerText ? (
            <span
              data-composer-control-label
              className={cn(
                "tabular-nums",
                view.kind === "account" && view.warn ? WARNING_TEXT_CLASS[view.warn] : null,
              )}
            >
              {triggerText}
            </span>
          ) : null}
          <ComposerControlChevron size={size} />
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-96" {...composerFloatingLayerProps}>
        <span className="grid gap-0.5 px-2 pt-1 pb-1.5">
          <span className="font-medium text-muted-foreground text-xs">Claude account</span>
          {account?.notice ? (
            <span className="text-warning-foreground text-xs">{account.notice}</span>
          ) : null}
          {account?.pendingRestart ? (
            <span className="text-muted-foreground text-xs">{PENDING_RESTART_HINT}</span>
          ) : null}
          {unavailable ? (
            <span className="text-muted-foreground text-xs">{unavailable}</span>
          ) : null}
        </span>
        <MenuRadioGroup
          value={modeValue(mode)}
          onValueChange={(value: string) => {
            const next = valueMode(value);
            if (modeEquals(next, mode)) return;
            void setMode(next);
          }}
        >
          <MenuRadioItem
            value={AUTO_VALUE}
            closeOnClick
            onMouseEnter={() => setHoveredValue(AUTO_VALUE)}
            onFocus={() => setHoveredValue(AUTO_VALUE)}
          >
            <span className="flex w-full items-center gap-2 py-1">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  {AUTO_ACCOUNT_LABEL}
                  {mode.kind === "auto" && resolvedProfile ? (
                    <span className="font-normal text-muted-foreground text-xs">
                      on {resolvedProfile}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs leading-4">
                  {AUTO_ACCOUNT_DESCRIPTION}
                </span>
              </span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {rows.length > 0 ? <MenuSeparator /> : null}
          {rows.map((row) => {
            const value = modeValue({ kind: "profile", profile: row.name });
            return (
              <MenuRadioItem
                key={row.name}
                value={value}
                disabled={row.disabled}
                closeOnClick
                onMouseEnter={() => setHoveredValue(value)}
                onFocus={() => setHoveredValue(value)}
              >
                <AccountRow row={row} />
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {resolvedProfile ? (
          <span className="block px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
            {hoveredSwitches
              ? `${SWITCH_RESTARTS_CACHE_HINT}${props.running ? ` ${PENDING_RESTART_HINT}.` : ""}`
              : `This thread runs on ${resolvedProfile}.`}
          </span>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The picker for the composer toolbar, or null when it does not apply: the
 * selected instance is not Claude, several models are selected (each becomes
 * its own thread), or the server has the feature off or cannot answer. The
 * account stream is only opened while a Claude instance is selected.
 */
export function useClaudeAccountPickerControl(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly driverKind: ProviderDriverKind | undefined;
  readonly multipleModels: boolean;
  readonly running: boolean;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}): ReactNode | null {
  const applies = input.driverKind === CLAUDE_DRIVER && !input.multipleModels;
  const snapshot = useClaudeAccountsSnapshot(applies ? input.environmentId : null);
  if (!applies || snapshot === null || !snapshot.enabled) return null;
  return (
    <ClaudeAccountPicker
      threadRef={input.threadRef}
      snapshot={snapshot}
      running={input.running}
      size={input.size}
      hidden={input.hidden}
    />
  );
}
