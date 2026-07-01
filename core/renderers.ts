/**
 * amutix — Task and Progress Renderers
 *
 * Pure presentation functions for formatting backlog items, task details,
 * and progress summaries. Framework-agnostic — no I/O, no Pi dependencies.
 * The Pi adapter pre-fetches data and calls these for consistent output.
 */

import type { BacklogItem } from "./backlog.ts";
import type { TaskComment } from "./task-comments.ts";
import { unmetDependencies } from "./backlog.ts";
import { formatTaskComment } from "./task-comments.ts";
import { formatTimestamp, truncatePreview } from "./storage.ts";
import type { AmutixNextDetails } from "./next.ts";

// ─── amutix_next rendering contract ──────────────────────────

/**
 * Input shape for the future `renderAmutixNextDigest` helper. TASK-03 should
 * render concise, pull-based text from the structured `AmutixNextDetails`
 * contract and expose the same object unchanged as tool `details`.
 */
export interface RenderAmutixNextDigestInput {
  details: AmutixNextDetails;
}

/** Render concise text for `amutix_next`; structured data remains in details. */
export function renderAmutixNextDigest(input: RenderAmutixNextDigestInput): string {
  const d = input.details;
  const lines: string[] = [];
  lines.push(`amutix_next for ${d.identity.session}/${d.identity.agentName} (${d.identity.roleName || "agent"})`);
  if (d.identity.workspace || d.identity.branch) {
    lines.push(`Workspace: ${[d.identity.workspace, d.identity.branch ? `branch ${d.identity.branch}` : ""].filter(Boolean).join(" · ")}`);
  }
  lines.push(`Generated: ${d.generatedAt}${d.full ? " · full" : " · compact"}`);

  const attentionCount = d.attention.length;
  const activeCount = d.work.active.length;
  const assignedCount = d.work.assigned.length;
  const reviewCount = d.work.reviewRequestedFromMe.length;
  const conflictCount = d.reservations.relevantConflicts.length;
  const topologyCount = d.project.topologyRisks.length;
  const awaitingCount = d.awaitingReplies.length;
  lines.push(`State: attention ${attentionCount} · active ${activeCount} · assigned ${assignedCount} · targeted reviews ${reviewCount} · awaiting replies ${awaitingCount} · reservation conflicts ${conflictCount} · topology risks ${topologyCount}`);

  if (d.attention.length > 0) {
    lines.push("\nAttention:");
    for (const entry of d.attention.slice(0, 5)) lines.push(`- ${entry.kind}: ${truncatePreview(entry.summary, 180)}`);
    if (d.attention.length > 5) lines.push(`- …and ${d.attention.length - 5} more`);
  }

  const workLines = [
    ...d.work.active.map((t) => `active ${t.id}: ${t.title}`),
    ...d.work.assigned.slice(0, 5).map((t) => `assigned ${t.id}: ${t.title}${t.unmetDependencies.length ? ` (waiting on ${t.unmetDependencies.join(", ")})` : ""}`),
    ...d.work.reviewRequestedFromMe.slice(0, 5).map((t) => `review requested ${t.id}: ${t.title}`),
    ...d.work.blocked.slice(0, 5).map((t) => `blocked ${t.id}: ${t.title}${t.blockedReason ? ` (${t.blockedReason})` : ""}`),
  ];
  if (workLines.length > 0) {
    lines.push("\nRelevant work:");
    for (const line of workLines.slice(0, 8)) lines.push(`- ${line}`);
    if (workLines.length > 8) lines.push(`- …and ${workLines.length - 8} more`);
  }

  if (d.awaitingReplies.length > 0) {
    lines.push("\nAwaiting replies:");
    for (const reply of d.awaitingReplies.slice(0, 5)) lines.push(`- ${reply.id} from ${reply.toSession}/${reply.toName}: ${truncatePreview(reply.messagePreview, 120)}`);
  }

  if (d.reservations.relevantConflicts.length > 0) {
    lines.push("\nReservation conflicts:");
    for (const r of d.reservations.relevantConflicts.slice(0, 5)) lines.push(`- ${r.path}: ${r.agent}${r.conflictsWith?.length ? ` (conflicts with ${r.conflictsWith.join(", ")})` : ""}`);
  }

  if (d.project.topologyRisks.length > 0) {
    lines.push("\nTeam/workspace topology risks:");
    for (const r of d.project.topologyRisks.slice(0, 5)) lines.push(`- ${r.severity} ${r.kind}: ${truncatePreview(r.humanAction ? `${r.summary} ${r.humanAction}` : r.summary, 180)}`);
  }

  lines.push("\nSafe next pointers:");
  for (const pointer of d.next.slice(0, 8)) {
    const ref = pointer.pointer ? ` [${pointer.pointer}]` : "";
    lines.push(`- ${pointer.kind}${ref}: ${truncatePreview(pointer.rationale, 180)}`);
  }

  lines.push("\nDetails contain the structured digest; pull task/discussion/reservation bodies only when needed.");
  return lines.join("\n");
}

