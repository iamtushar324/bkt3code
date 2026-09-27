/**
 * ProjectAccessSettingsPanel - admin-only project access management (team mode).
 *
 * Clerk org admins grant workspace access to a project here. A member can open
 * the project and create their own threads in it (they own them); they do NOT
 * see other people's threads — sharing a thread is done per-thread. Renders an
 * access-denied notice for non-admins (the nav item is also hidden for them).
 *
 * @module components/settings/ProjectAccessSettingsPanel
 */
import type { EnvironmentId, OrchestrationUser, ProjectId, UserId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
// T3-CUSTOM(expbkt3): identify which machine each project lives on.
import { hasMultipleEnvironments, useEnvironmentAppearances } from "../../state/environments";
import { useIsTeamAdmin, useOrgMembers } from "../../state/orgMembers";
// T3-CUSTOM(expbkt3): BEGIN - only list projects whose own environment can store
// members; the dialog refuses to render for the others, so offering "Manage" for
// them would be a dead button.
import { filterTeamCapableEnvironments } from "../../fork/environmentTeamCapability";
import { environmentServerConfigsAtom } from "../../state/server";
// T3-CUSTOM(expbkt3): END
import { EnvironmentBadgeView } from "../environment/EnvironmentBadge";
import { ProjectMembersDialog } from "../members/ProjectMembersDialog";
import { AvatarStack } from "../ui/avatar";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface ProjectMembersTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function ProjectAccessSettingsPanel() {
  const isAdmin = useIsTeamAdmin();
  const projects = useProjects();
  const { resolveUser } = useOrgMembers();
  const [target, setTarget] = useState<ProjectMembersTarget | null>(null);

  // T3-CUSTOM(expbkt3): BEGIN — two environments contributing the same repository
  // render as identical rows (same title, same path). Sort by environment first so
  // the pairs sit together, and badge them so they are told apart.
  const appearances = useEnvironmentAppearances();
  // T3-CUSTOM(expbkt3): BEGIN - see the import above.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const teamProjects = useMemo(
    () =>
      filterTeamCapableEnvironments(projects, serverConfigs, (project) => project.environmentId),
    [projects, serverConfigs],
  );
  // T3-CUSTOM(expbkt3): END
  const showEnvironment = hasMultipleEnvironments(teamProjects);
  const sortedProjects = useMemo(
    () =>
      [...teamProjects].sort(
        (a, b) => a.title.localeCompare(b.title) || a.environmentId.localeCompare(b.environmentId),
      ),
    [teamProjects],
  );
  // T3-CUSTOM(expbkt3): END

  if (!isAdmin) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Project access">
          <p className="px-1 py-4 text-sm text-muted-foreground">
            Only workspace admins can manage project access.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Project access">
        <p className="px-3.5 pt-3.5 text-xs text-muted-foreground">
          Grant workspace access to a project. Members can open the project and create their own
          threads in it — they don&apos;t see other people&apos;s threads. Share a specific thread
          from its members menu.
        </p>
        {sortedProjects.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          sortedProjects.map((project) => {
            const memberUsers: ReadonlyArray<OrchestrationUser> = [
              ...(project.ownerUserId !== null ? [project.ownerUserId] : []),
              ...project.memberUserIds.filter((id): id is UserId => id !== project.ownerUserId),
            ].map((id) => resolveUser(id));
            return (
              <SettingsRow
                key={`${project.environmentId}:${project.id}`}
                title={project.title}
                description={project.workspaceRoot}
                control={
                  <div className="flex items-center gap-2">
                    {/* T3-CUSTOM(expbkt3): which machine this project lives on. */}
                    {showEnvironment && appearances.has(project.environmentId) ? (
                      <EnvironmentBadgeView appearance={appearances.get(project.environmentId)!} />
                    ) : null}
                    {memberUsers.length > 0 ? <AvatarStack users={memberUsers} size="sm" /> : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTarget({ environmentId: project.environmentId, projectId: project.id })
                      }
                    >
                      Manage
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      {target !== null ? (
        <ProjectMembersDialog
          environmentId={target.environmentId}
          projectId={target.projectId}
          open={target !== null}
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
