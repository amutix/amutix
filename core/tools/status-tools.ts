/**
 * Neutral status/cockpit tools.
 *
 * `amutix_next` is a read-only, state-derived digest for agents that are
 * waking, resuming, or unsure what to inspect next. The derivation lives in
 * core/next.ts so heartbeat attention, prompt guidance, and this tool share
 * one coordination-signals model.
 */

import { buildAmutixNextDetails } from "../next.ts";
import { renderAmutixNextDigest } from "../renderers.ts";
import {
  type AmutixToolDefinition,
  type AmutixToolResult,
  objectSchema,
  optionalBoolProp,
} from "./types.ts";

interface NextParams {
  full?: boolean;
}

export const nextTool: AmutixToolDefinition<NextParams> = {
  name: "amutix_next",
  aliases: ["amux_next"],
  label: "Next State Digest",
  description:
    "Read-only agent cockpit: returns a concise, state-derived digest of identity, attention, awaiting replies, relevant work, reservations, reviews, discussions, and safe next pointers.",
  promptSnippet: "Get a read-only state digest and safe next pointers for the current agent",
  promptGuidelines: [
    "Use amutix_next when waking, resuming, or unsure what state to inspect next.",
    "Treat output as pointers to current state, not imperative instructions; pull details with task/discussion/reservation tools as needed.",
    "Do not use amutix_next as a substitute for task comments, review handoffs, or backlog lifecycle actions.",
  ],
  inputSchema: objectSchema({
    full: optionalBoolProp("If true, include larger uncapped arrays. Default false keeps output compact."),
  }),
  async execute(ctx, params): Promise<AmutixToolResult> {
    const details = await buildAmutixNextDetails(ctx, !!params.full);
    return { text: renderAmutixNextDigest({ details }), details };
  },
};
