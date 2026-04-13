# Beam

Beam is a VS Code extension that keeps the current Beam workflow in plugin form instead of baking more behavior into the workbench layout.

## What It Includes

- A right-side Beam chat panel with model selection and attachments
- Real-file-first edit proposals with accept/reject flow
- Multi-file proposal navigation for reviewing a batch of pending edits
- Inline code completions inside the editor
- Workspace-aware tools for reading files, searching code, gathering diagnostics, and proposing changes

## Review Flow

Beam follows a Cursor-like proposal model:

1. The agent edits the real workspace file first.
2. Beam keeps the change as a pending proposal.
3. You review the diff on the original file.
4. You accept to keep it or reject to roll it back.

For multi-file edits, Beam keeps the proposal set together and lets you move to the previous or next changed file.

## Development

From the repository root:

```bash
./node_modules/.bin/tsc -p extensions/beam/tsconfig.json --noEmit
./node_modules/.bin/tsc -p extensions/beam/tsconfig.json
./node_modules/.bin/mocha --ui tdd extensions/beam/out/test/**/*.test.js
```

From `extensions/beam`:

```bash
npm run compile
npm run test
```

## Packaging

After compiling, package Beam as a regular VS Code extension from `extensions/beam` with your preferred VSIX workflow, for example:

```bash
npx @vscode/vsce package
```

If you keep developing Beam inside this monorepo, the relative scripts in `package.json` will continue to use the repository root toolchain.
