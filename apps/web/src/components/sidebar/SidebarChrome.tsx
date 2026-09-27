// T3-CUSTOM(expbkt3): import reformatted to multi-line to fit the fork's added icons below.
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  // T3-CUSTOM(expbkt3): sync and environment-notice icons.
  LoaderIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
// T3-CUSTOM(expbkt3): useEffect/useMemo/useState back the lifecycle counters.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../../experimentalFeatures";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
// T3-CUSTOM(expbkt3): lifecycle counters.
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
// T3-CUSTOM(expbkt3): environment-connection notices.
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  // T3-CUSTOM(expbkt3): environment notices group.
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
// T3-CUSTOM(expbkt3): lifecycle counters.
import { summarizeSidebarSessions } from "./sidebarSessionCounters";
import { useUiStateStore } from "../../uiStateStore";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        // T3-CUSTOM(expbkt3): the brand row grows to wrap the lifecycle counters.
        "@container/sidebar-header relative flex h-auto min-h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-0 px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className="relative top-auto z-10 translate-y-0 md:hidden"
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const { environments } = useEnvironments();
  // T3-CUSTOM(expbkt3): BEGIN — derive experimental global unsettled/running counters.
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const stageLabel = useEnvironmentStageLabel();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const counts = useMemo(() => {
    void snoozeWakeTick;
    return summarizeSidebarSessions(threads, {
      now: new Date().toISOString(),
      snoozeSupported: (thread) =>
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true,
      lastVisitedAtByThreadKey,
    });
  }, [lastVisitedAtByThreadKey, serverConfigs, snoozeWakeTick, threads]);
  useEffect(() => {
    const nextWakeAtMs = Date.parse(counts.nextSnoozeWakeAt ?? "");
    if (!Number.isFinite(nextWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [counts.nextSnoozeWakeAt]);
  // T3-CUSTOM(expbkt3): END
  const syncing = environments.some(
    (environment) =>
      environment.connection.phase === "connecting" ||
      environment.connection.phase === "reconnecting",
  );

  return (
    // T3-CUSTOM(expbkt3): the brand link sits inside a flex row that also carries
    // the lifecycle counters, so upstream's outer <Link> became this wrapper and
    // its collapse rule moved onto the brand link itself.
    <div
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden"
      data-testid="sidebar-brand-layout"
    >
      <Link
        aria-label="Go to threads"
        className={cn(
          "hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
          onBackdrop ? "text-white" : "text-foreground",
        )}
        to="/"
      >
        {/* Center the visible capitals, without the font's ascender/descender space. */}
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
          <span
            className={cn(
              "truncate [text-box:trim-both_cap_alphabetic]",
              onBackdrop ? "text-white/70" : "text-muted-foreground",
            )}
          >
            Code
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em]",
            onBackdrop ? "bg-white/10 text-white/60" : "bg-muted/50 text-muted-foreground/60",
          )}
        >
          {stageLabel}
        </span>
      </Link>
      {/* T3-CUSTOM(expbkt3): BEGIN — compact lifecycle counters beside the wordmark:
          unread, running, unsettled. Same three, same order, on mobile. */}
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? (
        <div className="flex shrink-0 items-center gap-1" aria-label="Session status summary">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "inline-flex h-7 min-w-8 items-center justify-center rounded-lg border px-1.5 text-base font-black tabular-nums",
                    counts.unread > 0
                      ? onBackdrop
                        ? "border-sky-200/60 bg-sky-400/30 text-white"
                        : "border-sky-500/35 bg-sky-500/15 text-sky-700 dark:text-sky-300"
                      : onBackdrop
                        ? "border-white/20 bg-white/8 text-white/60"
                        : "border-border/60 bg-muted/40 text-muted-foreground/60",
                  )}
                  data-testid="sidebar-count-unread"
                  role="status"
                  aria-label={`${counts.unread} unread session${counts.unread === 1 ? "" : "s"}`}
                >
                  {counts.unread}
                </span>
              }
            />
            <TooltipPopup side="bottom">Unread — finished since you last opened them</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "inline-flex h-7 min-w-8 items-center justify-center rounded-lg border px-1.5 text-base font-black tabular-nums",
                    onBackdrop
                      ? "border-white/25 bg-white/12 text-white"
                      : "border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
                  )}
                  data-testid="sidebar-count-running"
                  aria-label={`${counts.running} session${counts.running === 1 ? "" : "s"} running`}
                  role="status"
                >
                  {counts.running}
                </span>
              }
            />
            <TooltipPopup side="bottom">Running — an agent is working</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "inline-flex h-7 min-w-8 items-center justify-center rounded-lg border px-1.5 text-base font-black tabular-nums",
                    counts.nonRunning >= 2
                      ? onBackdrop
                        ? "border-orange-400/50 bg-orange-500/15 text-orange-400"
                        : "border-orange-500/45 bg-orange-500/12 text-orange-600 dark:text-orange-300"
                      : onBackdrop
                        ? "border-emerald-200/60 bg-emerald-400/30 text-white"
                        : "border-emerald-500/35 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
                  )}
                  data-attention-state={counts.nonRunning >= 2 ? "attention" : "clear"}
                  data-testid="sidebar-count-unsettled"
                  role="status"
                  aria-label={`${counts.nonRunning} unsettled session${counts.nonRunning === 1 ? "" : "s"} waiting on you`}
                >
                  {counts.nonRunning}
                </span>
              }
            />
            <TooltipPopup side="bottom">Unsettled — idle and waiting on you</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {/* T3-CUSTOM(expbkt3): END */}
      {syncing ? (
        <div className="flex h-7 max-w-full shrink-0 items-center gap-1.5 overflow-hidden">
          <span
            aria-label="Connection interrupted. Syncing…"
            className="inline-flex shrink-0"
            role="status"
          >
            <LoaderIcon
              className={cn(
                "size-3 animate-spin",
                onBackdrop ? "text-white/70" : "text-muted-foreground/70",
              )}
            />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});

// T3-CUSTOM(expbkt3): BEGIN — surfaces connecting/failed desktop-local secondary
// environment bootstraps as sidebar notices.
export function SidebarEnvironmentNotices() {
  const { environments } = useEnvironments();
  const secondaries = useDesktopLocalBootstraps();
  const localEnvByUrl = useMemo(() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  }, [environments]);

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const environment = bootstrap.httpBaseUrl
      ? localEnvByUrl.get(bootstrap.httpBaseUrl)
      : undefined;
    if (environment?.phase === "connected") continue;
    if (environment?.phase === "error") {
      failed.push({ label: bootstrap.label, error: environment.error });
    } else {
      connecting.push(bootstrap.label);
    }
  }

  if (connecting.length === 0 && failed.length === 0) return null;

  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      {connecting.length > 0 ? (
        <Alert
          variant="default"
          className="rounded-2xl border-border/40 bg-accent/40 text-muted-foreground"
        >
          <LoaderIcon className="animate-spin" />
          <AlertTitle className="text-xs font-medium text-foreground">
            Connecting {connecting.join(", ")}
          </AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}
// T3-CUSTOM(expbkt3): END
