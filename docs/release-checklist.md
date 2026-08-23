# Release checklist workflow

Use the release checklist before tagging, publishing, or handing release work to another agent.

```text
/flywheel-release-checklist
```

Legacy aliases:

```text
/flywheel-release-checklist
/agent-flywheel-release-checklist
```

The command is advisory and non-mutating. It reads `package.json`, `package-lock.json`, and `git status --short`, then prints a short report and the verification commands to run next.

## When to run it

Run the checklist after implementation and review are complete, but before commits, tags, version bumps, or publishing. Run it again after any manual fix to package metadata or release scope.

## How to read the output

- **Version consistency:** confirms that `package.json`, top-level `package-lock.json`, and `package-lock.json`'s root package version agree. A mismatch means an agent must fix package metadata in a separate edit, then re-run the checklist.
- **Dirty-file scope:** groups `git status --short` entries into release-relevant buckets such as package metadata, docs, source, tests, bead metadata, generated/runtime metadata, and unknown files. Use this section to confirm the dirty files match the intended release scope. If git status cannot be read, the checklist says the dirty scope is unknown instead of claiming the checkout is clean.
- **Recommended checks:** prints copy/paste-ready build, test, and UBS verification commands, including `npm run build`, `npm test`, and a UBS command. When dirty files are known, the UBS command targets those files; otherwise it falls back to `ubs .`.

## What it does not do

The checklist never performs release mutations. It does **not**:

- commit changes
- create or move git tags
- publish packages
- bump versions
- update `package.json`, `package-lock.json`, or other files
- reset, clean, stash, or otherwise alter git state
- edit bead metadata
- mutate files or the working tree

If the checklist reports a mismatch, unexpected dirty-file scope, or missing verification, do that work explicitly in a separate implementation step. Then re-run the checklist and keep commit/tag/publish commands outside the checklist workflow.
