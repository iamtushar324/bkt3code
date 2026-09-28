// T3-CUSTOM(expbkt3): fork-owned smart git button model, shared by web and mobile.
//
// The chat header's git button asks the agent to commit, push or open a change
// request instead of running git itself. `resolveSmartGitIntent` reads the same
// signals as upstream's `resolveQuickAction` (gitActions.ts); `pull`, `view_pr`
// and `none` are not prompts, so the clients keep upstream's quick action for
// them (direct pull, open the PR, or a disabled hint).
import type { VcsStatusResult } from "@t3tools/contracts";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";

export type SmartGitIntentKind = "commit" | "push" | "create_pr" | "view_pr" | "pull" | "none";

/** Intents answered by sending a prompt to the agent. */
export type SmartGitPromptIntent = Extract<SmartGitIntentKind, "commit" | "push" | "create_pr">;

export interface SmartGitIntent {
  readonly intent: SmartGitIntentKind;
  /** Pending work the user should act on: shown with the theme's primary look. */
  readonly highlighted: boolean;
  readonly label: string;
  /** Why this intent was picked, or why nothing can be done ("3 files changed"). */
  readonly hint?: string;
}

export interface SmartGitIntentOptions {
  /** A direct git action (upstream's commit / push / pull) is already running. */
  readonly isBusy: boolean;
  readonly isDefaultRef: boolean;
  readonly hasPrimaryRemote: boolean;
}

