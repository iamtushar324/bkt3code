/**
 * T3-CUSTOM(expbkt3): the bounded session detail `t3_get_session` returns.
 *
 * MCP clients move a result above their output limit to a file, or refuse it,
 * and 419 of 1,076 session reads went over: one long assistant message, a plan
 * document or a tool payload can be larger than the rest of the session. The
 * message and activity limits choose how far back to read; these caps keep
 * each record short, and a final budget sheds the oldest records until the
 * result fits. `omitted` says what was cut and where to read the rest.
 */
import type { OrchestrationThread } from "@t3tools/contracts";

export const SESSION_DETAIL_MAX_CHARS = 60_000;
const MESSAGE_TEXT_MAX_CHARS = 6_000;
const PLAN_MARKDOWN_MAX_CHARS = 6_000;
const ACTIVITY_PAYLOAD_MAX_CHARS = 1_500;
const CHECKPOINTS_KEPT = 5;
const CHECKPOINT_FILES_KEPT = 20;

const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;

const jsonLength = (value: unknown) => JSON.stringify(value)?.length ?? 0;

/** The first heading or line of a plan, so an older plan stays recognisable without its body. */
const planHeadline = (markdown: string) =>
  cutText(
    markdown
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "",
    200,
  );

export function boundSessionDetail(
  thread: OrchestrationThread,
  limits: { readonly messageLimit: number; readonly activityLimit: number },
) {
  const omitted: Array<string> = [];

  // A start past the end keeps nothing; a negative one keeps everything.
  let messages = thread.messages.slice(thread.messages.length - limits.messageLimit);
  const olderMessages = thread.messages.length - messages.length;
  const longMessages = messages.filter((message) => message.text.length > MESSAGE_TEXT_MAX_CHARS);
  messages = messages.map((message) =>
    message.text.length > MESSAGE_TEXT_MAX_CHARS
      ? { ...message, text: cutText(message.text, MESSAGE_TEXT_MAX_CHARS) }
      : message,
  );
  if (longMessages.length > 0) {
    omitted.push(
      `text after ${MESSAGE_TEXT_MAX_CHARS} characters in ${longMessages.length} message(s); read them whole with t3_thread_read`,
    );
  }

  let activities = thread.activities.slice(thread.activities.length - limits.activityLimit);
  const olderActivities = thread.activities.length - activities.length;
  let cutPayloads = 0;
  activities = activities.map((activity) => {
    const size = jsonLength(activity.payload);
    if (size <= ACTIVITY_PAYLOAD_MAX_CHARS) return activity;
    cutPayloads += 1;
    return { ...activity, payload: `[payload omitted: ${size} characters]` };
  });
  if (cutPayloads > 0) {
    omitted.push(
      `${cutPayloads} activity payload(s) larger than ${ACTIVITY_PAYLOAD_MAX_CHARS} characters`,
    );
  }

  // The newest plan is the one a reader acts on; older ones keep their headline.
  const plans = thread.proposedPlans.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const proposedPlans = plans.map((plan, index) => {
    const newest = index === plans.length - 1;
    if (newest) {
      return {
        ...plan,
        planMarkdown: cutText(plan.planMarkdown, PLAN_MARKDOWN_MAX_CHARS),
      };
    }
    const { planMarkdown, ...rest } = plan;
    return { ...rest, headline: planHeadline(planMarkdown) };
  });
  if (plans.length > 1) {
    omitted.push(`the text of ${plans.length - 1} older proposed plan(s); each keeps its headline`);
  }
  const newestPlan = plans.at(-1);
  if (newestPlan !== undefined && newestPlan.planMarkdown.length > PLAN_MARKDOWN_MAX_CHARS) {
    omitted.push(`the newest plan's text after ${PLAN_MARKDOWN_MAX_CHARS} characters`);
  }

  const checkpoints = thread.checkpoints.slice(-CHECKPOINTS_KEPT).map((checkpoint) =>
    checkpoint.files.length > CHECKPOINT_FILES_KEPT
      ? {
          ...checkpoint,
          files: checkpoint.files.slice(0, CHECKPOINT_FILES_KEPT),
          filesOmitted: checkpoint.files.length - CHECKPOINT_FILES_KEPT,
        }
      : checkpoint,
  );
  if (thread.checkpoints.length > CHECKPOINTS_KEPT) {
    omitted.push(`${thread.checkpoints.length - CHECKPOINTS_KEPT} older checkpoint(s)`);
  }

  const pullRequests = thread.pullRequests.map((link) => ({
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    checksState: link.snapshot?.checksState ?? null,
    reviewDecision: link.snapshot?.reviewDecision ?? null,
  }));

  const build = () => ({
    ...thread,
    messages,
    activities,
    proposedPlans,
    checkpoints,
    pullRequests,
  });

  // Shed the oldest records, activities first, until the detail fits.
  let shedMessages = 0;
  let shedActivities = 0;
  while (jsonLength(build()) > SESSION_DETAIL_MAX_CHARS) {
    if (activities.length > 0) {
      const keep = Math.floor(activities.length / 2);
      shedActivities += activities.length - keep;
      activities = keep === 0 ? [] : activities.slice(-keep);
    } else if (messages.length > 1) {
      const keep = Math.floor(messages.length / 2);
      shedMessages += messages.length - keep;
      messages = messages.slice(-keep);
    } else {
      break;
    }
  }
  if (olderMessages + shedMessages > 0) {
    omitted.push(
      `${olderMessages + shedMessages} older message(s); raise messageLimit or read them with t3_thread_read`,
    );
  }
  if (olderActivities + shedActivities > 0) {
    omitted.push(`${olderActivities + shedActivities} older activity record(s)`);
  }
  return { thread: build(), omitted };
}