// ─── Utilities ───────────────────────────────────────────────

/** Format a duration in milliseconds to a compact human-readable string. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

// ─── Status Markers ──────────────────────────────────────────

function statusMarker(status: string): string {
  switch (status) {
    case "done": return "\u2713";
    case "in-progress": return "\u25b6";
    case "review": return "◇";
    case "blocked": return "\u26a0";
    case "assigned": return "\u2192";
    default: return "\u25cb";
  }
}

function typeLabel(item: BacklogItem): string {
  return item.itemType && item.itemType !== "task" ? ` (${item.itemType})` : "";
}

// ─── Agent Presence ──────────────────────────────────────────

export interface AgentPresenceInfo {
  id: string;
  name: string;
  role?: string;
  roleName?: string;
  status: string;
  availability?: string;
  cwd?: string;
}

export interface AgentWorkState {
  active?: BacklogItem;
  review: BacklogItem[];
  assigned: BacklogItem[];
}

export interface RenderAgentPresenceOptions {
  currentAgentId?: string;
  address?: string;
  includeCwd?: boolean;
}

/** Derive an agent's current work from backlog state. */
export function agentWorkState(agentId: string, tasks: BacklogItem[]): AgentWorkState {
  return {
    active: tasks.find((t) => t.status === "in-progress" && t.assigneeId === agentId),
    review: tasks.filter((t) => t.status === "review" && t.assigneeId === agentId),
    assigned: tasks.filter((t) => t.status === "assigned" && t.assigneeId === agentId),
  };
}

function compactTaskRef(task: BacklogItem): string {
  const title = task.title.length > 48 ? `${task.title.slice(0, 45)}…` : task.title;
  return `${task.id}: ${title}`;
}

/** Render a compact work-state label such as "working: TASK-32: Fix auth". */
export function renderAgentWorkState(agentId: string, tasks: BacklogItem[]): string | null {
  const state = agentWorkState(agentId, tasks);
  if (state.active) return `working: ${compactTaskRef(state.active)}`;
  if (state.review.length === 1) return `ready for review: ${compactTaskRef(state.review[0]!)}`;
  if (state.review.length > 1) return `ready for review: ${state.review.length} tasks`;
  if (state.assigned.length === 1) return `assigned: ${compactTaskRef(state.assigned[0]!)}`;
  if (state.assigned.length > 1) return `assigned: ${state.assigned.length} tasks`;
  return null;
}

/** Render one agent row with derived active/assigned task context. */
export function renderAgentPresence(
  agent: AgentPresenceInfo,
  tasks: BacklogItem[],
  options: RenderAgentPresenceOptions = {},
): string {
  const name = options.address || agent.name;
  const isMe = options.currentAgentId === agent.id;
  const marker = isMe ? " (you)" : "";
  const roleLabel = agent.roleName || agent.role || "agent";
  const work = renderAgentWorkState(agent.id, tasks);
  const availability = agent.availability && agent.availability !== "idle" && agent.availability !== "working"
    ? agent.availability
    : undefined;
  const status = [agent.status, availability, work].filter(Boolean).join(", ");
  const cwd = options.includeCwd && agent.cwd ? ` (cwd: ${agent.cwd})` : "";
  return `  - ${name}${marker} [${status}]: ${roleLabel}${cwd}`;
}

// ─── Task List Row ───────────────────────────────────────────

/**
 * Render a single backlog item as a compact list row.
 * Used by `amutix_task list`.
 */
export interface RenderTaskListRowOptions {
  /** Include verbose done/review summaries. Default false to keep lists projection-sized. */
  includeSummaries?: boolean;
  /** Include file lists. Default false; detailed file context belongs in show/full. */
  includeFiles?: boolean;
}

