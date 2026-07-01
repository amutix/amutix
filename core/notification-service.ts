/**
 * amux — Notification Planning Service
 *
 * Computes notification recipient/message/metadata plans for task comments,
 * discussion activity, and assignments. Framework-agnostic — adapters
 * (Pi, CLI, etc.) execute the plans via sendToInbox / updateAgent.
 */

import {
  type InboxMessage,
  sendToInbox,
  newMessageId,
  taskCommentNotificationMessage,
  discussionNotificationMessage,
  assignmentNotificationMessage,
  transitionNotificationMessage,
  messagePreview,
} from "./messaging.ts";
import { resolveTaskCommentSubscribers, taskCommentPreview, readTaskComments, type TaskComment } from "./task-comments.ts";
import { type BacklogItem } from "./backlog.ts";
import { type Discussion, postPreview } from "./discussions.ts";
import {
  type AgentInfo,
  shouldSignalAgent,
  updateAgent,
  readRegistry,
  getOnlineAgents,
  parseAddress,
} from "./registry.ts";
import { recordReviewRequest } from "./next.ts";
import { type NotifyTarget, type LifecycleTransitionAction } from "./task-state-machine.ts";

// ─── Plan Type ────────────────────────────────────────────────

export interface NotificationPlan {
  /** Target agent ID. */
  recipientId: string;
  /** Target agent session (delivery target). */
  recipientSession: string;
  /** Target agent display name. */
  recipientName: string;
  /** Whether the target should be flagged for attention (attentionPending). */
  shouldSignal: boolean;
  /** Pre-built inbox message body/metadata (caller adds id/timestamp/sender and delivers via sendToInbox). */
  message: Omit<InboxMessage, "id" | "timestamp" | "from" | "fromName" | "fromRole" | "fromSession">;
}

// ─── Task Comments ────────────────────────────────────────────

export interface TaskCommentNotificationArgs {
  task: BacklogItem;
  comment: TaskComment;
  previousComments: TaskComment[];
  agents: AgentInfo[];
  senderId: string;
  senderName: string;
  senderRole?: string;
  senderSession: string;
  /** Suppress notification? (e.g. silent: true or notify: false) */
  skip?: boolean;
}

/**
 * Plan notifications for a new task comment. Returns subscribers
 * (excluding sender) with pre-built messages. Returns [] if skip is true.
 */
export function planTaskCommentNotifications(
  args: TaskCommentNotificationArgs,
): NotificationPlan[] {
  if (args.skip) return [];

  const recipients = resolveTaskCommentSubscribers(
    args.task,
    args.previousComments,
    args.agents,
    args.senderId,
    args.comment.text,
  );

  return recipients.map((r) => {
    const shouldSignal = shouldSignalAgent(r);
    const preview = taskCommentPreview(args.comment.text);
    return {
      recipientId: r.id,
      recipientSession: r.session ?? args.senderSession,
      recipientName: r.name,
      shouldSignal,
      message: {
        message: taskCommentNotificationMessage({
          taskId: args.task.id,
          taskTitle: args.task.title,
          authorName: args.senderName,
          preview,
        }),
        category: "task-comment",
        taskId: args.task.id,
        notificationType: "task-comment",
        commentId: args.comment.id,
        preview,
        requiresAttention: true,
      },
    };
  });
}

// ─── Discussions ──────────────────────────────────────────────

export interface DiscussionNotificationArgs {
  discussion: Discussion;
  action: "started" | "post" | "closed";
  preview?: string;
  senderId: string;
  senderName: string;
  senderRole?: string;
  senderSession: string;
  /** Suppress notification? */
  skip?: boolean;
}

/**
 * Plan notifications for a discussion event. Returns participants
 * (excluding sender) with pre-built messages. Returns [] if skip is true.
 */
export function planDiscussionNotifications(
  args: DiscussionNotificationArgs,
): NotificationPlan[] {
  if (args.skip) return [];

  const targets = args.discussion.participants.filter((p) => p.id !== args.senderId);

  return targets.map((t) => ({
    recipientId: t.id,
    recipientSession: t.session ?? args.senderSession,
    recipientName: t.name,
    shouldSignal: true,  // discussion activity always signals
    message: {
      message: discussionNotificationMessage({
        action: args.action,
        discussionId: args.discussion.id,
        topic: args.discussion.topic,
        authorName: args.senderName,
        preview: args.preview,
      }),
      category: args.discussion.kind === "brainstorm" ? "brainstorm" : "fyi",
      notificationType: args.action === "post" ? "discussion-post" : `discussion-${args.action}`,
      discussionId: args.discussion.id,
      preview: postPreview(args.preview || args.discussion.topic),
      requiresAttention: true,
    },
  }));
}

// ─── Assignments ──────────────────────────────────────────────

export function planAssignmentNotification(
  target: AgentInfo,
  tasks: Array<{ id: string; title: string }>,
): NotificationPlan {
  return {
    recipientId: target.id,
    recipientSession: target.session,
    recipientName: target.name,
    shouldSignal: true,
    message: {
      message: assignmentNotificationMessage(tasks),
      category: "fyi",
      requiresAttention: true,
    },
  };
}

// ─── Lifecycle transitions ──────────────────────────────

export interface TransitionNotificationArgs {
  session: string;
  task: BacklogItem;
  action: LifecycleTransitionAction;
  /** Resolved notify target (from override or transition default). */
  target: NotifyTarget;
  senderId: string;
  senderName: string;
  senderSession: string;
  /** Optional summary/reason text to include as a preview. */
  preview?: string;
}

