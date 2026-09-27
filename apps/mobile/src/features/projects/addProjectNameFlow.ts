export type AddProjectNameInput =
  | {
      readonly kind: "local";
      readonly environmentId: string;
      readonly workspaceRoot: string;
      readonly suggestedNickname: string;
    }
  | {
      readonly kind: "clone";
      readonly environmentId: string;
      readonly remoteUrl: string;
      readonly destinationPath: string;
      readonly repositoryTitle: string;
      readonly suggestedNickname: string;
    };

type RouteValue = string | string[] | undefined;

export type AddProjectNameRouteParams = {
  readonly kind?: RouteValue;
  readonly environmentId?: RouteValue;
  readonly workspaceRoot?: RouteValue;
  readonly remoteUrl?: RouteValue;
  readonly destinationPath?: RouteValue;
  readonly repositoryTitle?: RouteValue;
  readonly suggestedNickname?: RouteValue;
};

function first(value: RouteValue): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const trimmed = candidate?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveAddProjectNameInput(
  params: AddProjectNameRouteParams | undefined,
): AddProjectNameInput | null {
  const kind = first(params?.kind);
  const environmentId = first(params?.environmentId);
  const suggestedNickname = first(params?.suggestedNickname);
  if (!environmentId || !suggestedNickname) return null;

  if (kind === "local") {
    const workspaceRoot = first(params?.workspaceRoot);
    return workspaceRoot ? { kind, environmentId, workspaceRoot, suggestedNickname } : null;
  }
  if (kind === "clone") {
    const remoteUrl = first(params?.remoteUrl);
    const destinationPath = first(params?.destinationPath);
    const repositoryTitle = first(params?.repositoryTitle);
    return remoteUrl && destinationPath && repositoryTitle
      ? {
          kind,
          environmentId,
          remoteUrl,
          destinationPath,
          repositoryTitle,
          suggestedNickname,
        }
      : null;
  }
  return null;
}
