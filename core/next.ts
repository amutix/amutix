/**
 * amutix_next and coordination signal contract.
 *
 * Stable, JSON-friendly shapes for the read-only agent cockpit plus the shared
 * state-derived signal model used by `amutix_next`, heartbeat attention, and
 * prompt work-state guidance. Signals are derived from authoritative amutix
 * state; they are pointers, not imperative instructions.
 */

import { randomUUID } from "node:crypto";
import { normalize, resolve } from "node:path";

import type { AttentionKind } from "./attention.ts";
import { readBacklog, unmetDependencies, type BacklogItem } from "./backlog.ts";
import { openDiscussionSummaries } from "./discussions.ts";
import {
  formatMessageAge,
  getRecoverableMessages,
  messagePreview,
  readPendingReplies,
  type InboxMessage,
} from "./messaging.ts";
import {
  findById,
  isEffectivelyOnline,
  readRegistry,
  type AgentInfo,
} from "./registry.ts";
import {
  getReservations,
  pathsOverlap,
  reservationTaskId,
  type Reservation,
} from "./reservations.ts";
import { appendJsonlSync, readJsonlSync, sessionFile } from "./storage.ts";
import { detectTeamTopologyRisks, workspaceHumanActionText, type TeamTopologyRisk } from "./team-service.ts";

export type AmutixNextAttentionKind = AttentionKind;

export interface AmutixNextDetails {
  generatedAt: string;
  full: boolean;
  identity: AmutixNextIdentity;
  attention: AmutixNextAttentionEntry[];
  /** Pending replies this agent is waiting for from others. */
  awaitingReplies: AmutixNextAwaitingReply[];
  work: AmutixNextWorkDigest;
  reservations: AmutixNextReservationDigest;
  project: AmutixNextProjectDigest;
  next: AmutixNextPointer[];
}

export interface AmutixNextIdentity {
  session: string;
  agentId: string;
  agentName: string;
  roleName?: string;
  cwd?: string;
  workspace?: string;
  branch?: string;
}

export interface AmutixNextAttentionEntry {
  kind: AmutixNextAttentionKind;
  pointer: string;
  summary: string;
  taskId?: string;
  messageId?: string;
  replyId?: string;
  path?: string;
  discussionId?: string;
}

/**
 * A pending response requested by this agent and not yet answered.
 * Mirrors `PendingReply` from messaging: `readPendingReplies(session, agentId)`
 * filters by `fromId === agentId`, so target fields are `toSession`/`toName`.
 */
export interface AmutixNextAwaitingReply {
  id: string;
  messageId: string;
  toName: string;
  toSession: string;
  taskId?: string;
  createdAt: string;
  messagePreview: string;
}

export interface AmutixNextTaskRef {
  id: string;
  title: string;
  status: string;
  itemType?: string;
  assignee?: string;
  assigneeId?: string;
  parentId?: string;
  dependsOn?: string[];
  unmetDependencies: string[];
  files?: string[];
  specPath?: string;
  blockedReason?: string;
  summary?: string;
  updatedAt: string;
}

export interface AmutixNextWorkDigest {
  active: AmutixNextTaskRef[];
  assigned: AmutixNextTaskRef[];
  assignedReady: AmutixNextTaskRef[];
  assignedWaiting: AmutixNextTaskRef[];
  reviewAuthoredByMe: AmutixNextTaskRef[];
  /** Reviews explicitly requested from this agent, derived from durable review-request state. */
  reviewRequestedFromMe: AmutixNextTaskRef[];
  blocked: AmutixNextTaskRef[];
  dependencyBlocked: AmutixNextTaskRef[];
}

export interface AmutixNextReservationRef {
  path: string;
  agent: string;
  agentId: string;
  since: string;
  reason?: string;
  mine: boolean;
  stale?: boolean;
  relatedTaskId?: string;
  conflictsWith?: string[];
}

export interface AmutixNextReservationDigest {
  mine: AmutixNextReservationRef[];
  relevantConflicts: AmutixNextReservationRef[];
}

export interface AmutixNextTopologyRiskRef {
  kind: string;
  severity: "low" | "medium" | "high";
  summary: string;
  agentIds: string[];
  path?: string;
  reservationPath?: string;
  taskId?: string;
  affectedMe: boolean;
  humanAction?: string;
}

