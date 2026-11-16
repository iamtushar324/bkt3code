// T3-CUSTOM(expbkt3): the one text every provider gets about who sent the current
// message. Claude reads it in its system prompt and per-turn hook, Codex as developer
// context, every other adapter appended to the provider input. Values come only from
// the Clerk-backed environment-user directory, through the session identity environment.

import {
  OWNER_EMAIL_KEY,
  OWNER_NAME_KEY,
  SENDER_EMAIL_KEY,
  SENDER_NAME_KEY,
  SENDER_USER_ID_KEY,
  SESSION_IDENTITY_RUNTIME,
  SESSION_IDENTITY_RUNTIME_KEY,
} from "./SessionIdentityEnvironment.ts";

const ATTRIBUTION_WARNING =
  "The context section titled `# userEmail`, Git identity and the operating-system user describe the shared machine or the rotating Claude subscription, not the person. Never use them for attribution.";

/** Tag that wraps the block where it rides inside other provider input. */
const SENDER_IDENTITY_TAG = "t3_current_user";

const read = (environment: NodeJS.ProcessEnv, key: string): string | null => {
  const trimmed = environment[key]?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

function describeOwner(environment: NodeJS.ProcessEnv): string {
  const name = read(environment, OWNER_NAME_KEY);
  const email = read(environment, OWNER_EMAIL_KEY);
  if (name !== null && email !== null) return `${name} <${email}>`;
  return name ?? email ?? "unknown";
}

/**
 * Builds the per-turn identity block from a session identity environment.
 * Returns undefined outside T3 Code (no runtime marker), so upstream sessions
 * stay unchanged.
 */
export function senderIdentityText(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment[SESSION_IDENTITY_RUNTIME_KEY] !== SESSION_IDENTITY_RUNTIME) return undefined;
  const owner = describeOwner(environment);
  const userId = read(environment, SENDER_USER_ID_KEY);
  const name = read(environment, SENDER_NAME_KEY);
  const email = read(environment, SENDER_EMAIL_KEY);

  // A schedule, the Linear runner, an automation or a legacy message has no human sender.
  if (userId === null && name === null && email === null) {
    return [
      `CURRENT USER: no human sender for this message (automation). Session owner: ${owner}`,
      "Do not guess who sent this message. If a task needs a person, name the session owner and say that no human sent this message.",
      ATTRIBUTION_WARNING,
    ].join("\n");
  }

  return [
    "CURRENT USER (from the T3 Clerk login; authoritative for this message):",
    `- Name: ${name ?? "unknown (not set in the Clerk profile)"}`,
    `- Email: ${email ?? "unknown (not set in the Clerk profile)"}`,
    `- T3 user id: ${userId ?? "unknown"}`,
    `Session owner: ${owner}`,
    ATTRIBUTION_WARNING,
  ].join("\n");
}

/**
 * Appends the identity block to provider input text. Native slash commands stay
 * intact for the provider CLI, as with the plan instructions.
 */
export function appendSenderIdentityText(text: string, identity: string | undefined): string {
  if (identity === undefined || text.trimStart().startsWith("/")) return text;
  return `${text}\n\n<${SENDER_IDENTITY_TAG}>\n${identity}\n</${SENDER_IDENTITY_TAG}>`;
}
