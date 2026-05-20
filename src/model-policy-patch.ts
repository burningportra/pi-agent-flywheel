export const SUBAGENT_AUTO_EXIT_INSTRUCTION = `
---
When you have completed your task, verify your success, save your artifacts, and exit/close this session. Deliver your final response and do not keep the pane open waiting for user feedback unless you are completely stuck.
`;

export function withSubagentAutoExitInstruction(task: string): string {
  if (task.includes(SUBAGENT_AUTO_EXIT_INSTRUCTION.trim())) {
    return task;
  }
  return `${task.trim()}\n${SUBAGENT_AUTO_EXIT_INSTRUCTION}`;
}
