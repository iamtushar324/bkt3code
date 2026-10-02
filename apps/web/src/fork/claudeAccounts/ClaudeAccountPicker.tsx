/**
 * T3-CUSTOM(expbkt3): the composer's Claude account picker.
 *
 * Sits next to the model picker while a Claude instance is selected and the
 * server has `experimental.claudeAccountProfiles` on. The trigger is the
 * Claude mark with the account's badge letter and its weekly % used; the
 * menu offers "Auto (account)" (the default: the server places the thread)
 * or any account by hand, each with its live usage, laid out like the
 * Claude Accounts dashboard.
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
import { cn } from "../../lib/utils";
import {
  useClaudeAccountsEnabled,
  useClaudeAccountsSnapshot,
  useThreadClaudeAccount,
} from "./hooks";
import {
  type AccountRowView,
  type AccountTag,
  type AccountTagTone,
  accountRows,
  AUTO_ACCOUNT_LABEL,
  autoRowDetail,
  modeEquals,
  PENDING_RESTART_HINT,
  SWITCH_RESTARTS_SESSION_HINT,
  switchRestartsSession,
  triggerTooltip,
  triggerView,
  unavailableLine,
  type UsageBand,
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

/** The dashboard's bar bands: green, amber from 60% used, red at the trip line. */
const BAND_FILL_CLASS: Record<UsageBand, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

const BAND_TEXT_CLASS: Record<UsageBand, string | null> = {
  ok: null,
  warn: "text-warning-foreground",
  bad: "text-destructive-foreground",
};

const TAG_VARIANT: Record<AccountTagTone, "error" | "warning" | "outline"> = {
  bad: "error",
  warn: "warning",
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

function UsageBar(props: { readonly used: number; readonly band: UsageBand }) {
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
      <span
        className={cn("block h-full rounded-full", BAND_FILL_CLASS[props.band])}
        style={{ width: `${props.used}%` }}
      />
    </span>
  );
}

function TagPill({ tag }: { readonly tag: AccountTag }) {
  const label = <span className="min-w-0 truncate">{tag.label}</span>;
  if (!tag.detail) {
    return (
      <Badge variant={TAG_VARIANT[tag.tone]} size="sm" className="min-w-0 max-w-full">
        {label}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant={TAG_VARIANT[tag.tone]} size="sm" className="min-w-0 max-w-full" />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{tag.detail}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One account, laid out like a dashboard card: the name line, then its status
 * line (tag and recovery) only when there is something to say, then the meters.
 */
function AccountRow({ row }: { readonly row: AccountRowView }) {
  return (
    <span className="grid w-full min-w-0 gap-1 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <AccountMark label={row.shortLabel} auto={false} indicatorBackground="var(--popover)" />
        <span className="shrink-0 font-medium text-sm">{row.name}</span>
        {row.current ? <span className="sr-only">(this thread)</span> : null}
        {row.emailMasked ? (
          <span className="min-w-0 truncate text-muted-foreground/70 text-2xs">
            {row.emailMasked}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {row.sessions > 0 ? (
            <span className="text-muted-foreground text-2xs tabular-nums">{`in use · ${row.sessions}`}</span>
          ) : null}
          <MenuRadioItemIndicator />
        </span>
      </span>
      {row.tag || row.recoversIn ? (
        <span className="flex min-w-0 items-center gap-1.5 ps-5.5">
          {row.tag ? <TagPill tag={row.tag} /> : null}
          {row.recoversIn ? (
            <span className="shrink-0 text-muted-foreground text-2xs tabular-nums">
              {row.recoversIn}
            </span>
          ) : null}
        </span>
      ) : null}
      {row.windows.length > 0 ? (
        <span className="grid grid-cols-3 gap-3 ps-5.5">
          {row.windows.map((win) => (
            <span key={win.id} className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 items-baseline justify-between gap-1 text-2xs">
                <span className="truncate text-muted-foreground">{win.label}</span>
                <span className={cn("shrink-0 tabular-nums", BAND_TEXT_CLASS[win.band])}>
                  {win.used}%
                </span>
              </span>
              <UsageBar used={win.used} band={win.band} />
              <span className="truncate text-3xs text-muted-foreground tabular-nums">
                {win.resetsIn ?? "\u00a0"}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function ClaudeAccountPickerMenu(props: {
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
    hoveredValue !== null && switchRestartsSession(account, valueMode(hoveredValue));

  const triggerText =
    view.kind === "auto-unresolved"
      ? "Auto"
      : view.weeklyUsed === null
        ? null
        : `${view.weeklyUsed}%`;
  const triggerTextClass =
    view.kind !== "account"
      ? null
      : view.warn === "logged_out" || view.warn === "limit"
        ? "text-destructive-foreground"
        : view.weeklyBand
          ? BAND_TEXT_CLASS[view.weeklyBand]
          : null;

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
            <span data-composer-control-label className={cn("tabular-nums", triggerTextClass)}>
              {triggerText}
            </span>
          ) : null}
          <ComposerControlChevron size={size} />
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-[23rem]" {...composerFloatingLayerProps}>
        <span className="grid gap-0.5 px-2 pt-1 pb-1">
          <span className="font-semibold text-muted-foreground text-2xs uppercase tracking-wide">
            Claude account
          </span>
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
            <span className="flex w-full items-center gap-2 py-0.5">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-medium text-sm">{AUTO_ACCOUNT_LABEL}</span>
                <span className="truncate text-muted-foreground text-2xs">
                  {autoRowDetail(account)}
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
                className={cn(row.current && "bg-accent/40")}
                closeOnClick
                onMouseEnter={() => setHoveredValue(value)}
                onFocus={() => setHoveredValue(value)}
              >
                <AccountRow row={row} />
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {hoveredSwitches ? (
          <span className="block px-2 pt-1 pb-0.5 text-2xs text-muted-foreground">
            {props.running
              ? `${SWITCH_RESTARTS_SESSION_HINT}, after this turn.`
              : `${SWITCH_RESTARTS_SESSION_HINT}.`}
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
 * account stream is only opened while a Claude instance is selected, and the
 * host reads nothing from it but the on/off answer.
 */
/**
 * Owns the snapshot and thread streams, so their frames re-render only the
 * picker and never the composer that hosts it.
 */
function ClaudeAccountPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly running: boolean;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const snapshot = useClaudeAccountsSnapshot(props.environmentId);
  if (snapshot === null || !snapshot.enabled) return null;
  return (
    <ClaudeAccountPickerMenu
      threadRef={props.threadRef}
      snapshot={snapshot}
      running={props.running}
      size={props.size}
      hidden={props.hidden}
    />
  );
}

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
  const enabled = useClaudeAccountsEnabled(applies ? input.environmentId : null);
  if (!applies || !enabled) return null;
  return (
    <ClaudeAccountPicker
      environmentId={input.environmentId}
      threadRef={input.threadRef}
      running={input.running}
      size={input.size}
      hidden={input.hidden}
    />
  );
}