export function renderTaskListRow(
  task: BacklogItem,
  allTasks: BacklogItem[],
  position: number,
  currentAgentId?: string,
  options: RenderTaskListRowOptions = {},
): string {
  const assigneeStr = task.assignee
    ? task.status === "assigned"
      ? ` \u2192 ${task.assignee} (pending)`
      : `  -- ${task.assignee}`
    : "";
  const isMe = currentAgentId && task.assigneeId === currentAgentId;
  const meMarker = isMe ? " (you)" : "";
  const filesStr = options.includeFiles && task.files?.length
    ? `\n                              Files: ${task.files.join(", ")}` : "";
  const depsStr = task.dependsOn?.length
    ? (() => {
        const unmet = unmetDependencies(task, allTasks);
        const label = task.dependsOn.join(", ");
        return `\n                              Depends on: ${label}${unmet.length > 0 ? " (waiting)" : " \u2713"}`;
      })()
    : "";
  const blockedStr = task.status === "blocked" && task.blockedReason
    ? `\n                              Blocked: ${task.blockedReason}` : "";
  const summaryStr = options.includeSummaries && task.summary && (task.status === "done" || task.status === "review")
    ? `\n                              ${task.status === "review" ? "Review handoff" : "Summary"}: ${task.summary}` : "";
  const doneTime = task.status === "done" && task.completedAt
    ? ` (${formatDuration(Date.now() - new Date(task.completedAt).getTime())} ago)` : "";
  const tLabel = task.itemType && task.itemType !== "task" ? `(${task.itemType}) ` : "";
  const specMarker = task.specPath ? " [spec]" : "";

  return `  #${String(position).padStart(2)}  ${task.id}  ${tLabel}[${task.status}]  ${task.title}${specMarker}${assigneeStr}${meMarker}${doneTime}${filesStr}${depsStr}${blockedStr}${summaryStr}`;
}

// ─── Task Details ────────────────────────────────────────────

export interface RenderTaskOptions {
  currentAgentId?: string;
  comments?: TaskComment[];
  specPreview?: string | null;
  /** Explicitly render full spec preview and full comment/activity history. Default false. */
  full?: boolean;
  /** Suppress long content authored by this agent (review handoffs/comments) in compact mode. */
  suppressOwnContent?: boolean;
}

/**
 * Render full task details with metadata, spec preview, and comments.
 * Used by `amutix_task show`.
 */
export function renderTaskDetails(
  task: BacklogItem,
  allTasks: BacklogItem[],
  options: RenderTaskOptions = {},
): string {
  let text = `${task.id}: ${task.title}  [${task.status}]`;
  if (task.description) text += `\n\n${task.description}`;
  text += `\n\nStatus: ${task.status}`;
  if (task.itemType && task.itemType !== "task") text += `\nType: ${task.itemType}`;
  if (task.parentId) {
    const parent = allTasks.find((t) => t.id === task.parentId);
    text += `\nParent: ${task.parentId}${parent ? `: ${parent.title}` : ""}`;
  }
  if (task.order != null) text += `\nOrder: ${task.order}`;
  if (task.assignee) {
    const youMarker = options.currentAgentId && task.assigneeId === options.currentAgentId ? " (you)" : "";
    text += `\nAssignee: ${task.assignee}${youMarker}`;
  }
  if (task.dependsOn?.length) {
    const unmet = unmetDependencies(task, allTasks);
    text += `\nDepends on: ${task.dependsOn.join(", ")}${unmet.length > 0 ? ` (waiting: ${unmet.join(", ")})` : " \u2713"}`;
  }
  if (task.files?.length) text += `\nFiles: ${task.files.join(", ")}`;
  if (task.blockedReason) text += `\nBlocked: ${task.blockedReason}`;
  const compact = !options.full;
  const suppressOwnSummary = compact && options.suppressOwnContent && options.currentAgentId && task.assigneeId === options.currentAgentId;
  if (task.status === "review") {
    if (task.summary && !suppressOwnSummary) {
      const summary = compact ? truncatePreview(task.summary, 420) : task.summary;
      text += `\nReview handoff: ${summary}`;
    } else if (task.summary && suppressOwnSummary) {
      text += `\nReview handoff: (authored by you; hidden in compact view)`;
    } else {
      text += `\nReview handoff: (none yet — include commit/branch, diff summary, tests run, and known risks)`;
    }
    text += `\nReviewer workflow: read spec → inspect diff → inspect tests → comment or mark done.`;
  } else if (task.summary) {
    text += compact ? `\nSummary: ${truncatePreview(task.summary, 240)}` : `\nSummary: ${task.summary}`;
  }
  text += `\nCreated: ${task.createdAt} by ${task.createdBy}`;
  if (task.completedAt) text += `\nCompleted: ${task.completedAt}`;

  // Spec preview
  if (task.specPath) {
    text += `\nSpec: ${task.specPath}`;
    if (options.full && options.specPreview) {
      text += `\n\n${options.specPreview}`;
    } else if (!options.full && options.specPreview) {
      text += `\nSpec preview hidden in compact view. Use amutix_task show with full:true for the full preview.`;
    }
  }

  // Comments/activity projection
  const comments = options.comments || [];
  if (comments.length > 0) {
    if (options.full) {
      text += `\n\n\u2500\u2500 Comments (${comments.length}) \u2500\u2500`;
      for (const c of comments) {
        text += `\n${formatTaskComment(c)}`;
      }
    } else {
      const substantive = comments.filter((c) => c.type === "comment");
      const activity = comments.filter((c) => c.type === "activity");
      const visibleSubstantive = options.suppressOwnContent && options.currentAgentId
        ? substantive.filter((c) => c.agentId !== options.currentAgentId)
        : substantive;
      text += `\n\n\u2500\u2500 Discussion projection \u2500\u2500`;
      text += `\nSubstantive comments: ${substantive.length}${visibleSubstantive.length !== substantive.length ? ` (${substantive.length - visibleSubstantive.length} authored by you hidden)` : ""}.`;
      const latest = visibleSubstantive.at(-1);
      if (latest) {
        text += `\nLatest from ${latest.agent} at ${formatTimestamp(latest.timestamp)}: “${truncatePreview(latest.text, 220)}”`;
      }
      if (activity.length > 0) {
        const last = activity.at(-1)!;
        text += `\nActivity: ${activity.length} lifecycle event${activity.length !== 1 ? "s" : ""}; last ${formatTimestamp(last.timestamp)}: ${truncatePreview(last.text, 120)}`;
      }
      text += `\nFull thread: amutix_task show ${task.id} full:true`;
    }
  } else {
    text += `\n\nNo comments yet. Use amutix_task with action "comment" to add one.`;
  }

  return text;
}

