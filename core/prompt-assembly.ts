/*
 * amux — Agent Prompt Assembly
 *
 * Deliberate, reviewable composition of the coordination block that amux
 * APPENDS to the host agent runtime's base system prompt (it never replaces the base prompt).
 *
 * Section order is explicit and documented here so the prompt structure is
 * easy to review and test. Role profiles are one role-specific section, not
 * the whole prompt. Common operating principles, project vision, work state,
 * team context, and interface guidance are separate, ordered sections.
 *
 * Pi-independent and pure: takes pre-fetched section strings, returns the
 * composed block. The adapter gathers data and appends the result.
 */

/**
 * Common amux operating principles — the shared collaboration contract every
 * agent follows, regardless of role. Role-specific behavior lives in role
 * profiles; this section holds only universal coordination rules so the two
 * never conflict.
 */
export const COMMON_PRINCIPLES = `## amux Operating Principles

You are part of a coordinated agent team. Shared operating rules:

- **State is the source of truth.** Derive current truth from the backlog, registry, task comments, reservations, and journal — not from messages. Task assignments appear in your work state, not as inbox instructions.
- **Coordinate like a dev team.** Prefer \`amux_task comment\` for task-scoped discussion; use \`amux_send\` only for exceptional, non-task communication. Claim files via reservations before editing shared code.
- **Work the backlog deliberately.** Use \`amux_task summary\` (or \`/amux progress\`) for a hierarchical overview before choosing work. Items are typed (initiative/milestone/task/bug/chore/spec); initiatives and milestones are context containers — assign and pick executable leaf items, not containers. Inspect parent context with \`amux_task show\` before implementing a child item.
- **Review before done.** Substantive work goes to review before completion. Report outcomes, key decisions, risks, and test status.`;

// ─── Section Composition ─────────────────────────────────────

/**
 * Named prompt sections in deliberate order. Each is optional; empty sections
 * are skipped during assembly.
 */
export interface PromptSections {
  /** 1. Common amux operating principles / collaboration contract. */
  commonPrinciples?: string;
  /** 2. Project Ways of Working (WOW.md) — extends common principles with team-specific norms. */
  waysOfWorking?: string;
  /** 3. Project vision/context (CONTEXT.md). */
  projectContext?: string;
  /** 4. Role-specific profile/instructions. */
  roleProfile?: string;
  /** 5. Agent identity + workspace. */
  identity?: string;
  /** 6. Current work state: active/assigned/review items, spec, recent comments, journal. */
  workState?: string;
  /** 7. Team/backlog/review/reservation context (agent roster, addressing). */
  teamContext?: string;
  /** 8. Interface/tool guidance and shared artifact paths. */
  interfaceGuidance?: string;
}

/** The deliberate section order. Documented here as the single source of truth. */
const SECTION_ORDER: (keyof PromptSections)[] = [
  "commonPrinciples",
  "waysOfWorking",
  "projectContext",
  "roleProfile",
  "identity",
  "workState",
  "teamContext",
  "interfaceGuidance",
];

/** Human-readable labels for each section, for previews/debug output. */
export const PROMPT_SECTION_LABELS: Record<keyof PromptSections, string> = {
  commonPrinciples: "Common principles",
  waysOfWorking: "Ways of Working",
  projectContext: "Project context",
  roleProfile: "Role profile",
  identity: "Identity & workspace",
  workState: "Work state",
  teamContext: "Team context",
  interfaceGuidance: "Interface guidance",
};

/** The deliberate section order, exported for previews/tests. */
export const PROMPT_SECTION_ORDER: readonly (keyof PromptSections)[] = SECTION_ORDER;

/**
 * Assemble the coordination block from sections in the deliberate order.
 * Empty/whitespace-only sections are skipped. Returns the composed block
 * (without leading/trailing whitespace), or "" if all sections are empty.
 *
 * The caller appends this to the host agent runtime's base system prompt — it does not replace it.
 */
export function assembleAgentPrompt(sections: PromptSections): string {
  return SECTION_ORDER.map((key) => sections[key])
    .filter((s): s is string => !!s && s.trim().length > 0)
    .map((s) => s.trim())
    .join("\n\n");
}

/**
 * Names of the sections currently gathered into the composed block, in order.
 * Useful for preview/debug summaries.
 */
export function gatheredSectionNames(sections: PromptSections): string[] {
  return SECTION_ORDER.filter((key) => {
    const s = sections[key];
    return !!s && s.trim().length > 0;
  }).map((key) => PROMPT_SECTION_LABELS[key]);
}

/**
 * Names of the sections that are currently empty/skipped, in order.
 * Useful for preview/debug summaries (shows what is *not* injected).
 */
export function skippedSectionNames(sections: PromptSections): string[] {
  return SECTION_ORDER.filter((key) => {
    const s = sections[key];
    return !s || s.trim().length === 0;
  }).map((key) => PROMPT_SECTION_LABELS[key]);
}

function promptPreviewHeader(): string {
  return "amux prompt preview (debug)\n" +
    "==========================\n\n" +
    "amux APPENDS a coordination block to the host agent runtime's base " +
    "system prompt for the joined agent. The host's base system prompt is " +
    "NOT shown here — only amux sections are previewed.";
}

function promptSummary(sections: PromptSections): string {
  const included = gatheredSectionNames(sections);
  const skipped = skippedSectionNames(sections);
  const total = SECTION_ORDER.length;
  let summary = `Sections gathered (${included.length}/${total}): ` +
    (included.length > 0 ? included.join(", ") : "(none)");
  if (skipped.length > 0) {
    summary += `\nSections empty/skipped (${skipped.length}): ${skipped.join(", ")}`;
  }
  return summary;
}

/** Format a non-polluting summary for `/amux prompt` default output. */
export function formatPromptSummary(sections: PromptSections): string {
  return `${promptPreviewHeader()}\n\n${promptSummary(sections)}\n\nUse /amux prompt <section> to inspect one section, or /amux prompt all to show the full amux-appended block. Sections: ${SECTION_ORDER.join(", ")}`;
}

/** Format one prompt section for focused inspection. */
export function formatPromptSectionPreview(sections: PromptSections, section: keyof PromptSections): string {
  const label = PROMPT_SECTION_LABELS[section];
  const content = sections[section]?.trim();
  return `${promptPreviewHeader()}\n\nSection: ${label} (${section})\n\n${content || "(empty — this section is not injected)"}`;
}

/**
 * Format the full composed coordination block as a debug/preview for explicit
 * `/amux prompt all`.
 */
export function formatPromptPreview(sections: PromptSections): string {
  const assembled = assembleAgentPrompt(sections);
  const body = assembled
    ? assembled
    : "(no sections gathered — the block is empty; nothing is appended to the base prompt)";

  return `${promptPreviewHeader()}\n\n${promptSummary(sections)}\n\n---- composed block (appended to base prompt) ----\n\n${body}`;
}
