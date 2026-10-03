// T3-CUSTOM(expbkt3): one plan policy reaches every provider through native turn input.
export function appendAgentPlanInstructions(text: string, submissionEnabled: boolean): string {
  // Native slash commands must stay intact for the provider CLI.
  if (submissionEnabled || text.trimStart().startsWith("/")) return text;
  return `${text}\n\n<t3_plan_instructions>\nThe T3 plan submission tool is disabled for this server. Write the complete plan directly in your main chat response. Do not call t3_submit_plan or use another T3 tool to create a plan panel.\n</t3_plan_instructions>`;
}
