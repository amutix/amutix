/**
 * Neutral communication and discussion tools.
 *
 * Migrates `amutix_send`, `amutix_broadcast`, and `amutix_discussion` out of the Pi
 * adapter. These tools carry delivery side effects (inbox writes, attention
 * flags, notification plans) but every effect is expressible through core
 * messaging/registry/notification functions plus the neutral context's sender
 * identity — no framework-specific capabilities are required.
 *
 * Delivery semantics preserved:
 *   - responseRequired / inReplyTo pending-reply tracking (amutix_send)
 *   - discussion audience / notify / silent behavior (amutix_discussion)
 *   - notification planning + delivery via core notification-service
 */

import {
  type InboxMessage,
  sendToInbox,
  newMessageId,
  createPendingReply,
  markPendingReplyReplied,
  messagePreview,
} from "../messaging.ts";
import {
  resolveAgent,
  readAllRegistries,
  getOnlineAgents,
  isEffectivelyOnline,
  formatAddress,
  type AgentInfo,
} from "../registry.ts";
import {
  startDiscussion,
  postToDiscussion,
  readDiscussion,
  closeDiscussion,
  listDiscussions,
  renderDiscussion,
  renderDiscussionList,
  normalizeAudience,
  resolveDiscussionParticipants,
  discussionParticipantsForSession,
  resolveDiscussionParticipantInputs,
  type ChannelAudience,
  type ChannelKind,
  type ChannelParticipant,
} from "../discussions.ts";
import {
  planDiscussionNotifications,
  deliverNotificationPlans,
  type NotificationSender,
} from "../notification-service.ts";
import {
  type AmutixToolContext,
  type AmutixToolDefinition,
  type AmutixToolResult,
  enumProp,
  objectSchema,
  optionalBoolProp,
  optionalStringProp,
  stringProp,
} from "./types.ts";

// ─── amutix_send ───────────────────────────────────────────────

interface SendParams {
  to: string;
  message: string;
  category?: "urgent" | "fyi" | "brainstorm";
  taskId?: string;
  responseRequired?: boolean;
  inReplyTo?: string;
}

/** Build the NotificationSender from the neutral tool context. */
function senderFromContext(ctx: AmutixToolContext): NotificationSender {
  return { id: ctx.agentId, name: ctx.agentName, roleName: ctx.roleName, session: ctx.session };
}

export const sendTool: AmutixToolDefinition<SendParams> = {
  name: "amutix_send",
  aliases: ["amux_send"],
  label: "Send to Agent",
  description:
    'Send a message to another amux agent. Use "name" for same-session or "session/name" for cross-session. ' +
    "Delivered to the agent's inbox  -- works even if they're busy or offline. " +
    "For task-related discussion, prefer amutix_task comment instead.",
  promptSnippet: "Send a message to a amux agent by name or session/name address",
  promptGuidelines: [
    "Use amutix_send only for exceptional general communication not tied to a backlog item.",
    "For task-related discussion, use amutix_task comment instead  -- comments stay on the task.",
    'For cross-session agents, use the full address in amutix_send: "session/name".',
    "After using amutix_send, do not wait  -- continue with your own work unless you need their response first.",
    "Set responseRequired when you need a reply; brainstorm messages default to responseRequired unless explicitly set false. Reply to response-required messages with inReplyTo.",
  ],
  inputSchema: objectSchema(
    {
      to: stringProp('"name" for same session, or "session/name" for cross-session'),
      message: stringProp("Message or instruction to send"),
      category: enumProp(["urgent", "fyi", "brainstorm"] as const, "Message intent. Use urgent sparingly; prefer task comments for task-related discussion."),
      taskId: optionalStringProp("Optional related task ID for context/staleness assessment"),
      responseRequired: optionalBoolProp("Whether a reply is expected. Defaults true for brainstorm, false otherwise."),
      inReplyTo: optionalStringProp("Pending reply/message ID this message answers."),
    },
    ["to", "message"],
  ),

  async execute(ctx, params) {
    const target = await resolveAgent(params.to, ctx.session);
    if (!target) {
      const all = await readAllRegistries();
      const online = all.filter((a) => isEffectivelyOnline(a) && a.id !== ctx.agentId);
      const available = online.map((a) => formatAddress(a.session, a.name)).join(", ");
      throw new Error(`Agent "${params.to}" not found. Available: ${available || "none"}`);
    }

    if (target.id === ctx.agentId) throw new Error("Cannot send a message to yourself.");

    const responseRequired = params.responseRequired ?? params.category === "brainstorm";
    const msg: InboxMessage = {
      id: newMessageId(),
      from: ctx.agentId,
      fromName: ctx.agentName,
      fromRole: ctx.roleName,
      fromSession: ctx.session,
      timestamp: new Date().toISOString(),
      message: params.message,
      category: params.category,
      taskId: params.taskId,
      responseRequired,
      inReplyTo: params.inReplyTo,
    };

    sendToInbox(target.session, target.id, msg);
    let pending = null;
    if (responseRequired) {
      pending = await createPendingReply(ctx.session, {
        id: msg.id,
        messageId: msg.id,
        fromId: ctx.agentId,
        fromName: ctx.agentName,
        toSession: target.session,
        toId: target.id,
        toName: target.name,
        createdAt: msg.timestamp,
        messagePreview: messagePreview(params.message),
        category: params.category,
        taskId: params.taskId,
      });
    }
    let replied = null;
    if (params.inReplyTo) {
      replied = await markPendingReplyReplied(target.session, params.inReplyTo, msg.id, ctx.agentName)
        || await markPendingReplyReplied(ctx.session, params.inReplyTo, msg.id, ctx.agentName);
    }

    const targetAddr = formatAddress(target.session, target.name);
    let text = `Message sent to ${targetAddr} (${target.roleName || target.role}).`;
    if (pending) text += ` Response requested; pending reply id: ${pending.id}.`;
    if (replied) text += ` Marked pending reply ${replied.id} as replied.`;
    return {
      text,
      details: { to: targetAddr, targetId: target.id, pendingReply: pending, repliedTo: replied },
    };
  },
};

