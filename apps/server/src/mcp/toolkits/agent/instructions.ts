/**
 * T3-CUSTOM(expbkt3): the `instructions` T3 Code's MCP server sends when a
 * client connects. Clients put them in the agent's context once, so they name
 * the few calls that do most work instead of describing every tool.
 */
export const MCP_SERVER_INSTRUCTIONS = [
  "T3 Code runs coding-agent sessions for people. Start with t3_whoami.",
  "- t3_inbox: everything that waits on a person (questions with options, approvals, plans, failures), each with a ready t3_answer call.",
  "- t3_answer: answer a question (choice, text, answers), an approval (decision) or a plan (approve, revise with feedback, discard). A blocking question pauses the agent; a non-blocking one (a Codex async question) does not, so its answer arrives as a new message, or dismiss it.",
  "- t3_find_sessions, then t3_session_brief: find a session and read where it stands.",
  "- t3_start_session and t3_send_message: start work, or send to a session.",
  "- t3_wait: wait for the next question, approval, finish or failure with a cursor. Do not poll t3_inbox.",
  '- t3_schedule and t3_schedules: send a prompt later or on a clock (in "30m", every "2h", daily "09:00"), into your own session, another one, or a new session each run.',
  "- t3_session_lifecycle: archive, unarchive, stop, snooze or delete a session. Archive is safe to retry; delete cannot be undone.",
  "- t3_notify_me: get one message in your session when another session waits on a person, finishes or fails. Do not tail transcripts or poll.",
  "Name a session by its id, the first 8 characters of its id, a T3 link, a Linear key, a pull request URL or its title. Inside a session, omit it to mean your own.",
  'Results are short Markdown that ends with the next call; pass format: "json" for data. Pass clientRequestId on writes so a retry does not act twice.',
  "For anything these do not cover, t3_ui_list_tools (pass tools: [name] for its input schema) and t3_ui_call reach every action of the web app.",
].join("\n");