export interface AmutixNextProjectDigest {
  openWork: number;
  counts: Record<string, number>;
  openReviewHandoffs: AmutixNextTaskRef[];
  openDiscussions: Array<{
    id: string;
    topic: string;
    kind: string;
    audience: string;
    lastActivityAt: string;
  }>;
  topologyRisks: AmutixNextTopologyRiskRef[];
}

export interface AmutixNextPointer {
  /** Pointer category; adapters should not treat this as an instruction. */
  kind: "attention" | "task" | "reply" | "review" | "reservation" | "topology" | "discussion" | "journal" | "none";
  /** Human-readable reason this pointer is relevant now. */
  rationale: string;
  /** Stable identifier or path to inspect, when applicable. */
  pointer?: string;
  /** Optional tool+params hint for pulling details without embedding stale content. */
  inspect?: { tool: string; params: Record<string, unknown> };
}

// ─── Durable review requests ─────────────────────────────────

export interface ReviewRequestEvent {
  id: string;
  timestamp: string;
  session: string;
  taskId: string;
  recipientId: string;
  recipientName: string;
  requestedById: string;
  requestedByName: string;
}

function reviewRequestsPath(session: string): string {
  return sessionFile(session, "review-requests.jsonl");
}

export function recordReviewRequest(args: Omit<ReviewRequestEvent, "id" | "timestamp"> & { timestamp?: string }): ReviewRequestEvent {
  const event: ReviewRequestEvent = {
    id: randomUUID(),
    timestamp: args.timestamp || new Date().toISOString(),
    session: args.session,
    taskId: args.taskId,
    recipientId: args.recipientId,
    recipientName: args.recipientName,
    requestedById: args.requestedById,
    requestedByName: args.requestedByName,
  };
  appendJsonlSync(reviewRequestsPath(args.session), event);
  return event;
}

export function readReviewRequests(session: string): ReviewRequestEvent[] {
  return readJsonlSync<ReviewRequestEvent>(reviewRequestsPath(session));
}

// ─── Coordination signals ────────────────────────────────────

export type CoordinationSignalKind =
  | "message"
  | "assigned-ready"
  | "assigned-waiting"
  | "active"
  | "awaiting-reply"
  | "targeted-review"
  | "review-authored"
  | "blocked"
  | "reservation-conflict"
  | "topology-risk"
  | "discussion"
  | "flag";

export interface CoordinationSignal {
  kind: CoordinationSignalKind;
  /** Stable signature component. Must change when the signal meaning changes. */
  key: string;
  summary: string;
  taskId?: string;
  messageId?: string;
  replyId?: string;
  path?: string;
  discussionId?: string;
  inspect?: { tool: string; params: Record<string, unknown> };
  message?: InboxMessage;
  task?: BacklogItem;
  topologyRisk?: AmutixNextTopologyRiskRef;
}

export interface NextDigestContext {
  session: string;
  agentId: string;
  agentName: string;
  roleName?: string;
  exec?: (cmd: string, args: string[], options?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }>;
}

export interface CoordinationSignalDigest {
  generatedAt: string;
  context: NextDigestContext;
  agent?: AgentInfo;
  registry: Record<string, AgentInfo>;
  backlog: BacklogItem[];
  signals: CoordinationSignal[];
  recoverableMessages: ReturnType<typeof getRecoverableMessages>;
  awaitingReplies: AmutixNextAwaitingReply[];
  active: BacklogItem[];
  assigned: BacklogItem[];
  assignedReady: BacklogItem[];
  assignedWaiting: BacklogItem[];
  reviewAuthoredByMe: BacklogItem[];
  reviewRequestedFromMe: BacklogItem[];
  blocked: BacklogItem[];
  dependencyBlocked: BacklogItem[];
  mineReservations: AmutixNextReservationRef[];
  relevantReservationConflicts: AmutixNextReservationRef[];
  openReviewHandoffs: BacklogItem[];
  openDiscussions: AmutixNextProjectDigest["openDiscussions"];
  topologyRisks: AmutixNextTopologyRiskRef[];
  counts: Record<string, number>;
  openWork: number;
}

function taskRef(task: BacklogItem, allTasks: BacklogItem[]): AmutixNextTaskRef {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    itemType: task.itemType,
    assignee: task.assignee,
    assigneeId: task.assigneeId,
    parentId: task.parentId,
    dependsOn: task.dependsOn,
    unmetDependencies: unmetDependencies(task, allTasks),
    files: task.files,
    specPath: task.specPath,
    blockedReason: task.blockedReason,
    summary: task.summary,
    updatedAt: task.updatedAt,
  };
}