/**
 * Resolve a lifecycle-transition notify target into concrete recipient plans.
 *
 * Target modes:
 * - `none`: no plans (silent). Returns [].
 * - `subscribers`: reuses task-comment subscriber resolution (assignee,
 *   creator, previous commenters, @mentions in the preview), excluding sender.
 * - `all`: effectively-online agents in the current session, excluding sender.
 * - `agents`: explicit same-session names/IDs. Cross-session targets are
 *   rejected (task lifecycle v1 is single-session). Unknown names throw.
 *   Sender is excluded if listed.
 *
 * The sender is always excluded from recipients (you don't notify yourself
 * about your own transition).
 */
export async function planTransitionNotifications(
  args: TransitionNotificationArgs,
): Promise<NotificationPlan[]> {
  const { target } = args;
  if (target.mode === "none") return [];

  let recipients: AgentInfo[];
  switch (target.mode) {
    case "subscribers": {
      const registry = await readRegistry(args.session);
      const agents = Object.values(registry);
      const previousComments = readTaskComments(args.session, args.task.id);
      recipients = resolveTaskCommentSubscribers(
        args.task,
        previousComments,
        agents,
        args.senderId,
        args.preview ?? "",
      );
      break;
    }
    case "all": {
      recipients = (await getOnlineAgents(args.session)).filter((a) => a.id !== args.senderId);
      break;
    }
    case "agents": {
      const registry = await readRegistry(args.session);
      const resolved = new Map<string, AgentInfo>();
      for (const addr of target.agents) {
        const { session, name } = parseAddress(addr, args.session);
        if (session !== args.session) {
          throw new Error(
            `Cross-session task notification target "${addr}" is not supported. ` +
            `Task lifecycle notifications can only target agents within the ` +
            `current session ("${args.session}").`,
          );
        }
        const nameLower = name.toLowerCase();
        const agent = registry[name] ?? Object.values(registry).find((a) => a.name.toLowerCase() === nameLower);
        if (!agent) {
          throw new Error(`Agent "${addr}" not found in session "${args.session}".`);
        }
        resolved.set(agent.id, agent);
      }
      recipients = [...resolved.values()].filter((a) => a.id !== args.senderId);
      break;
    }
  }

  return recipients.map((r) => ({
    recipientId: r.id,
    recipientSession: r.session ?? args.senderSession,
    recipientName: r.name,
    shouldSignal: shouldSignalAgent(r),
    message: {
      message: transitionNotificationMessage({
        action: args.action,
        taskId: args.task.id,
        taskTitle: args.task.title,
        authorName: args.senderName,
        preview: args.preview,
      }),
      category: "fyi",
      notificationType: `task-${args.action}`,
      taskId: args.task.id,
      preview: args.preview ? messagePreview(args.preview, 200) : undefined,
      requiresAttention: true,
    },
  }));
}

// ─── Delivery ────────────────────────────────────────────────

/** Sender identity supplied by the adapter (the agent executing the tool). */
export interface NotificationSender {
  id: string;
  name: string;
  roleName?: string;
  session: string;
}

/**
 * Execute notification plans: flag recipients for attention (when shouldSignal)
 * and deliver a pre-built inbox message to each recipient. Framework-neutral —
 * calls the core messaging/registry functions directly. The adapter supplies
 * the sender identity (the agent executing the tool), while plans supply only
 * message body/metadata.
 *
 * `senderTimestamp` overrides the message timestamp (used when replaying a
 * stored event timestamp, e.g. a task comment's creation time).
 */
export async function deliverNotificationPlans(
  plans: NotificationPlan[],
  sender: NotificationSender,
  senderTimestamp?: string,
): Promise<void> {
  for (const plan of plans) {
    if (plan.shouldSignal) {
      await updateAgent(plan.recipientSession, plan.recipientId, { attentionPending: true });
    }
    const timestamp = senderTimestamp || new Date().toISOString();
    if (plan.message.notificationType === "task-review" && plan.message.taskId) {
      recordReviewRequest({
        session: plan.recipientSession,
        taskId: plan.message.taskId,
        recipientId: plan.recipientId,
        recipientName: plan.recipientName,
        requestedById: sender.id,
        requestedByName: sender.name,
        timestamp,
      });
    }
    sendToInbox(plan.recipientSession, plan.recipientId, {
      id: newMessageId(),
      from: sender.id,
      fromName: sender.name,
      fromRole: sender.roleName,
      fromSession: sender.session,
      timestamp,
      ...plan.message,
    });
  }
}

// ─── Task comment notification helper ────────────────────────

/**
 * Notify task-comment subscribers: plan notifications for a new comment,
 * deliver them (attention flag + inbox write), and return the recipient names.
 * Framework-neutral — combines planTaskCommentNotifications + deliverNotificationPlans.
 */
export async function notifyTaskCommentSubscribers(
  session: string,
  sender: NotificationSender,
  task: BacklogItem,
  previousComments: TaskComment[],
  comment: TaskComment,
): Promise<string[]> {
  const registry = await readRegistry(session);
  const agents = Object.values(registry);
  const plans = planTaskCommentNotifications({
    task, comment, previousComments, agents,
    senderId: sender.id, senderName: sender.name, senderRole: sender.roleName, senderSession: session,
  });
  await deliverNotificationPlans(plans, sender, comment.timestamp);
  return plans.map((p) => p.recipientName);
}
