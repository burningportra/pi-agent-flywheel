# Changelog

All notable changes to `pi-agent-flywheel` are documented here.

## 1.2.13 - 2026-05-08

### Added
- Added Bead-Level Verification Contracts across planning, approval, review, documentation, and regression coverage so bead completion claims are checked against concrete verification evidence.
- Added interactive Dueling Idea Wizards support with persisted wizard artifacts and a fallback absolute artifact path when `write_artifact` is unavailable.
- Added profile-continuation handling so repeated profile calls resume the current AgentFlywheel phase instead of reopening discovery or trapping users in a profile/discover/select loop.

### Improved
- Improved deep discovery recovery by avoiding repeated wizard-launch prompts, filling mismatched winnowing output with top-scored ideas, handling cancelled review prompts cleanly, and presenting accepted ideas for normal goal selection.
- Persisted state when direct-to-beads paths enter bead creation from profile or selection flows.
- Added end-to-end orchestration resilience coverage for `br` failure scenarios and expanded automatic review-decision test coverage.

### Notes
- Earlier flywheel-alignment history is summarized in `docs/flywheel-alignment-changelog.md`.