// ─── Progress Summary ────────────────────────────────────────

/**
 * Render a compact hierarchical progress summary.
 * Used by `amutix_task summary` and `/amux progress`.
 */
export function renderProgressSummary(
  session: string,
  tasks: BacklogItem[],
): string {
  if (tasks.length === 0) return `Project: ${session}\n\nNo backlog items yet.`;

  // Status counts
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  const total = tasks.length;
  const statusLine = ["todo", "assigned", "in-progress", "review", "blocked", "done"]
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(" \u00b7 ");

  // Build children lookup, sorted by order then backlog position
  const childrenOf = new Map<string, BacklogItem[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const siblings = childrenOf.get(t.parentId) || [];
      siblings.push(t);
      childrenOf.set(t.parentId, siblings);
    }
  }
  for (const [, children] of childrenOf) {
    children.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  }

  let out = `Project: ${session}\n`;
  out += `${"\u2500".repeat(40)}\n`;
  out += `${statusLine}  (${total} total)\n`;

  // Render top-level items (those without parentId)
  const topLevel = tasks.filter((t) => !t.parentId);
  const hasHierarchy = childrenOf.size > 0;

  if (hasHierarchy) out += "\n";

  const assigneeStr = (t: BacklogItem) =>
    (t.status === "in-progress" || t.status === "assigned") && t.assignee ? ` \u2014 ${t.assignee}` : "";
  const blockedStr = (t: BacklogItem) =>
    t.status === "blocked" && t.blockedReason ? `: ${t.blockedReason}` : "";

  for (const t of topLevel) {
    const children = childrenOf.get(t.id);
    if (children && children.length > 0) {
      // Parent with indented children
      const childDone = children.filter((c) => c.status === "done").length;
      out += `\u25b8 ${t.id}${typeLabel(t)}  ${t.title} [${childDone}/${children.length}]\n`;
      for (const c of children) {
        out += `    ${statusMarker(c.status)} ${c.id}  ${c.title}${assigneeStr(c)}${blockedStr(c)}\n`;
      }
    } else {
      // Standalone item
      out += `${statusMarker(t.status)} ${t.id}${typeLabel(t)}  ${t.title}${assigneeStr(t)}${blockedStr(t)}\n`;
    }
  }

  // Recently done (last 3)
  const done = tasks
    .filter((t) => t.status === "done" && t.completedAt)
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
    .slice(0, 3);
  if (done.length > 0) {
    out += `\n\u2713 Recently Done:\n`;
    for (const t of done) {
      const ago = t.completedAt
        ? formatDuration(Date.now() - new Date(t.completedAt).getTime()) + " ago"
        : "";
      out += `  ${t.id}  ${t.title}${ago ? ` (${ago})` : ""}\n`;
    }
  }

  return out.trimEnd();
}
