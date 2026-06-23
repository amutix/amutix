/**
 * Pi adapter bridge for the neutral tool registry.
 *
 * Converts framework-neutral AmuxToolDefinition objects into Pi's
 * `registerTool` shape and registers them in a loop. This is the only place
 * that knows about Pi/TypeBox; core tool definitions stay framework-neutral.
 *
 * Conversion responsibilities:
 *  - neutral JSON Schema -> Pi TypeBox parameter schema
 *  - neutral { text, details } -> Pi { content: [{type:"text",text}], details }
 *  - build AmuxToolContext from Pi session state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import {
  type AmuxToolContext,
  type AmuxToolDefinition,
  type AmuxToolResult,
  type JsonSchemaObject,
  type JsonSchemaProperty,
} from "../core/tools/index.ts";

// ─── Neutral schema -> Pi TypeBox ────────────────────────────

/** A TypeBox schema object (the branded shape Pi requires). */
type TypeBoxSchema = ReturnType<typeof Type.Object>;

/**
 * Convert a neutral property descriptor into a TypeBox schema node.
 * Mirrors the JSON Schema the neutral descriptor already represents.
 */
function propertyToTypeBox(prop: JsonSchemaProperty): TypeBoxSchema {
  const opts = prop.description !== undefined ? { description: prop.description } : undefined;
  switch (prop.type) {
    case "string":
      if (prop.enum) return StringEnum(prop.enum, opts) as unknown as TypeBoxSchema;
      return Type.String(opts) as unknown as TypeBoxSchema;
    case "boolean":
      return Type.Boolean(opts) as unknown as TypeBoxSchema;
    case "number":
      return Type.Number(opts) as unknown as TypeBoxSchema;
    case "integer":
      return Type.Integer(opts) as unknown as TypeBoxSchema;
    case "array": {
      const itemSchema = prop.items ? propertyToTypeBox(prop.items) : Type.String();
      return Type.Array(itemSchema, opts) as unknown as TypeBoxSchema;
    }
    case "object": {
      const properties: Record<string, TypeBoxSchema> = {};
      for (const [key, child] of Object.entries(prop.properties || {})) {
        const node = propertyToTypeBox(child);
        properties[key] = prop.required?.includes(key) ? node : (Type.Optional(node) as unknown as TypeBoxSchema);
      }
      return Type.Object(properties, opts) as unknown as TypeBoxSchema;
    }
  }
}

/**
 * Convert a neutral object schema into a Pi TypeBox object schema. Required
 * properties are listed in the TypeBox `required` array; the rest are wrapped
 * in Type.Optional so the model sees them as optional.
 */
export function neutralSchemaToTypeBox(schema: JsonSchemaObject): TypeBoxSchema {
  const properties: Record<string, TypeBoxSchema> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const node = propertyToTypeBox(prop);
    properties[key] = schema.required.includes(key) ? node : (Type.Optional(node) as unknown as TypeBoxSchema);
  }
  return Type.Object(properties) as unknown as TypeBoxSchema;
}

// ─── Neutral result -> Pi result ─────────────────────────────

/** Wrap a neutral tool result into Pi's content shape. */
export function neutralResultToPi(result: AmuxToolResult): {
  content: { type: "text"; text: string }[];
  details?: unknown;
} {
  return result.details !== undefined
    ? { content: [{ type: "text", text: result.text }], details: result.details }
    : { content: [{ type: "text", text: result.text }] };
}

// ─── Context + registration ──────────────────────────────────

/** Inputs needed to build a neutral AmuxToolContext from Pi session state. */
export interface PiToolContextInputs {
  session: string;
  agentId: string;
  agentName: string;
  roleName?: string;
  /** Pi exec capability, used to satisfy ctx.exec for tools that need it. */
  exec?: ExtensionAPI["exec"];
}

/** Build a neutral AmuxToolContext from Pi session inputs. */
export function buildAmuxToolContext(inputs: PiToolContextInputs): AmuxToolContext {
  const ctx: AmuxToolContext = {
    session: inputs.session,
    agentId: inputs.agentId,
    agentName: inputs.agentName,
    roleName: inputs.roleName,
  };
  if (inputs.exec) {
    ctx.exec = async (cmd, args, options) => {
      const r = await inputs.exec!(cmd, args, options ? { timeout: options.timeout } : undefined);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    };
  }
  return ctx;
}

/**
 * Register a single neutral tool with Pi, bridging schema/result/execute.
 * The caller supplies a function to build the per-invocation context (so the
 * freshest Pi session state is used for each tool call).
 */
export function registerAmuxTool(
  pi: ExtensionAPI,
  tool: AmuxToolDefinition,
  getContext: () => AmuxToolContext,
): void {
  const parameters = neutralSchemaToTypeBox(tool.inputSchema);
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet !== undefined ? { promptSnippet: tool.promptSnippet } : {}),
    ...(tool.promptGuidelines !== undefined ? { promptGuidelines: tool.promptGuidelines } : {}),
    parameters,
    async execute(_toolCallId, params) {
      const result = await tool.execute(getContext(), params as Record<string, unknown>);
      return neutralResultToPi(result);
    },
  });
}

/**
 * Register every neutral amux tool with Pi. The context builder is called on
 * each invocation so tools always see the current joined-agent state.
 */
export function registerAmuxTools(
  pi: ExtensionAPI,
  tools: AmuxToolDefinition[],
  getContext: () => AmuxToolContext,
): void {
  for (const tool of tools) {
    registerAmuxTool(pi, tool, getContext);
  }
}
