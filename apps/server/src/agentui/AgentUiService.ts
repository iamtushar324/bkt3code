/**
 * T3-CUSTOM(expbkt3): agent-rendered UI surfaces shown inline in the chat.
 *
 * The `t3_show_ui` MCP tool records a render here and gets back a short handle;
 * the chat later fetches the body by that handle. Keeping the two halves in one
 * fork-owned service means the validation an agent's input goes through — size
 * caps, height clamping, URL scheme — is the same validation the reader relies
 * on, and none of it lives in an upstream file.
 */
import {
  AGENT_UI_DEFAULT_HEIGHT,
  AGENT_UI_MAX_HEIGHT,
  AGENT_UI_MAX_HTML_CHARS,
  AGENT_UI_MIN_HEIGHT,
  AgentUiError,
  type AgentUiRenderHandle,
  type AgentUiRenderRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AgentUiRepository } from "../persistence/AgentUiRenders.ts";

export interface ShowUiInput {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly html?: string | undefined;
  readonly url?: string | undefined;
  readonly height?: number | undefined;
}

export interface AgentUiServiceShape {
  readonly show: (input: ShowUiInput) => Effect.Effect<AgentUiRenderHandle, AgentUiError>;
  readonly getRender: (input: {
    readonly threadId: ThreadId;
    readonly renderId: string;
  }) => Effect.Effect<AgentUiRenderRecord | null, AgentUiError>;
}

export class AgentUiService extends Context.Service<AgentUiService, AgentUiServiceShape>()(
  "t3/agentui/AgentUiService",
) {}

function clampHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return AGENT_UI_DEFAULT_HEIGHT;
  return Math.max(AGENT_UI_MIN_HEIGHT, Math.min(Math.round(height), AGENT_UI_MAX_HEIGHT));
}

/**
 * Only https is embeddable. http would be blocked as mixed content on every
 * hosted deployment, and the non-network schemes are how a framed document
 * would reach back at the app.
 */
function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? parsed.toString() : null;
}

export const make = Effect.gen(function* () {
  const repository = yield* AgentUiRepository;
  const crypto = yield* Crypto.Crypto;

  // A failing CSPRNG is a defect, not something a caller can recover from.
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const show: AgentUiServiceShape["show"] = (input) =>
    Effect.gen(function* () {
      const title = input.title.trim() || "Agent view";
      const html = input.html?.trim() ?? "";
      const rawUrl = input.url?.trim() ?? "";

      if (html.length === 0 && rawUrl.length === 0) {
        return yield* new AgentUiError({
          operation: "show",
          message: "Provide either `html` or `url`.",
        });
      }
      if (html.length > 0 && rawUrl.length > 0) {
        return yield* new AgentUiError({
          operation: "show",
          message: "Provide only one of `html` or `url`, not both.",
        });
      }
      if (html.length > AGENT_UI_MAX_HTML_CHARS) {
        return yield* new AgentUiError({
          operation: "show",
          message: `The document is ${html.length} characters; the limit is ${AGENT_UI_MAX_HTML_CHARS}. Render a smaller view, or link to a URL.`,
        });
      }

      const url = rawUrl.length > 0 ? normalizeUrl(rawUrl) : null;
      if (rawUrl.length > 0 && url === null) {
        return yield* new AgentUiError({
          operation: "show",
          message: "`url` must be an absolute https:// URL.",
        });
      }

      const kind = url === null ? ("html" as const) : ("url" as const);
      const height = clampHeight(input.height);
      const renderId = `aui_${(yield* uuid).replaceAll("-", "").slice(0, 20)}`;
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

      yield* repository
        .insertRender({
          renderId,
          threadId: input.threadId,
          title,
          kind,
          html: kind === "html" ? html : null,
          url,
          height,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentUiError({
                operation: "show",
                message: `Could not store the view: ${String(cause)}`,
              }),
          ),
        );

      return { renderId, kind, height, title } satisfies AgentUiRenderHandle;
    });

  const getRender: AgentUiServiceShape["getRender"] = (input) =>
    repository.getRender(input).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(
        (cause) =>
          new AgentUiError({
            operation: "get-render",
            message: `Could not read the view: ${String(cause)}`,
          }),
      ),
    );

  return AgentUiService.of({ show, getRender });
});

export const layer = Layer.effect(AgentUiService, make);
