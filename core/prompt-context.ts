/**
 * Prompt context gatherer.
 *
 * Builds the amux coordination `PromptSections` from core state (backlog,
 * registry, reservations, journal, ways-of-working, project context,
 * discussions). This is the single product-logic gathering path shared by the
 * Pi `before_agent_start` hook and the `/amux prompt` preview command, so the
 * injected prompt and the previewed prompt can never drift.
 *
 * The module stays Pi-independent: the adapter supplies the current agent's
 * identity/role/address and an optional `getWorkspaceBranch` callback for the
 * only host-execution concern (reading the git branch of the agent worktree).
 */

import {
  COMMON_PRINCIPLES,
  type PromptSections,
} from "./prompt-assembly.ts";
import {
  type BacklogItem,
  readBacklog,
  readSpecPreview,
} from "./backlog.ts";
import {
  type TaskComment,
  readTaskComments,
  taskCommentPreview,
  substantiveTaskComments,
  latestSubstantiveTaskComment,
} from "./task-comments.ts";
import { readWaysOfWorking } from "./ways-of-working.ts";
import {
  readProjectContext,
  projectArtifactsPath,
} from "./project-context.ts";
import {
  readPendingReplies,
  formatMessageAge,
} from "./messaging.ts";
import {
  type AgentInfo,
  readRegistry,
  readAllRegistries,
  isEffectivelyOnline,
  findById,
  formatAddress,
} from "./registry.ts";
import { renderAgentPresence } from "./renderers.ts";
import { getReservations, formatReservationAge } from "./reservations.ts";
import { getRecentEntries, formatEntryPreview } from "./journal.ts";
import { openDiscussionSummaries } from "./discussions.ts";
import { sessionFile } from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

/** Identity/role/address of the agent whose prompt is being assembled. */
export interface PromptContextAgent {
  session: string;
  id: string;
  name: string;
  roleName?: string;
  roleInstructions?: string;
  address: string;
}

/** Host capabilities the adapter supplies to the core gatherer. */
export interface PromptContextOptions {
  /**
   * Resolve the current git branch of an agent workspace. Pi implements this
   * with `pi.exec`; omitted in non-host contexts (tests), where the branch
   * defaults to "unknown".
   */
  getWorkspaceBranch?: (workspace: string) => Promise<string>;
}

// ─── Private helpers ─────────────────────────────────────────

/**
 * Build a compact one-line summary of the latest substantive task-discussion
 * comment, pointing to the full thread. Returns "" when there is no
 * substantive comment.
 */
function formatTaskDiscussionPromptSummary(taskId: string, comments: TaskComment[]): string {
  const substantive = substantiveTaskComments(comments);
  const latest = latestSubstantiveTaskComment(comments);
  if (!latest) return "";
  const count = substantive.length;
  const preview = taskCommentPreview(latest.text, 180);
  const plural = count === 1 ? "comment" : "comments";
  return `Recent task discussion: ${count} ${plural}; latest from ${latest.agent} ${formatMessageAge(latest.timestamp)}: "${preview}"\nUse amutix_task show ${taskId} for the full thread.`;
}

// ─── Gather ──────────────────────────────────────────────────

/**
 * Gather all amux coordination sections for the joined agent, in the
 * deliberate order defined by `assembleAgentPrompt`. Pure with respect to the
 * host: reads core state and calls the supplied callbacks only.
 */
