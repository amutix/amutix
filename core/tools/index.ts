/**
 * Neutral tool registry.
 *
 * Aggregates all framework-neutral amux tool definitions. Adapters import
 * `allAmuxTools()` (or `getAmuxTool(name)`) and register them through their
 * per-framework bridge.
 */

import { type AmuxToolDefinition } from "./types.ts";
import { artifactsTool, listTool } from "./pilot-tools.ts";
import { projectTool, wowTool } from "./project-tools.ts";

export * from "./types.ts";
export { artifactsTool, listTool } from "./pilot-tools.ts";
export { projectTool, wowTool } from "./project-tools.ts";

/** All registered neutral amux tools, in registration order. */
export function allAmuxTools(): AmuxToolDefinition[] {
  return [artifactsTool, listTool, projectTool, wowTool];
}

/** Look up a neutral tool by name. */
export function getAmuxTool(name: string): AmuxToolDefinition | undefined {
  return allAmuxTools().find((t) => t.name === name);
}