// ─── amutix_broadcast ──────────────────────────────────────────

interface BroadcastParams {
  message: string;
  allSessions?: boolean;
}

export const broadcastTool: AmutixToolDefinition<BroadcastParams> = {
  name: "amutix_broadcast",
  aliases: ["amux_broadcast"],
  label: "Broadcast",
  description:
    "Send a message to all other online agents. Set allSessions=true for cross-session. " +
    "Use sparingly  -- prefer targeted amutix_send.",
  promptSnippet: "Broadcast a message to online amux agents",
  inputSchema: objectSchema(
    {
      message: stringProp("Message to broadcast"),
      allSessions: optionalBoolProp("Broadcast to all sessions. Default: false."),
    },
    ["message"],
  ),

  async execute(ctx, params) {
    let agents: AgentInfo[];
    if (params.allSessions) {
      agents = (await readAllRegistries()).filter(isEffectivelyOnline);
    } else {
      agents = await getOnlineAgents(ctx.session);
    }

    const others = agents.filter((a) => a.id !== ctx.agentId);
    if (others.length === 0) throw new Error("No other agents online.");

    const errors: string[] = [];
    for (const agent of others) {
      try {
        const msg: InboxMessage = {
          id: newMessageId(),
          from: ctx.agentId,
          fromName: ctx.agentName,
          fromRole: ctx.roleName,
          fromSession: ctx.session,
          timestamp: new Date().toISOString(),
          message: params.message,
        };
        sendToInbox(agent.session, agent.id, msg);
      } catch (err) {
        errors.push(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const recipients = others.map((a) => formatAddress(a.session, a.name));
    let text = `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}`;
    if (errors.length > 0) text += `\nFailed: ${errors.join("; ")}`;

    return { text, details: { recipients, errors } };
  },
};

// ─── amutix_discussion ─────────────────────────────────────────

const DISCUSSION_ACTIONS = ["start", "post", "show", "list", "close"] as const;
const DISCUSSION_KINDS = ["discussion", "retro", "brainstorm", "design", "sync", "channel"] as const;
const AUDIENCE_VALUES = ["all", "agents"] as const;

interface DiscussionParams {
  action: typeof DISCUSSION_ACTIONS[number];
  topic?: string;
  id?: string;
  content?: string;
  summary?: string;
  kind?: typeof DISCUSSION_KINDS[number];
  audience?: typeof AUDIENCE_VALUES[number];
  participants?: string[];
  notify?: boolean;
  silent?: boolean;
}

export const discussionTool: AmutixToolDefinition<DiscussionParams> = {
  name: "amutix_discussion",
  aliases: ["amux_discussion"],
  label: "Multi-Party Discussions",
  description:
    "Start, post to, show, list, and close team discussions. " +
    "Discussions are for cross-cutting topics (retros, brainstorms, design, sync) " +
    "— not task-scoped work. For task-related discussion, use amutix_task comment instead. " +
    "For 1:1 exceptional communication, use amutix_send.",
  promptSnippet: "Start or contribute to team discussions (start, post, show, list, close)",
  promptGuidelines: [
    "Use amutix_discussion for team-wide topics: retros, brainstorms, design reviews, syncs.",
    "Use audience='all' for whole-team discussions and audience='agents' with participants for focused groups; audience controls notifications, not access control.",
    "Use amutix_task comment for task-scoped discussion — discussions are NOT a replacement.",
    "Post to existing discussions rather than starting duplicates.",
    "Close discussions with a summary of outcomes rather than leaving them open indefinitely.",
  ],
  inputSchema: objectSchema(
    {
      action: enumProp(DISCUSSION_ACTIONS, "Action to perform"),
      topic: optionalStringProp("Discussion topic (required for start)"),
      id: optionalStringProp("Discussion ID, e.g. DISC-01 (required for post, show, close)"),
      content: optionalStringProp("Post content (required for post); optional initial body for start"),
      summary: optionalStringProp("Closing summary (required for close)"),
      kind: enumProp(DISCUSSION_KINDS, "Discussion kind"),
      audience: enumProp(AUDIENCE_VALUES, "Participant scope: all or explicit agents"),
      participants: {
        type: "array",
        description: "Agent names or IDs for explicit participant discussions (audience=agents). Same-session only.",
        items: stringProp(),
      },
      notify: optionalBoolProp("Notify participants. Default true."),
      silent: optionalBoolProp("Do not notify participants."),
    },
    ["action"],
  ),

  async execute(ctx, params) {
    const sender = senderFromContext(ctx);
    switch (params.action) {
      case "start": {
        if (!params.topic) throw new Error("topic is required for start.");

        const audience = normalizeAudience(params.audience as ChannelAudience | undefined);
        const author = { id: ctx.agentId, name: ctx.agentName, session: ctx.session };
        const allAgents = await discussionParticipantsForSession(ctx.session);
        const explicitAgents: ChannelParticipant[] = audience === "agents"
          ? await resolveDiscussionParticipantInputs(ctx.session, params.participants || [])
          : [];
        if (audience === "agents" && explicitAgents.length === 0 && (!params.participants || params.participants.length === 0)) {
          throw new Error("participants are required when audience is agents.");
        }
        const explicitWithCreator = audience === "agents"
          ? [...explicitAgents, { session: ctx.session, id: ctx.agentId, name: ctx.agentName, role: ctx.roleName }]
          : explicitAgents;
        const participants = resolveDiscussionParticipants(audience, author, allAgents, explicitWithCreator);

        const id = startDiscussion(ctx.session, {
          topic: params.topic,
          kind: params.kind as ChannelKind,
          audience,
          participants,
          author,
          content: params.content,
        });

        const discussion = readDiscussion(ctx.session, id)!;
        await deliverNotificationPlans(
          planDiscussionNotifications({
            discussion, action: "started",
            senderId: ctx.agentId, senderName: ctx.agentName, senderRole: ctx.roleName, senderSession: ctx.session,
            skip: params.silent || params.notify === false,
          }),
          sender,
        );
        const view = renderDiscussion(discussion);
        return {
          text: view,
          details: { discussion },
        };
      }

      case "post": {
        if (!params.id) throw new Error("id is required for post.");
        if (!params.content) throw new Error("content is required for post.");

        const discussion = postToDiscussion(ctx.session, params.id, {
          content: params.content,
          author: { id: ctx.agentId, name: ctx.agentName, session: ctx.session, role: ctx.roleName },
        });
        if (!discussion) throw new Error(`Discussion ${params.id} not found.`);

        await deliverNotificationPlans(
          planDiscussionNotifications({
            discussion, action: "post", preview: params.content,
            senderId: ctx.agentId, senderName: ctx.agentName, senderRole: ctx.roleName, senderSession: ctx.session,
            skip: params.silent || params.notify === false,
          }),
          sender,
        );

        const view = renderDiscussion(discussion);
        return {
          text: view,
          details: { discussion },
        };
      }

      case "show": {
        if (!params.id) throw new Error("id is required for show.");

        const discussion = readDiscussion(ctx.session, params.id);
        if (!discussion) throw new Error(`Discussion ${params.id} not found.`);
        const view = renderDiscussion(discussion);
        return {
          text: view,
          details: { discussion },
        };
      }

      case "list": {
        const summaries = listDiscussions(ctx.session);
        if (summaries.length === 0) {
          return {
            text: "No discussions yet. Use amutix_discussion start to create one.",
            details: { summaries: [] },
          };
        }
        const view = renderDiscussionList(summaries);
        return {
          text: view,
          details: { summaries },
        };
      }

      case "close": {
        if (!params.id) throw new Error("id is required for close.");
        if (!params.summary || !params.summary.trim()) throw new Error("summary is required for close.");

        const discussion = closeDiscussion(ctx.session, params.id, {
          summary: params.summary,
          author: { id: ctx.agentId, name: ctx.agentName, session: ctx.session, role: ctx.roleName },
        });
        if (!discussion) throw new Error(`Discussion ${params.id} not found.`);

        await deliverNotificationPlans(
          planDiscussionNotifications({
            discussion, action: "closed", preview: params.summary,
            senderId: ctx.agentId, senderName: ctx.agentName, senderRole: ctx.roleName, senderSession: ctx.session,
            skip: params.silent || params.notify === false,
          }),
          sender,
        );

        const view = renderDiscussion(discussion);
        return {
          text: view,
          details: { discussion },
        };
      }

      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  },
};
