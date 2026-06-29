/**
 * Framework-neutral tool definitions.
 *
 * amutix tools are defined once here, independent of any specific agentic
 * framework (Pi, MCP, OpenAI function tools, ...). A thin per-framework
 * adapter (e.g. pi/tool-adapter.ts) converts these neutral definitions into
 * the framework's registration shape.
 *
 * The canonical parameter format is plain JSON Schema (descriptor helpers
 * below), never a framework-specific schema primitive.
 */

// ─── Parameter schemas (plain JSON Schema descriptors) ───────

/** A single JSON Schema property descriptor. */
export interface JsonSchemaProperty {
  type: "string" | "boolean" | "number" | "integer" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

/** A top-level object parameter schema (the shape every tool takes). */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

/** Property builder for a string. */
export function stringProp(description?: string): JsonSchemaProperty {
  return { type: "string", description };
}

/** Property builder for an optional string. */
export function optionalStringProp(description?: string): JsonSchemaProperty {
  return { type: "string", description };
}

/** Property builder for a string enum. */
export function enumProp(values: readonly string[], description?: string): JsonSchemaProperty {
  return { type: "string", enum: [...values], description };
}

/** Property builder for a boolean. */
export function boolProp(description?: string): JsonSchemaProperty {
  return { type: "boolean", description };
}

/** Property builder for an optional boolean. */
export function optionalBoolProp(description?: string): JsonSchemaProperty {
  return { type: "boolean", description };
}

/**
 * Build an object schema from property descriptors, marking which keys are
 * required. Convenience helper so tool definitions read declaratively.
 */
export function objectSchema(
  properties: Record<string, JsonSchemaProperty>,
  required: string[] = [],
): JsonSchemaObject {
  return { type: "object", properties, required };
}

// ─── Tool definition, context, and result ────────────────────

/** Framework-independent execution capabilities supplied by adapters. */
export interface AmutixToolContext {
  session: string;
  agentId: string;
  agentName: string;
  roleName?: string;

  /**
   * Run a host command (e.g. git). Supplied by adapters that can execute
   * processes; omitted in pure/test contexts. Returns code/stdout/stderr.
   */
  exec?: (
    cmd: string,
    args: string[],
    options?: { timeout?: number },
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>;
}

/** Framework-neutral tool result. Adapters wrap this into their own shape. */
export interface AmutixToolResult {
  text: string;
  details?: unknown;
}

/**
 * A framework-neutral amutix tool. Defined once; registered per framework via an
 * adapter bridge. `execute` receives the neutral context + parsed params and
 * returns a neutral result.
 */
export interface AmutixToolDefinition<P = Record<string, unknown>> {
  /** Canonical tool name (e.g. "amutix_task"). */
  name: string;
  /**
   * Deprecated alias names that resolve to this same tool (e.g. "amux_task").
   * Honored by the neutral registry lookup for back-compat; not registered as
   * separate host tools (to keep the model-facing tool surface compact).
   * Aliases are removed in 3.0.
   */
  aliases?: string[];
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  inputSchema: JsonSchemaObject;
  execute(ctx: AmutixToolContext, params: P): Promise<AmutixToolResult>;
}
