import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  WS_FORK_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";

import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { normalizeWebUiStreamOptions } from "./bridge.ts";
import {
  getWebUiVirtualTool,
  getWebUiVirtualToolDetail,
  isWebUiVirtualToolAuthorized,
  WEB_UI_STREAM_TOOL_COUNT,
  WEB_UI_VIRTUAL_TOOL_COUNT,
  WEB_UI_VIRTUAL_TOOLS,
  webUiVirtualToolName,
} from "./catalog.ts";
import { makeWebUiAuthenticatedSession } from "./session.ts";

const invocation = (
  principal: McpInvocationContext.McpInvocationScope["principal"],
  actorUserId: UserId | null,
): McpInvocationContext.McpInvocationScope => ({
  principal,
  actorUserId,
  environmentId: EnvironmentId.make("environment-web-ui-catalog-test"),
  threadId: ThreadId.make("thread-web-ui-catalog-test"),
  providerSessionId: "provider-session-web-ui-catalog-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
});

it("generates one unique virtual tool and complete schemas for every web RPC", () => {
  // T3-CUSTOM(expbkt3): the catalog includes native V2 methods and every retained fork RPC.
  expect(WEB_UI_VIRTUAL_TOOL_COUNT).toBe(226);
  expect(WEB_UI_STREAM_TOOL_COUNT).toBe(31);
  expect(WEB_UI_VIRTUAL_TOOL_COUNT).toBe(WsRpcGroup.requests.size);
  expect(new Set(WEB_UI_VIRTUAL_TOOLS.map((tool) => tool.name)).size).toBe(
    WEB_UI_VIRTUAL_TOOL_COUNT,
  );
  expect(new Set(WEB_UI_VIRTUAL_TOOLS.map((tool) => tool.method))).toEqual(
    new Set(WsRpcGroup.requests.keys()),
  );

  for (const tool of WEB_UI_VIRTUAL_TOOLS) {
    const detail = getWebUiVirtualToolDetail(tool.name);
    expect(detail).toBeDefined();
    expect(detail?.inputSchema).toBeDefined();
    expect(detail?.successSchema).toBeDefined();
    expect(detail?.errorSchema).toBeDefined();
  }
});

it("exposes the five Toolyard and webhook RPCs with their required scopes", () => {
  const methods = [
    [WS_FORK_METHODS.toolyardIntegrationStatus, "orchestration:read"],
    [WS_FORK_METHODS.toolyardIntegrationConfigure, "access:write"],
    [WS_FORK_METHODS.toolyardDashboardHandoff, "orchestration:operate"],
    [WS_FORK_METHODS.sessionWebhooksList, "orchestration:read"],
    [WS_FORK_METHODS.sessionWebhooksUpdate, "orchestration:operate"],
  ] as const;
  for (const [method, requiredScope] of methods) {
    const tool = getWebUiVirtualTool(webUiVirtualToolName(method));
    expect(tool).toMatchObject({ method, requiredScope, stream: false });
    expect(isWebUiVirtualToolAuthorized(tool!, AuthStandardClientScopes)).toBe(
      requiredScope !== "access:write",
    );
    expect(isWebUiVirtualToolAuthorized(tool!, AuthAdministrativeScopes)).toBe(true);
  }
});

it("uses stable, code-mode-friendly virtual tool names", () => {
  expect(webUiVirtualToolName("server.getConfig")).toBe("t3_ui_server_get_config");
  expect(webUiVirtualToolName("sourceControl.profiles.replaceCredential")).toBe(
    "t3_ui_source_control_profiles_replace_credential",
  );
  expect(getWebUiVirtualTool("t3_ui_server_get_config")?.method).toBe("server.getConfig");
});

it("maps user principals to standard web scopes and operators to administrative scopes", () => {
  const actorUserId = UserId.make("user-web-ui-catalog-test");
  const externalUser = makeWebUiAuthenticatedSession(invocation("external-user", actorUserId));
  expect(externalUser.userId).toBe(actorUserId);
  expect(externalUser.subject).toBe(`clerk:${actorUserId}`);
  expect(externalUser.scopes).toEqual(AuthStandardClientScopes);
  expect(
    isWebUiVirtualToolAuthorized(
      getWebUiVirtualTool("t3_ui_subscribe_auth_access")!,
      externalUser.scopes,
    ),
  ).toBe(false);
  expect(
    isWebUiVirtualToolAuthorized(
      getWebUiVirtualTool("t3_ui_cloud_install_relay_client")!,
      externalUser.scopes,
    ),
  ).toBe(false);
  expect(
    isWebUiVirtualToolAuthorized(
      getWebUiVirtualTool("t3_ui_server_update_settings")!,
      externalUser.scopes,
    ),
  ).toBe(true);

  const operator = makeWebUiAuthenticatedSession(invocation("external-operator", null));
  expect(operator.userId).toBeNull();
  expect(operator.scopes).toEqual(AuthAdministrativeScopes);

  const localProvider = makeWebUiAuthenticatedSession(invocation("provider-session", null));
  expect(localProvider.scopes).toEqual(AuthAdministrativeScopes);
});

it("bounds subscription and progress streams independently", () => {
  expect(normalizeWebUiStreamOptions("subscription", undefined)).toEqual({
    maxItems: 50,
    idleTimeoutMs: 1_500,
    totalTimeoutMs: 5_000,
  });
  expect(normalizeWebUiStreamOptions("progress", undefined)).toEqual({
    maxItems: 200,
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 300_000,
  });
  expect(
    normalizeWebUiStreamOptions("subscription", {
      maxItems: 50_000,
      idleTimeoutMs: 1,
      totalTimeoutMs: 1,
    }),
  ).toEqual({
    maxItems: 500,
    idleTimeoutMs: 100,
    totalTimeoutMs: 1_000,
  });
});