function cap<T>(items: T[], full: boolean, limit: number): T[] {
  return full ? items : items.slice(0, limit);
}

function plannedFiles(tasks: BacklogItem[]): string[] {
  const files = new Set<string>();
  for (const task of tasks) for (const file of task.files || []) files.add(file);
  return [...files];
}

function reservationRef(args: {
  path: string;
  reservation: Reservation;
  mine: boolean;
  registry: Record<string, AgentInfo>;
  conflictsWith?: string[];
}): AmutixNextReservationRef {
  const owner = args.registry[args.reservation.agentId];
  return {
    path: args.path,
    agent: args.reservation.agent,
    agentId: args.reservation.agentId,
    since: args.reservation.since,
    reason: args.reservation.reason,
    mine: args.mine,
    stale: owner ? !isEffectivelyOnline(owner) : true,
    relatedTaskId: reservationTaskId(args.reservation) || undefined,
    conflictsWith: args.conflictsWith,
  };
}

function roleLooksLead(agent: Pick<AgentInfo, "role" | "roleName">): boolean {
  const value = `${agent.roleName || ""} ${agent.role || ""}`.toLowerCase();
  return /lead|architect|planner|coordinator/.test(value);
}

function normalizePathForCompare(path?: string): string | undefined {
  return path ? normalize(resolve(path)) : undefined;
}

function topologyRiskRef(risk: TeamTopologyRisk, agentId: string, agent?: AgentInfo): AmutixNextTopologyRiskRef {
  const affectedMe = risk.agentIds.includes(agentId);
  const humanAction = affectedMe && agent?.workspace
    ? workspaceHumanActionText(agent.name, agent.workspace, agent.session)
    : undefined;
  return {
    kind: risk.kind,
    severity: risk.severity,
    summary: risk.summary,
    agentIds: risk.agentIds,
    path: risk.path,
    reservationPath: risk.reservationPath,
    taskId: risk.taskId,
    affectedMe,
    humanAction,
  };
}

function messageSignal(msg: InboxMessage): CoordinationSignal {
  const role = msg.fromRole ? ` (${msg.fromRole})` : "";
  const cat = msg.category ? ` · ${msg.category}` : "";
  const task = msg.taskId ? ` · ${msg.taskId}` : "";
  const response = msg.responseRequired ? ` · response requested · inReplyTo ${msg.id}` : "";
  return {
    kind: "message",
    key: `message:${msg.id}`,
    messageId: msg.id,
    taskId: msg.taskId,
    message: msg,
    summary: `Message from ${msg.fromSession}/${msg.fromName}${role}${cat}${task}${response} · sent ${formatMessageAge(msg.timestamp)}: ${messagePreview(msg.message, 180)}`,
    inspect: msg.taskId ? { tool: "amutix_task", params: { action: "show", id: msg.taskId } } : undefined,
  };
}

function targetedReviewIds(session: string, agentId: string, backlog: BacklogItem[], recoverable: ReturnType<typeof getRecoverableMessages>): Set<string> {
  const reviewTasks = new Map(backlog
    .filter((t) => t.status === "review" && t.assigneeId !== agentId)
    .map((t) => [t.id, t]));
  const ids = new Set<string>();

  for (const event of readReviewRequests(session)) {
    const task = reviewTasks.get(event.taskId);
    if (event.recipientId === agentId && task && event.timestamp >= task.updatedAt) ids.add(event.taskId);
  }

  // Back-compat/source-of-truth bridge for review notifications that already
  // exist in durable inbox files before review-request events were introduced.
  for (const { msg } of recoverable) {
    const task = msg.taskId ? reviewTasks.get(msg.taskId) : undefined;
    if (msg.notificationType === "task-review" && msg.taskId && task && msg.timestamp >= task.updatedAt) {
      ids.add(msg.taskId);
    }
  }
  return ids;
}

export function coordinationSignalSignature(signals: CoordinationSignal[]): string {
  return signals.map((s) => s.key).sort().join("|");
}

