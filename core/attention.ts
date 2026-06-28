/**
 * amutix — Attention digest (INIT-16)
 *
 * Pure, Pi-independent computation of "what needs this agent's attention right
 * now", derived from current state. The per-agent heartbeat uses this to decide
 * whether to self-wake an idle agent, and to render compact pointers ("where to
 * look") rather than bare pings or directions.
 *
 * Design (see SPEC-22):
 *   - The imperative `attentionPending` flag (set by initiators) is the trigger.
 *   - This digest is the rendering: derived, never latched, recomputed each tick.
 *
 * The digest only ever contains pointers to state; it never instructs the agent.
 */

import {
  getRecoverableMessages,
  readPendingReplies,
  messagePreview,
  formatMessageAge,
  type InboxMessage,
} from "./messaging.ts";
import { readBacklog, type BacklogItem } from "./backlog.ts";
import type { AgentInfo } from "./registry.ts";

// ─── Types ───────────────────────────────────────────────────

export type AttentionKind =
  | "message" // unread inbox message addressed to me
  | "assigned" // task assigned to me, not yet started
  | "active" // task I picked and still own in-progress
  | "reply" // pending reply I owe (responseRequired, unanswered)
  | "review" // task in review where I am a reviewer candidate
  | "flag"; // initiator flagged me but no specific derived item matched

export interface AttentionEntry {
  kind: AttentionKind;
  /** Compact pointer the agent can act on (task id, message id, etc.). */
  pointer: string;
  /** One-line summary for the wake notice. */
  summary: string;
  /** Inbox filename for message entries; used by adapters to mark delivered. */
  filename?: string;
  /** Raw inbox message for message entries; used by adapters to append history. */
  message?: InboxMessage;
}

// ─── Digest ──────────────────────────────────────────────────

/**
 * Compute the set of items needing this agent's attention, derived purely from
 * current session state. Returns pointers only — never directions.
 *
 * `agent` is the calling agent's own record; its `attentionPending` flag gates
 * the review section (the initiator decides who reviews via notifyTarget).
 */
export async function computeAttentionDigest(
  session: string,
  agentId: string,
  agent: Pick<AgentInfo, "attentionPending">,
): Promise<AttentionEntry[]> {
  const entries: AttentionEntry[] = [];

  // 1. Unread inbox messages. In the unified attention model, inbox writes do
  //    not wake directly; they become durable attention entries picked up by
  //    the heartbeat. Adapters mark .json files as .delivered only when the
  //    digest is actually queued to the agent.
  const recoverable = getRecoverableMessages(session, agentId);
  for (const { msg, filename } of recoverable) {
    // Skip the catch-all system pings that the heartbeat itself emits — they
    // would otherwise feed the digest they were generated from.
    if (msg.notificationType === "attention-digest") continue;
    const role = msg.fromRole ? ` (${msg.fromRole})` : "";
    const cat = msg.category ? ` · ${msg.category}` : "";
    const task = msg.taskId ? ` · ${msg.taskId}` : "";
    const response = msg.responseRequired ? ` · response requested · inReplyTo ${msg.id}` : "";
    entries.push({
      kind: "message",
      pointer: msg.id,
      summary: `Message from ${msg.fromSession}/${msg.fromName}${role}${cat}${task}${response} · sent ${formatMessageAge(msg.timestamp)}: ${messagePreview(msg.message, 180)}`,
      filename,
      message: msg,
    });
  }

  // 2. Tasks assigned to me but not yet started, plus active work I already
  //    picked but have not moved to review/done/block/drop. This keeps agents
  //    autonomous after a post-pick interruption: once work is in-progress, the
  //    task itself becomes the durable resume pointer.
  const backlog = await readBacklog(session);
  for (const task of backlog) {
    if (task.status === "assigned" && task.assigneeId === agentId) {
      entries.push({
        kind: "assigned",
        pointer: task.id,
        summary: `${task.id} assigned to you, not yet picked: ${task.title}`,
      });
    }
    if (task.status === "in-progress" && task.assigneeId === agentId) {
      entries.push({
        kind: "active",
        pointer: task.id,
        summary: `${task.id} in progress: ${task.title}`,
      });
    }
  }

  // 3. Pending replies I owe.
  const pendingReplies = (await readPendingReplies(session, agentId)).filter(
    (r) => r.status === "pending",
  );
  for (const reply of pendingReplies) {
    entries.push({
      kind: "reply",
      pointer: reply.id,
      summary: `Reply owed to ${reply.fromName} (pending)`,
    });
  }

  // 4. Review tasks where I am a reviewer candidate — surfaced only when the
  //    initiator flagged me (attentionPending), so we don't wake every agent
  //    for every review. The assignee already owns that task; others are the
  //    intended reviewers.
  if (agent.attentionPending) {
    for (const task of backlog) {
      if (task.status === "review" && task.assigneeId !== agentId) {
        entries.push({
          kind: "review",
          pointer: task.id,
          summary: `${task.id} ready for review: ${task.title}`,
        });
      }
    }
  }

  // 5. Catch-all: if the initiator flagged me but nothing specific derived,
  //    guarantee at least one entry so the trigger always surfaces.
  if (entries.length === 0 && agent.attentionPending) {
    entries.push({
      kind: "flag",
      pointer: "",
      summary: "A teammate flagged you for attention — reassess your work state and inbox.",
    });
  }

  return entries;
}

