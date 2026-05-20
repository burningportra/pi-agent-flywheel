# Custom-goal brainstorming

AgentFlywheel uses a lightweight, Superpowers-style brainstorming step only when the user types their own custom goal instead of choosing a generated/scored idea. Generated idea selections stay fast: they bypass this flow and continue to the normal planning or bead-creation menus with the selected idea text unchanged.

## What happens

1. The raw custom goal is framed as the starting point.
2. AgentFlywheel asks a bounded set of clarifying questions, one at a time.
3. It proposes two or three implementation approaches and asks the user to choose one or describe a hybrid.
4. It builds the enriched goal deterministically from the raw goal, collected answers, selected approach, constraints, non-goals, and success criteria.
5. It writes a session artifact under `brainstorming/<goal-slug>-decision.md` with the decision record.

The decision record is a handoff note for the current session: it shows what the user chose and why before planning starts. Planning still happens afterward through the normal plan/deep-plan/direct-to-beads workflow.

The decision record is not a fresh LLM summary. It is formatted from the data already collected during the flow so the saved artifact cannot drift away from the goal the user approved.

## Scope and non-scope

- Applies to custom goals entered from `/agent-flywheel <goal>`, the profile/start menu custom-goal path, and the select-menu custom-goal path.
- Does not run when the user chooses a generated/scored idea; that path still asks only for optional constraints and workflow choice.
- Does not replace generated idea discovery, dueling idea scoring, plan generation, or bead approval.
- Does not write to CASS, MemPalace, or any other memory store.
- Does not store decision records under `plans/`, so saved-plan discovery will not mistake brainstorming records for implementation plans.

## Degraded paths

The flow is fail-open. If question generation, approach generation, TUI interaction, or artifact writing cannot complete, AgentFlywheel keeps the orchestration moving:

- malformed or empty model output falls back to deterministic defaults where possible;
- cancel/skip returns to the original goal without partial goal state;
- artifact write failures return the enriched goal plus a warning instead of failing the session.

## Verification expectations

Tests should cover the full mocked path from raw custom goal to enriched goal and decision record, plus the bypass behavior for generated idea selection. Documentation should keep the custom-goal-only scope explicit and avoid implying memory integration or plan-generation replacement.