export function isSmartGitPromptIntent(intent: SmartGitIntentKind): intent is SmartGitPromptIntent {
  return intent === "commit" || intent === "push" || intent === "create_pr";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function terminologyFor(gitStatus: VcsStatusResult): ChangeRequestTerminology {
  return gitStatus.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

/**
 * The branch a new change request should target: an open request's base, else
 * the base T3 recorded when it created the worktree. Null means "the default
 * branch", which the prompt leaves to the agent.
 */
export function resolveSmartGitBaseBranch(gitStatus: VcsStatusResult | null): string | null {
  if (!gitStatus) return null;
  return gitStatus.pr?.baseRef ?? gitStatus.baseRef ?? null;
}

function none(label: string, hint: string): SmartGitIntent {
  return { intent: "none", highlighted: false, label, hint };
}

function commitIntent(gitStatus: VcsStatusResult, isDefaultRef: boolean): SmartGitIntent {
  const fileCount = gitStatus.workingTree.files.length;
  const changed = fileCount > 0 ? `${plural(fileCount, "file")} changed` : "Uncommitted changes";
  return {
    intent: "commit",
    highlighted: true,
    label: "Commit",
    hint: isDefaultRef ? `${changed} on the default branch` : changed,
  };
}

function pushIntent(gitStatus: VcsStatusResult, terminology: ChangeRequestTerminology) {
  const commits = plural(gitStatus.aheadCount, "commit");
  const openPr = gitStatus.pr?.state === "open" ? gitStatus.pr : null;
  return {
    intent: "push",
    highlighted: true,
    label: "Push",
    hint: openPr
      ? `${commits} not pushed to ${terminology.shortLabel} #${openPr.number}`
      : `${commits} not pushed`,
  } satisfies SmartGitIntent;
}

function createPrIntent(
  gitStatus: VcsStatusResult,
  terminology: ChangeRequestTerminology,
): SmartGitIntent {
  const count = gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount;
  const base = resolveSmartGitBaseBranch(gitStatus) ?? "the default branch";
  return {
    intent: "create_pr",
    highlighted: true,
    label: `Create ${terminology.shortLabel}`,
    hint:
      count > 0 ? `${plural(count, "commit")} ahead of ${base}` : `Ready to open against ${base}`,
  };
}

function viewPrIntent(
  gitStatus: VcsStatusResult,
  terminology: ChangeRequestTerminology,
): SmartGitIntent {
  const number = gitStatus.pr?.number;
  return {
    intent: "view_pr",
    highlighted: false,
    label: `View ${terminology.shortLabel}`,
    hint:
      number === undefined
        ? `${terminology.shortLabel} is open`
        : `${terminology.shortLabel} #${number} is open`,
  };
}

/**
 * What the smart git button offers for a worktree. Mirrors upstream's
 * `resolveQuickAction` decision order, but splits "commit, push & PR" into
 * one step per click: commit first, then create the change request.
 */
export function resolveSmartGitIntent(
  gitStatus: VcsStatusResult | null,
  options: SmartGitIntentOptions,
): SmartGitIntent {
  if (options.isBusy) return none("Commit", "Git action in progress.");
  if (!gitStatus) return none("Commit", "Git status is unavailable.");
  if (!gitStatus.isRepo) return none("Commit", "This workspace is not a git repository.");

  const terminology = terminologyFor(gitStatus);
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;

  if (gitStatus.refName === null) {
    return none(
      "Commit",
      `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    );
  }

  if (gitStatus.hasWorkingTreeChanges) {
    return commitIntent(gitStatus, options.isDefaultRef);
  }

  if (!gitStatus.hasUpstream) {
    if (!options.hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) return viewPrIntent(gitStatus, terminology);
      // Upstream offers "Publish repository" here; that stays a direct action.
      return none("Publish repository", "Add a remote before pushing.");
    }
    if (!isAhead) {
      if (hasOpenPr) return viewPrIntent(gitStatus, terminology);
      return none("Push", "No local commits to push.");
    }
    if (hasOpenPr || options.isDefaultRef) return pushIntent(gitStatus, terminology);
    return createPrIntent(gitStatus, terminology);
  }

  if (isAhead && isBehind) {
    return none("Sync ref", "Branch has diverged from upstream. Rebase/merge first.");
  }

  if (isBehind) {
    return {
      intent: "pull",
      highlighted: false,
      label: "Pull",
      hint: `${plural(gitStatus.behindCount, "commit")} behind upstream`,
    };
  }

  if (isAhead) {
    if (hasOpenPr || options.isDefaultRef) return pushIntent(gitStatus, terminology);
    return createPrIntent(gitStatus, terminology);
  }

  if (hasOpenPr) return viewPrIntent(gitStatus, terminology);

  if (hasDefaultBranchDelta && !options.isDefaultRef) {
    return createPrIntent(gitStatus, terminology);
  }

  return none("Commit", "Branch is up to date. No action needed.");
}

export interface SmartGitPromptOptions {
  /** Target branch for a new change request; null leaves it to the repository default. */
  readonly baseBranch: string | null;
  /** Provider wording, e.g. "pull request" or "merge request". */
  readonly changeRequestTerm: string;
  /** Push into an open change request rather than just the branch. */
  readonly hasOpenChangeRequest?: boolean;
}

/** The message sent into the thread when the user clicks a smart git intent. */
export function buildSmartGitPrompt(
  intent: SmartGitPromptIntent,
  options: SmartGitPromptOptions,
): string {
  const term = options.changeRequestTerm;
  switch (intent) {
    case "commit":
      return "Commit all current changes in this worktree with a clear, conventional commit message that explains why. Do not push.";
    case "create_pr": {
      const base = options.baseBranch ? `\`${options.baseBranch}\`` : "the default branch";
      return `Push this branch and open a ${term} against ${base} with a clear title and a description that summarises the changes and how they were tested. Reply with the ${term} link.`;
    }
    case "push":
      return options.hasOpenChangeRequest
        ? `Push the new commits to the existing ${term} and reply with its link.`
        : `Push the new commits on this branch to its remote. Do not open a ${term}.`;
  }
}

/** The prompt for a resolved intent, or null when the intent is not a prompt. */
export function smartGitPromptForStatus(
  intent: SmartGitIntent,
  gitStatus: VcsStatusResult | null,
): string | null {
  if (!gitStatus || !isSmartGitPromptIntent(intent.intent)) return null;
  return buildSmartGitPrompt(intent.intent, {
    baseBranch: resolveSmartGitBaseBranch(gitStatus),
    changeRequestTerm: terminologyFor(gitStatus).singular,
    hasOpenChangeRequest: gitStatus.pr?.state === "open",
  });
}

export type SmartGitDelivery = "send" | "queue";

/**
 * Whether a smart git prompt starts a turn now or waits in the thread's queue.
 * It waits behind a running turn, and behind queued messages that will still
 * leave on their own so it cannot overtake them.
 */
export function resolveSmartGitDelivery(input: {
  readonly turnRunning: boolean;
  readonly queueStillSending: boolean;
}): SmartGitDelivery {
  return input.turnRunning || input.queueStillSending ? "queue" : "send";
}

/** Toast copy after a click, by intent and delivery. */
export function smartGitToastTitle(
  intent: SmartGitPromptIntent,
  delivery: SmartGitDelivery,
  changeRequestShortLabel: string,
): string {
  const verb =
    intent === "commit"
      ? "commit"
      : intent === "push"
        ? "push"
        : `open a ${changeRequestShortLabel}`;
  return delivery === "queue"
    ? `Queued: will ask the agent to ${verb}`
    : `Asked the agent to ${verb}`;
}
