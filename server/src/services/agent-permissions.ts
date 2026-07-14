export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    // F1 (sync 2026-07-13): restore fork least-privilege — only CEO creates agents by
    // default (upstream broadened this to isFoundingAgentRole = CEO+CoS+CTO). Agent
    // creation spawns autonomous, money-spending agents; keep it CEO-only, grant others
    // explicitly. See scripts/sync/HANDOFF-20260713-test-triage.md §F1.
    canCreateAgents: role.trim().toLowerCase() === "ceo",
    canCreateSkills: true,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
  };
}
