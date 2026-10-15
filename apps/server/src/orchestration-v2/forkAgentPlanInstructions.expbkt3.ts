// T3-CUSTOM(expbkt3): one plan policy reaches every provider through native turn input.

/** What a plan in plan mode may contain; the web plan card renders these parts. */
export const PLAN_FORMAT_INSTRUCTIONS = [
  "<t3_plan_format>",
  "The T3 plan card renders your plan's Markdown like a chat reply. To show a visual inside the plan (a chart, diagram, comparison or mockup), add a fenced code block whose language is `html-render` and that holds one self-contained HTML document. The card shows it as a live page in T3's theme: style it with var(--foreground), var(--muted-foreground), var(--border), var(--card), var(--accent), var(--chart-1) to var(--chart-6) and var(--font-sans), leave the page background transparent, and let the content set the height. A plan written entirely as one HTML document also renders as a page. Plain `html` code blocks stay as code.",
  "</t3_plan_format>",
].join("\n");

export function appendAgentPlanInstructions(
  text: string,
  submissionEnabled: boolean,
  interactionMode?: string,
): string {
  // Native slash commands must stay intact for the provider CLI.
  if (text.trimStart().startsWith("/")) return text;
  const blocks: string[] = [];
  if (!submissionEnabled) {
    blocks.push(
      "<t3_plan_instructions>\nThe T3 plan submission tool is disabled for this server. Write the complete plan directly in your main chat response. Do not call t3_submit_plan or use another T3 tool to create a plan panel.\n</t3_plan_instructions>",
    );
  }
  if (interactionMode === "plan") blocks.push(PLAN_FORMAT_INSTRUCTIONS);
  return blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n\n")}`;
}