export async function deriveCoordinationSignals(ctx: NextDigestContext): Promise<CoordinationSignalDigest> {
  const [backlog, registry, agent] = await Promise.all([
    readBacklog(ctx.session),
    readRegistry(ctx.session),
    findById(ctx.session, ctx.agentId),
  ]);
  const signals: CoordinationSignal[] = [];
  const recoverableMessages = getRecoverableMessages(ctx.session, ctx.agentId)
    .filter(({ msg }) => msg.notificationType !== "attention-digest");

  for (const { msg } of recoverableMessages) signals.push(messageSignal(msg));

  const active = backlog.filter((t) => t.status === "in-progress" && t.assigneeId === ctx.agentId);
  const assigned = backlog.filter((t) => t.status === "assigned" && t.assigneeId === ctx.agentId);
  const assignedReady = assigned.filter((t) => unmetDependencies(t, backlog).length === 0);
  const assignedWaiting = assigned.filter((t) => unmetDependencies(t, backlog).length > 0);
  const reviewAuthoredByMe = backlog.filter((t) => t.status === "review" && t.assigneeId === ctx.agentId);
  const blocked = backlog.filter((t) => t.status === "blocked" && t.assigneeId === ctx.agentId);
  const dependencyBlocked = assignedWaiting;

  for (const task of active) {
    signals.push({ kind: "active", key: `active:${task.id}`, taskId: task.id, task, summary: `${task.id} in progress: ${task.title}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id } } });
  }
  for (const task of assignedReady) {
    signals.push({ kind: "assigned-ready", key: `assigned:${task.id}:ready`, taskId: task.id, task, summary: `${task.id} assigned to you, dependencies met: ${task.title}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id } } });
  }
  for (const task of assignedWaiting) {
    const unmet = unmetDependencies(task, backlog).join(",");
    signals.push({ kind: "assigned-waiting", key: `assigned:${task.id}:waiting:${unmet}`, taskId: task.id, task, summary: `${task.id} assigned to you, waiting on ${unmet}: ${task.title}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id } } });
  }
  for (const task of reviewAuthoredByMe) {
    signals.push({ kind: "review-authored", key: `review-authored:${task.id}`, taskId: task.id, task, summary: `${task.id} is awaiting review: ${task.title}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id } } });
  }
  for (const task of blocked) {
    signals.push({ kind: "blocked", key: `blocked:${task.id}:${task.blockedReason || ""}`, taskId: task.id, task, summary: `${task.id} blocked${task.blockedReason ? `: ${task.blockedReason}` : ""}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id } } });
  }

  const awaitingReplies = (await readPendingReplies(ctx.session, ctx.agentId)).map((reply) => ({
    id: reply.id,
    messageId: reply.messageId,
    toName: reply.toName,
    toSession: reply.toSession,
    taskId: reply.taskId,
    createdAt: reply.createdAt,
    messagePreview: reply.messagePreview,
  } satisfies AmutixNextAwaitingReply));
  for (const reply of awaitingReplies) {
    signals.push({ kind: "awaiting-reply", key: `reply:${reply.id}`, replyId: reply.id, taskId: reply.taskId, summary: `Awaiting reply from ${reply.toSession}/${reply.toName} (pending)` });
  }

  const requestedIds = targetedReviewIds(ctx.session, ctx.agentId, backlog, recoverableMessages);
  const reviewRequestedFromMe = backlog.filter((t) => requestedIds.has(t.id));
  for (const task of reviewRequestedFromMe) {
    signals.push({ kind: "targeted-review", key: `review:${task.id}`, taskId: task.id, task, summary: `${task.id} ready for your review: ${task.title}`, inspect: { tool: "amutix_task", params: { action: "show", id: task.id, full: true } } });
  }

  const reservationMap = await getReservations(ctx.session);
  const planned = plannedFiles([...active, ...assigned, ...reviewAuthoredByMe, ...blocked]);
  const mineReservations: AmutixNextReservationRef[] = [];
  const relevantReservationConflicts: AmutixNextReservationRef[] = [];
  for (const [path, reservation] of Object.entries(reservationMap)) {
    const isMine = reservation.agentId === ctx.agentId;
    const conflictsWith = planned.filter((file) => pathsOverlap(path, file));
    const ref = reservationRef({ path, reservation, mine: isMine, registry, conflictsWith: conflictsWith.length ? conflictsWith : undefined });
    if (isMine) mineReservations.push(ref);
    if (!isMine && conflictsWith.length > 0) {
      relevantReservationConflicts.push(ref);
      signals.push({ kind: "reservation-conflict", key: `reservation:${path}:${conflictsWith.join(",")}`, path, summary: `${path} reserved by ${reservation.agent}; conflicts with ${conflictsWith.join(", ")}`, inspect: { tool: "amutix_reserve", params: { action: "list" } } });
    }
  }

  const openDiscussions = openDiscussionSummaries(ctx.session).map((d) => ({
    id: d.id,
    topic: d.topic,
    kind: d.kind,
    audience: d.audience,
    lastActivityAt: d.lastActivityAt,
  }));
  const currentAgentName = ctx.agentName || agent?.name || "";
  for (const d of openDiscussionSummaries(ctx.session)) {
    if (d.participantNames.includes(currentAgentName)) {
      signals.push({ kind: "discussion", key: `discussion:${d.id}:${d.lastActivityAt}`, discussionId: d.id, summary: `${d.id} ${d.kind}: ${d.topic}`, inspect: { tool: "amutix_discussion", params: { action: "show", id: d.id } } });
    }
  }

  const isLead = agent ? roleLooksLead(agent) : false;
  const allTopologyRisks = (await detectTeamTopologyRisks(ctx.session))
    .map((risk) => topologyRiskRef(risk, ctx.agentId, agent || undefined));
  if (agent?.workspace && normalizePathForCompare(agent.cwd) !== normalizePathForCompare(agent.workspace)) {
    allTopologyRisks.push({
      kind: "workspace-cwd-mismatch",
      severity: "medium",
      summary: `${agent.name} has workspace intent ${agent.workspace} but is currently running in ${agent.cwd}.`,
      agentIds: [agent.id],
      path: agent.workspace,
      affectedMe: true,
      humanAction: workspaceHumanActionText(agent.name, agent.workspace, agent.session),
    });
  }
  const topologyRisks = isLead ? allTopologyRisks : allTopologyRisks.filter((risk) => risk.affectedMe);
  for (const risk of topologyRisks) {
    signals.push({
      kind: "topology-risk",
      key: `topology:${risk.kind}:${risk.path || risk.reservationPath || ""}:${risk.agentIds.join(",")}`,
      path: risk.path || risk.reservationPath,
      topologyRisk: risk,
      summary: risk.humanAction ? `${risk.summary} ${risk.humanAction}` : risk.summary,
      inspect: { tool: "amutix_agent", params: { action: "validate-team" } },
    });
  }

  const attentionRelevant = signals.filter((s) => ["message", "assigned-ready", "assigned-waiting", "active", "awaiting-reply", "targeted-review", "blocked", "reservation-conflict", "topology-risk", "discussion"].includes(s.kind));
  if (attentionRelevant.length === 0 && agent?.attentionPending) {
    signals.push({ kind: "flag", key: "flag:attention-pending", summary: "A teammate flagged you for attention — reassess current state." });
  }

  const counts: Record<string, number> = {};
  for (const task of backlog) counts[task.status] = (counts[task.status] || 0) + 1;
  const activeStatuses = ["todo", "assigned", "in-progress", "review", "blocked"];
  const openWork = activeStatuses.reduce((sum, status) => sum + (counts[status] || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    context: ctx,
    agent,
    registry,
    backlog,
    signals,
    recoverableMessages,
    awaitingReplies,
    active,
    assigned,
    assignedReady,
    assignedWaiting,
    reviewAuthoredByMe,
    reviewRequestedFromMe,
    blocked,
    dependencyBlocked,
    mineReservations,
    relevantReservationConflicts,
    openReviewHandoffs: backlog.filter((t) => t.status === "review"),
    openDiscussions,
    topologyRisks,
    counts,
    openWork,
  };
}

function attentionEntryFromSignal(signal: CoordinationSignal): AmutixNextAttentionEntry | null {
  switch (signal.kind) {
    case "message": return { kind: "message", pointer: signal.messageId || signal.key, summary: signal.summary, taskId: signal.taskId, messageId: signal.messageId };
    case "assigned-ready":
    case "assigned-waiting": return { kind: "assigned", pointer: signal.taskId || signal.key, summary: signal.summary, taskId: signal.taskId };
    case "active": return { kind: "active", pointer: signal.taskId || signal.key, summary: signal.summary, taskId: signal.taskId };
    case "awaiting-reply": return { kind: "reply", pointer: signal.replyId || signal.key, summary: signal.summary, taskId: signal.taskId, replyId: signal.replyId };
    case "targeted-review": return { kind: "review", pointer: signal.taskId || signal.key, summary: signal.summary, taskId: signal.taskId };
    case "blocked": return { kind: "blocked", pointer: signal.taskId || signal.key, summary: signal.summary, taskId: signal.taskId };
    case "reservation-conflict": return { kind: "reservation", pointer: signal.path || signal.key, summary: signal.summary, path: signal.path };
    case "topology-risk": return { kind: "topology", pointer: signal.path || signal.key, summary: signal.summary, path: signal.path };
    case "discussion": return { kind: "discussion", pointer: signal.discussionId || signal.key, summary: signal.summary, discussionId: signal.discussionId };
    case "flag": return { kind: "flag", pointer: "", summary: signal.summary };
    default: return null;
  }
}

async function resolveBranch(ctx: NextDigestContext, workspace?: string): Promise<string | undefined> {
  if (!workspace || !ctx.exec) return undefined;
  try {
    const result = await ctx.exec("git", ["-C", workspace, "branch", "--show-current"], { timeout: 5000 });
    return result.stdout?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function nextPointers(args: {
  signals: CoordinationSignal[];
  full: boolean;
}): AmutixNextPointer[] {
  const pointers = args.signals
    .filter((s) => ["message", "assigned-ready", "active", "awaiting-reply", "targeted-review", "reservation-conflict", "topology-risk", "discussion", "blocked"].includes(s.kind))
    .map((s): AmutixNextPointer => ({
      kind: s.kind === "awaiting-reply" ? "reply"
        : s.kind === "targeted-review" ? "review"
        : s.kind === "reservation-conflict" ? "reservation"
        : s.kind === "topology-risk" ? "topology"
        : s.kind === "assigned-ready" || s.kind === "active" || s.kind === "blocked" ? "task"
        : s.kind === "message" ? "attention"
        : s.kind,
      rationale: s.summary,
      pointer: s.taskId || s.replyId || s.messageId || s.path || s.discussionId,
      inspect: s.inspect,
    }));
  if (pointers.length === 0) return [{ kind: "none", rationale: "No immediate attention, ready assigned work, awaiting replies, targeted reviews, or reservation conflicts found." }];
  return cap(pointers, args.full, 10);
}

export async function buildAmutixNextDetails(ctx: NextDigestContext, full: boolean): Promise<AmutixNextDetails> {
  const digest = await deriveCoordinationSignals(ctx);
  const branch = await resolveBranch(ctx, digest.agent?.workspace);
  const details: AmutixNextDetails = {
    generatedAt: digest.generatedAt,
    full,
    identity: {
      session: ctx.session,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      roleName: ctx.roleName || digest.agent?.roleName,
      cwd: digest.agent?.cwd,
      workspace: digest.agent?.workspace,
      branch,
    },
    attention: cap(digest.signals.map(attentionEntryFromSignal).filter((e): e is AmutixNextAttentionEntry => !!e), full, 8),
    awaitingReplies: cap(digest.awaitingReplies, full, 8),
    work: {
      active: cap(digest.active.map((t) => taskRef(t, digest.backlog)), full, 8),
      assigned: cap(digest.assigned.map((t) => taskRef(t, digest.backlog)), full, 8),
      assignedReady: cap(digest.assignedReady.map((t) => taskRef(t, digest.backlog)), full, 8),
      assignedWaiting: cap(digest.assignedWaiting.map((t) => taskRef(t, digest.backlog)), full, 8),
      reviewAuthoredByMe: cap(digest.reviewAuthoredByMe.map((t) => taskRef(t, digest.backlog)), full, 8),
      reviewRequestedFromMe: cap(digest.reviewRequestedFromMe.map((t) => taskRef(t, digest.backlog)), full, 8),
      blocked: cap(digest.blocked.map((t) => taskRef(t, digest.backlog)), full, 8),
      dependencyBlocked: cap(digest.dependencyBlocked.map((t) => taskRef(t, digest.backlog)), full, 8),
    },
    reservations: {
      mine: cap(digest.mineReservations, full, 8),
      relevantConflicts: cap(digest.relevantReservationConflicts, full, 8),
    },
    project: {
      openWork: digest.openWork,
      counts: digest.counts,
      openReviewHandoffs: cap(digest.openReviewHandoffs.map((t) => taskRef(t, digest.backlog)), full, 8),
      openDiscussions: cap(digest.openDiscussions, full, 5),
      topologyRisks: cap(digest.topologyRisks, full, 8),
    },
    next: nextPointers({ signals: digest.signals, full }),
  };
  return details;
}