// ─── Signature (dedup / new-attention detection) ─────────────

/**
 * Stable signature of a digest, for detecting new/changed attention since the
 * last delivery. Order-independent (sorted) so reordering doesn't read as change.
 */
export function attentionSignature(entries: AttentionEntry[]): string {
  return entries
    .map((e) => `${e.kind}:${e.pointer}`)
    .sort()
    .join("|");
}

// ─── Wake decision ───────────────────────────────────────────

/** Minimum gap between unchanged re-deliveries (bounds nag on interrupted turns). */
export const ATTENTION_REDELIVER_MS = 120_000;

/**
 * Decide whether to (re-)wake, given the current agent state and digest.
 *
 * - Fresh attention (never delivered)            → wake
 * - New/changed attention since last delivery    → wake
 * - Not yet acted on (interrupted/missed turn)   → wake, throttled by REDELIVER_MS
 * - Acted on (turn completed) + unchanged        → suppress (no nag)
 */
export function shouldDeliverAttention(args: {
  digest: AttentionEntry[];
  signature: string;
  deliveredAt?: string; // agent.attentionDeliveredAt
  deliveredSig?: string; // agent.attentionDigestSig
  lastTurnEndedAt?: string; // agent.lastTurnEndedAt
  now?: number; // injectable for tests
}): boolean {
  const { digest, signature, deliveredAt, deliveredSig, lastTurnEndedAt, now = Date.now() } = args;
  if (digest.length === 0) return false;

  // Fresh: never delivered.
  if (!deliveredAt || !deliveredSig) return true;

  // Changed since last delivery.
  if (signature !== deliveredSig) return true;

  // Unchanged — did the agent get a chance to act since delivery?
  const actedSinceDelivery =
    !!lastTurnEndedAt && new Date(lastTurnEndedAt).getTime() > new Date(deliveredAt).getTime();
  if (actedSinceDelivery) return false; // had its chance and deferred → suppress nag

  // Not yet acted on (interrupted/missed) → bounded re-wake.
  const sinceDeliver = now - new Date(deliveredAt).getTime();
  return sinceDeliver >= ATTENTION_REDELIVER_MS;
}

// ─── Rendering ───────────────────────────────────────────────

/**
 * Render the digest as a compact wake notice: pointers only, no directions.
 * Used as the followUp body that the heartbeat sends to the idle agent.
 */
export function renderAttentionNotice(entries: AttentionEntry[]): string {
  const lines = entries.slice(0, 8).map((e) => `• ${e.summary}`);
  const more = entries.length > 8 ? `\n…and ${entries.length - 8} more` : "";
  return `You have outstanding attention:\n${lines.join("\n")}${more}`;
}