export async function gatherAgentPromptSections(
  agent: PromptContextAgent,
  options: PromptContextOptions = {},
): Promise<PromptSections> {
  const { session, id, name } = agent;
  const backlog = await readBacklog(session);

  // ── Section 2: Ways of Working (extends common principles) ──
  const wowContent = readWaysOfWorking(session);
  const waysOfWorking = wowContent ? `## Ways of Working\n${wowContent}` : "";

  // ── Section 3: Project vision/context ──
  const projectCtx = readProjectContext(session);
  const projectContext = projectCtx ? `## Project Context\n${projectCtx}` : "";

  // ── Section 3: Role profile (role-specific only) ──
  const roleProfile = agent.roleInstructions
    ? `## Your Role: ${agent.roleName}\n${agent.roleInstructions}`
    : "";

  // ── Section 4: Agent identity + workspace ──
  let identity = `## Your Identity & Workspace\nYou are agent "${name}" in session "${session}" (full address: ${agent.address}).`;
  if (agent.roleName) identity += `\nRole: ${agent.roleName}.`;
  {
    const registryAgent = await findById(session, id);
    if (registryAgent?.workspace) {
      const branch = options.getWorkspaceBranch
        ? await options.getWorkspaceBranch(registryAgent.workspace)
        : "unknown";
      identity += `\nWorkspace: ${registryAgent.workspace} (branch: ${branch}). Use this as your working directory for all file operations.`;
    }
  }

  // ── Section 5: Current work state (active/review/assigned, spec, recent comments) ──
  let workState = "";
  {
    const inProgress = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === id);
    const review = backlog.filter((t) => t.status === "review" && t.assigneeId === id);
    const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === id);

    if (inProgress.length > 0) {
      const active = inProgress[0]!;
      workState += `## Active Task\n${active.id}: ${active.title}`;
      if (active.parentId) {
        const parent = backlog.find((t) => t.id === active.parentId);
        if (parent) workState += `\nParent: ${parent.id}: ${parent.title}`;
      }
      if (active.files?.length) workState += `\nFiles: ${active.files.join(", ")}`;
      if (active.specPath) {
        const spec = readSpecPreview(session, active.specPath, 2000);
        if (spec) workState += `\n\n${spec}`;
      }
      const comments = readTaskComments(session, active.id);
      const commentSummary = formatTaskDiscussionPromptSummary(active.id, comments);
      if (commentSummary) workState += `\n\n${commentSummary}`;
    }

    if (review.length > 0) {
      const ids = review.map((t) => `${t.id}: ${t.title}`).join("\n  ");
      const reviewSummaries = review
        .map((t) => formatTaskDiscussionPromptSummary(t.id, readTaskComments(session, t.id)))
        .filter((summary) => summary.length > 0)
        .map((summary) => `  - ${summary.replace(/\n/g, "\n    ")}`);
      workState += `${workState ? "\n\n" : ""}## Ready for Review (${review.length})\n  ${ids}\n\nReview/integrate; use amutix_task show only when needed and comment for review discussion.`;
      if (reviewSummaries.length > 0) {
        workState += `\n\nLatest review discussion preview:\n${reviewSummaries.join("\n")}`;
      }
    }

    if (assigned.length > 0) {
      const ids = assigned.map((t) => `${t.id}: ${t.title}`).join("\n  ");
      workState += `${workState ? "\n\n" : ""}## Assigned Tasks (${assigned.length})\n  ${ids}\n\nPick to start; show only when details are needed.`;
    }

    const pendingReplies = await readPendingReplies(session, id);
    if (pendingReplies.length > 0) {
      const lines = pendingReplies.slice(0, 5).map((p) => {
        const task = p.taskId ? ` ${p.taskId}` : "";
        return `- ${p.id}${task} to ${formatAddress(p.toSession, p.toName)} (${formatMessageAge(p.createdAt)}): ${p.messagePreview}`;
      });
      workState += `${workState ? "\n\n" : ""}## Pending Replies (${pendingReplies.length})\n${lines.join("\n")}\n\nReply with amutix_send inReplyTo to close.`;
    }
  }

  // ── Section 6: Team / project snapshot / journal context ──
  let teamContext = "";
  {
    const registry = await readRegistry(session);
    const projectAgents = Object.values(registry).filter((a: AgentInfo) => a.id !== id);
    const allAgents = await readAllRegistries();
    const crossSessionAgents = allAgents.filter(
      (a: AgentInfo) => a.session !== session && isEffectivelyOnline(a)
    );

    if (projectAgents.length > 0 || crossSessionAgents.length > 0) {
      teamContext += `## Team`;
      if (projectAgents.length > 0) {
        const list = projectAgents.map((a) => renderAgentPresence(a, backlog)).join("\n");
        teamContext += `\n\nSame-session agents:\n${list}`;
      }
      if (crossSessionAgents.length > 0) {
        const backlogBySession = new Map<string, BacklogItem[]>();
        const lines: string[] = [];
        for (const crossAgent of crossSessionAgents) {
          if (!backlogBySession.has(crossAgent.session)) {
            backlogBySession.set(crossAgent.session, await readBacklog(crossAgent.session));
          }
          lines.push(renderAgentPresence(crossAgent, backlogBySession.get(crossAgent.session)!, {
            address: formatAddress(crossAgent.session, crossAgent.name),
          }));
        }
        teamContext += `\nCross-session agents (use session/name):\n${lines.join("\n")}`;
      }
      teamContext += `\n\nAddressing: same-session name is enough; cross-session uses session/name.`;
    }

    const activeStatuses = ["todo", "assigned", "in-progress", "review", "blocked"];
    const counts = new Map(activeStatuses.map((status) => [status, 0]));
    for (const item of backlog) {
      if (counts.has(item.status)) counts.set(item.status, (counts.get(item.status) || 0) + 1);
    }
    const openCount = activeStatuses.reduce((sum, status) => sum + (counts.get(status) || 0), 0);
    const ready = backlog.filter((t) => t.status === "review").slice(0, 3);
    const blocked = backlog.filter((t) => t.status === "blocked").slice(0, 3);
    const reservations = await getReservations(session);
    const reservationLines = Object.entries(reservations).slice(0, 5).map(([path, r]) => {
      const reason = r.reason ? ` (${r.reason.length > 70 ? `${r.reason.slice(0, 67)}…` : r.reason})` : "";
      return `- ${path}: ${r.agent}, ${formatReservationAge(r.since)}${reason}`;
    });

    if (openCount > 0 || reservationLines.length > 0) {
      const countStr = activeStatuses
        .map((status) => `${status} ${counts.get(status) || 0}`)
        .join(", ");
      let snapshot = `## Project Snapshot\nOpen work: ${openCount} (${countStr})`;
      if (ready.length > 0) {
        snapshot += `\nReady for review: ${ready.map((t) => `${t.id}: ${t.title}${t.assignee ? ` — ${t.assignee}` : ""}`).join("; ")}`;
      }
      if (blocked.length > 0) {
        snapshot += `\nBlocked: ${blocked.map((t) => `${t.id}: ${t.title}${t.blockedReason ? ` (${t.blockedReason})` : ""}`).join("; ")}`;
      }
      if (reservationLines.length > 0) {
        snapshot += `\nActive reservations:\n${reservationLines.join("\n")}`;
      }
      teamContext += `${teamContext ? "\n\n" : ""}${snapshot}`;
    }

    const recentJournal = getRecentEntries(session, 6);
    if (recentJournal.length > 0) {
      const journalLines = recentJournal.map((e) => `- ${formatEntryPreview(e, 180)}`);
      teamContext += `${teamContext ? "\n\n" : ""}## Recent Journal (compact, last ${recentJournal.length})\n${journalLines.join("\n")}\nFull bodies: amutix_journal list.`;
    }
  }

  // ── Section 7: Interface/tool guidance + shared artifact paths ──
  const interfaceGuidance = `## Interfaces & Artifacts
- amutix tools are coordination primitives, not a rigid workflow. Use judgment and the lightest shared state that keeps teammates aligned.
- Messages from other agents appear as "[amutix:session/agent (role) · sent Xm ago] message". Treat them as teammate requests; reply with amutix_send to the sender when a direct reply is appropriate.
- Use amutix_project to set or update project vision/context; do not edit CONTEXT.md directly unless the interface is unavailable.
- Task details are state-derived: assigned work appears in your work state and backlog, not as inbox messages.
- Use amutix_feedback for feedback about amutix itself (tool UX, noisy notifications, confusing defaults, missing affordances). It is global product feedback, not project state.

### Shared Artifacts
Read and write shared documents using the standard read/edit/write tools.
- Project (all agents): ${projectArtifactsPath(session)}
- Private (you only): ${sessionFile(session, "artifacts", "agents", id)}`;

  // ── Compact open-discussions metadata ──
  let openDiscussions = "";
  {
    const open = openDiscussionSummaries(session);
    if (open.length > 0) {
      openDiscussions = `## Open Discussions (${open.length})\n${open.slice(0, 5).map((d) => {
        const last = formatMessageAge(d.lastActivityAt);
        const participants = d.participantNames.join(", ") || "(none)";
        return `- ${d.id} ${d.kind}: ${d.topic} — audience: ${d.audience}, ${d.postCount} post${d.postCount !== 1 ? "s" : ""}, last ${last}, participants: ${participants}`;
      }).join("\n")}`;
    }
  }

  return {
    commonPrinciples: COMMON_PRINCIPLES,
    waysOfWorking,
    projectContext,
    roleProfile,
    identity,
    workState,
    teamContext,
    interfaceGuidance,
    openDiscussions,
  };
}
