/**
 * amux — Agent / Worktree Setup Helpers
 *
 * Pure functions for agent name sanitization, worktree path derivation,
 * and workspace defaults. Framework-agnostic — no UI prompts or git
 * execution. Adapters handle shell/git commands and interactive prompts.
 */

// ─── Name Sanitization ────────────────────────────────────────

/**
 * Sanitize an agent name for use as a git branch component.
 * Lowercases, replaces special characters with hyphens, collapses
 * consecutive hyphens, and trims leading/trailing hyphens.
 */
export function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/\.\./g, "-")       // no consecutive dots (git ref rule)
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "unnamed";
}

// ─── Worktree Path Derivation ─────────────────────────────────

export interface WorktreePlan {
  /** Full path for the worktree directory. */
  wsPath: string;
  /** Git branch name (e.g. agent/dev). */
  branchName: string;
}

/**
 * Derive the worktree path and branch name from a repo path
 * and agent name. Uses the convention: <repoDir>-<sanitizedAgentName>
 * for the directory and agent/<sanitizedAgentName> for the branch.
 */
export function deriveWorktreePath(repoPath: string, agentName: string): WorktreePlan {
  const lastSep = repoPath.lastIndexOf("/");
  const repoName = lastSep >= 0 ? repoPath.slice(lastSep + 1) : repoPath;
  const parentDir = lastSep >= 0 ? repoPath.slice(0, lastSep) : ".";
  const safe = sanitizeBranchName(agentName);

  return {
    wsPath: `${parentDir}/${repoName}-${safe}`,
    branchName: `agent/${safe}`,
  };
}
