/**
 * amutix — Product feedback from agents
 *
 * Feedback here is intentionally global, not project/session state. It lets
 * agents report issues, friction, and improvement ideas about amutix itself
 * without polluting the backlog/journal/discussions of the project they are
 * currently assigned to.
 */

import { randomUUID } from "node:crypto";

import {
  appendJsonlSync,
  readJsonlSync,
  globalFile,
  formatTimestamp,
  truncatePreview,
} from "./storage.ts";

export type FeedbackKind = "issue" | "suggestion" | "friction" | "praise" | "other";
export type FeedbackSeverity = "low" | "medium" | "high";

export interface FeedbackEntry {
  id: string;
  timestamp: string;
  kind: FeedbackKind;
  severity?: FeedbackSeverity;
  area?: string;
  message: string;
  session?: string;
  agentId?: string;
  agentName?: string;
  roleName?: string;
}

export interface AddFeedbackArgs {
  kind: FeedbackKind;
  message: string;
  severity?: FeedbackSeverity;
  area?: string;
  session?: string;
  agentId?: string;
  agentName?: string;
  roleName?: string;
}

export function feedbackPath(): string {
  return globalFile("feedback.jsonl");
}

export function addFeedback(args: AddFeedbackArgs): FeedbackEntry {
  const entry: FeedbackEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    kind: args.kind,
    severity: args.severity,
    area: args.area,
    message: args.message,
    session: args.session,
    agentId: args.agentId,
    agentName: args.agentName,
    roleName: args.roleName,
  };
  appendJsonlSync(feedbackPath(), entry);
  return entry;
}

export function readFeedback(limit = 20): FeedbackEntry[] {
  const entries = readJsonlSync<FeedbackEntry>(feedbackPath());
  return entries.slice(-Math.max(1, limit)).reverse();
}

export function formatFeedbackEntry(entry: FeedbackEntry, maxLength = 220): string {
  const sev = entry.severity ? `/${entry.severity}` : "";
  const area = entry.area ? ` [${entry.area}]` : "";
  const actor = entry.agentName
    ? ` — ${entry.session || "unknown"}/${entry.agentName}${entry.roleName ? ` (${entry.roleName})` : ""}`
    : "";
  return `- ${formatTimestamp(entry.timestamp)} ${entry.kind}${sev}${area}${actor}: ${truncatePreview(entry.message, maxLength)}`;
}
