/**
 * Neutral tool registry.
 *
 * Aggregates all framework-neutral amutix tool definitions. Adapters import
 * `allAmutixTools()` (or `getAmutixTool(name)`) and register them through their
 * per-framework bridge.
 *
 * Back-compat: tool names were renamed `amux_*` → `amutix_*` in 2.0.
 * `getAmutixTool()` normalizes the prefix so legacy `amux_*` names still
 * resolve (removed in 3.0). Only canonical names are registered with hosts to
 * keep the model-facing tool surface compact.
 */

import { type AmutixToolDefinition } from "./types.ts";
import { artifactsTool, listTool } from "./pilot-tools.ts";
import { projectTool, wowTool } from "./project-tools.ts";
import { sendTool, broadcastTool, discussionTool } from "./communication-tools.ts";
import { roleTool, reserveTool, journalTool, feedbackTool, agentTool } from "./coordination-tools.ts";
import { taskTool } from "./backlog-tools.ts";
import { nextTool } from "./status-tools.ts";

export * from "./types.ts";
export { artifactsTool, listTool } from "./pilot-tools.ts";
export { projectTool, wowTool } from "./project-tools.ts";
export { sendTool, broadcastTool, discussionTool } from "./communication-tools.ts";
export { roleTool, reserveTool, journalTool, feedbackTool, agentTool } from "./coordination-tools.ts";
export { taskTool } from "./backlog-tools.ts";
export { nextTool } from "./status-tools.ts";

/** All registered neutral amutix tools, in registration order. */
export function allAmutixTools(): AmutixToolDefinition[] {
  return [artifactsTool, listTool, projectTool, wowTool, sendTool, broadcastTool, discussionTool, roleTool, reserveTool, journalTool, feedbackTool, agentTool, taskTool, nextTool];
}

/**
 * Normalize a tool name for back-compat: map legacy `amux_*` to the canonical
 * `amutix_*` form. (Removed in 3.0.)
 */
export function normalizeToolName(name: string): string {
  if (name.startsWith("amux_")) return "amutix_" + name.slice("amux_".length);
  return name;
}

/** Look up a neutral tool by name (accepts canonical and legacy alias names). */
export function getAmutixTool(name: string): AmutixToolDefinition | undefined {
  const canonical = normalizeToolName(name);
  return allAmutixTools().find((t) => t.name === canonical || t.aliases?.includes(name));
}

/** @deprecated Use {@link allAmutixTools}. Removed in 3.0. */
export const allAmuxTools = allAmutixTools;

/** @deprecated Use {@link getAmutixTool}. Removed in 3.0. */
export const getAmuxTool = getAmutixTool;
