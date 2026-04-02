/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CursorContextService } from './cursorContextService';
import { getEditorLabel, getPreferredCodeEditor, revealEditorRange, selectCurrentBlock, selectCurrentFunction, setEditorRangeSelection } from './editorContext';
import { CursorProposalService } from './cursorProposalService';

const MAX_READ_LENGTH = 20000;
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_FILE_SCAN = 100;
const MAX_DIRECTORY_ENTRIES = 50;
const MAX_COMMAND_OUTPUT = 4000;
const COMMAND_TIMEOUT_MS = 120000;
const SAFE_COMMAND_PATTERN = /^[\w./:@%+=, -]+$/;

export interface ICursorToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input_schema: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface ICursorToolCallResult {
	readonly toolName: string;
	readonly content: string;
}

export class CursorToolService {

	private readonly managedTerminals = new Set<vscode.Terminal>();

	constructor(
		private readonly contextService: CursorContextService,
		private readonly proposalService: CursorProposalService,
		private readonly outputChannel: vscode.OutputChannel
	) { }

	getDefinitions(): readonly ICursorToolDefinition[] {
		return [
			{
				name: 'get_active_editor_context',
				description: 'Get the current code editor file, selection, and lightweight context.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'read_file',
				description: 'Read a file from the workspace by relative path.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' }
					},
					required: ['path']
				}
			},
			{
				name: 'list_directory',
				description: 'List files and directories for a workspace-relative directory path.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative directory path. Use . for workspace root.' }
					}
				}
			},
			{
				name: 'search_workspace',
				description: 'Search text across workspace files.',
				input_schema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Plain text to search for.' }
					},
					required: ['query']
				}
			},
			{
				name: 'get_diagnostics',
				description: 'Get diagnostics for the active file or a specific workspace-relative file path.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Optional workspace-relative file path.' }
					}
				}
			},
			{
				name: 'open_file',
				description: 'Open a file in the editor, optionally at a line and column.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						line: { type: 'number', description: '1-based line number.' },
						column: { type: 'number', description: '1-based column number.' }
					},
					required: ['path']
				}
			},
			{
				name: 'select_editor_range',
				description: 'Select a range in the currently open code editor.',
				input_schema: {
					type: 'object',
					properties: {
						startLine: { type: 'number' },
						startColumn: { type: 'number' },
						endLine: { type: 'number' },
						endColumn: { type: 'number' }
					},
					required: ['startLine', 'startColumn', 'endLine', 'endColumn']
				}
			},
			{
				name: 'select_current_function',
				description: 'Select the nearest current function or method around the cursor.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'select_current_block',
				description: 'Expand the current selection to the next semantic block.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'reveal_range',
				description: 'Reveal a range in the active editor without changing file contents.',
				input_schema: {
					type: 'object',
					properties: {
						startLine: { type: 'number' },
						startColumn: { type: 'number' },
						endLine: { type: 'number' },
						endColumn: { type: 'number' }
					},
					required: ['startLine', 'startColumn', 'endLine', 'endColumn']
				}
			},
			{
				name: 'create_edit_proposal',
				description: 'Create a diff preview proposal in the current code editor using provided code.',
				input_schema: {
					type: 'object',
					properties: {
						code: { type: 'string', description: 'Code to apply.' },
						mode: { type: 'string', enum: ['insert', 'replace'], description: 'Whether to insert at cursor or replace current selection.' }
					},
					required: ['code', 'mode']
				}
			},
			{
				name: 'write_file',
				description: 'Overwrite a workspace file with complete content.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						content: { type: 'string', description: 'Full new file content.' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'create_file',
				description: 'Create a new workspace file with content. Fails if the file already exists.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						content: { type: 'string', description: 'Initial file content.' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'replace_in_file',
				description: 'Replace exact text in a workspace file.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						search: { type: 'string', description: 'Exact text to replace.' },
						replace: { type: 'string', description: 'Replacement text.' },
						all: { type: 'boolean', description: 'Replace all occurrences instead of the first one.' }
					},
					required: ['path', 'search', 'replace']
				}
			},
			{
				name: 'run_command',
				description: 'Run a safe shell command in an integrated terminal with shell integration and return the output summary.',
				input_schema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Single safe command line to run. No pipes, chaining, redirects, or subshells.' },
						cwd: { type: 'string', description: 'Optional workspace-relative working directory.' }
					},
					required: ['command']
				}
			}
		];
	}

	async invoke(toolName: string, input: unknown): Promise<ICursorToolCallResult> {
		this.log(vscode.l10n.t('Invoking tool {0}.', toolName));
		switch (toolName) {
			case 'get_active_editor_context':
				return { toolName, content: await this.contextService.buildPromptContext() };
			case 'read_file':
				return { toolName, content: await this.readFile(asRecord(input).path) };
			case 'list_directory':
				return { toolName, content: await this.listDirectory(asOptionalString(asRecord(input).path) || '.') };
			case 'search_workspace':
				return { toolName, content: await this.searchWorkspace(asRecord(input).query) };
			case 'get_diagnostics':
				return { toolName, content: await this.getDiagnostics(asOptionalString(asRecord(input).path)) };
			case 'open_file':
				return { toolName, content: await this.openFile(asRecord(input)) };
			case 'select_editor_range':
				return { toolName, content: await this.selectEditorRange(asRecord(input)) };
			case 'select_current_function':
				return { toolName, content: await this.selectCurrentFunction() };
			case 'select_current_block':
				return { toolName, content: await this.selectCurrentBlock() };
			case 'reveal_range':
				return { toolName, content: await this.revealRange(asRecord(input)) };
			case 'create_edit_proposal':
				return { toolName, content: await this.createEditProposal(asRecord(input)) };
			case 'write_file':
				return { toolName, content: await this.writeFile(asRecord(input)) };
			case 'create_file':
				return { toolName, content: await this.createFile(asRecord(input)) };
			case 'replace_in_file':
				return { toolName, content: await this.replaceInFile(asRecord(input)) };
			case 'run_command':
				return { toolName, content: await this.runCommand(asRecord(input)) };
			default:
				throw new Error(vscode.l10n.t('Unknown tool: {0}', toolName));
		}
	}

	private async readFile(pathInput: unknown): Promise<string> {
		const uri = this.resolveWorkspacePath(pathInput);
		const document = await vscode.workspace.openTextDocument(uri);
		return truncateText(document.getText(), MAX_READ_LENGTH);
	}

	private async listDirectory(pathInput: string): Promise<string> {
		const uri = this.resolveWorkspacePath(pathInput);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		return entries
			.slice(0, MAX_DIRECTORY_ENTRIES)
			.map(([name, type]) => `${type === vscode.FileType.Directory ? 'dir' : 'file'} ${name}`)
			.join('\n');
	}

	private async searchWorkspace(queryInput: unknown): Promise<string> {
		const query = asString(queryInput, 'query');
		const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build}/**', MAX_SEARCH_FILE_SCAN);
		const results: string[] = [];

		for (const file of files) {
			if (results.length >= MAX_SEARCH_RESULTS) {
				break;
			}

			let document: vscode.TextDocument;
			try {
				document = await vscode.workspace.openTextDocument(file);
			} catch {
				continue;
			}

			const text = document.getText();
			let index = text.indexOf(query);
			while (index !== -1 && results.length < MAX_SEARCH_RESULTS) {
				const position = document.positionAt(index);
				const lineText = document.lineAt(position.line).text.trim();
				results.push(`${getEditorLabel(file)}:${position.line + 1}:${position.character + 1} ${lineText}`);
				index = text.indexOf(query, index + query.length);
			}
		}

		return results.length ? results.join('\n') : vscode.l10n.t('No matches found.');
	}

	private async getDiagnostics(pathInput?: string): Promise<string> {
		let targetUri: vscode.Uri | undefined;
		if (pathInput) {
			targetUri = this.resolveWorkspacePath(pathInput);
		} else {
			targetUri = getPreferredCodeEditor()?.document.uri;
		}

		if (!targetUri) {
			return vscode.l10n.t('No active code editor.');
		}

		const diagnostics = vscode.languages.getDiagnostics(targetUri);
		if (!diagnostics.length) {
			return vscode.l10n.t('No diagnostics found.');
		}

		return diagnostics.map(diagnostic => {
			return `${formatSeverity(diagnostic.severity)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`;
		}).join('\n');
	}

	private async openFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const document = await vscode.workspace.openTextDocument(uri);
		const line = asOptionalNumber(input.line) ?? 1;
		const column = asOptionalNumber(input.column) ?? 1;
		const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(position, position)
		});
		return vscode.l10n.t('Opened {0} at line {1}, column {2}.', getEditorLabel(uri), line, column);
	}

	private async selectEditorRange(input: Record<string, unknown>): Promise<string> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return vscode.l10n.t('No active code editor.');
		}

		const range = this.createRange(input);
		setEditorRangeSelection(editor, range);
		return vscode.l10n.t('Selected {0}.', formatRange(range));
	}

	private async selectCurrentFunction(): Promise<string> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentFunction(editor);
		if (!range) {
			return vscode.l10n.t('No function or method found at the cursor.');
		}

		return vscode.l10n.t('Selected current function at {0}.', formatRange(range));
	}

	private async selectCurrentBlock(): Promise<string> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentBlock(editor);
		if (!range) {
			return vscode.l10n.t('No semantic block was found for the current cursor position.');
		}

		return vscode.l10n.t('Expanded selection to {0}.', formatRange(range));
	}

	private async revealRange(input: Record<string, unknown>): Promise<string> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return vscode.l10n.t('No active code editor.');
		}

		const range = this.createRange(input);
		revealEditorRange(editor, range);
		return vscode.l10n.t('Revealed {0}.', formatRange(range));
	}

	private async createEditProposal(input: Record<string, unknown>): Promise<string> {
		const code = asString(input.code, 'code');
		const mode = asString(input.mode, 'mode');
		if (mode !== 'insert' && mode !== 'replace') {
			throw new Error(vscode.l10n.t('mode must be insert or replace.'));
		}

		await this.proposalService.createProposalFromCodeBlock(code, mode);
		return vscode.l10n.t('Created {0} proposal.', mode);
	}

	private async writeFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		await this.ensureParentDirectory(uri);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
		return vscode.l10n.t('Wrote {0} characters to {1}.', content.length, getEditorLabel(uri));
	}

	private async createFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		if (await this.fileExists(uri)) {
			throw new Error(vscode.l10n.t('{0} already exists.', getEditorLabel(uri)));
		}

		await this.ensureParentDirectory(uri);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
		return vscode.l10n.t('Created {0}.', getEditorLabel(uri));
	}

	private async replaceInFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const search = asString(input.search, 'search');
		const replace = asStringAllowEmpty(input.replace, 'replace');
		const replaceAll = Boolean(input.all);
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.getText();

		if (!text.includes(search)) {
			throw new Error(vscode.l10n.t('Search text was not found in {0}.', getEditorLabel(uri)));
		}

		const nextText = replaceAll ? text.split(search).join(replace) : text.replace(search, replace);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(nextText, 'utf8'));

		const count = replaceAll ? Math.max(0, text.split(search).length - 1) : 1;
		return vscode.l10n.t('Replaced {0} occurrence(s) in {1}.', count, getEditorLabel(uri));
	}

	private async runCommand(input: Record<string, unknown>): Promise<string> {
		const commandLine = asString(input.command, 'command').trim();
		if (!isSafeCommand(commandLine)) {
			throw new Error(vscode.l10n.t('Command contains unsupported shell control characters. Use a single safe command only.'));
		}

		const cwdUri = this.resolveWorkspaceFolderCwd(asOptionalString(input.cwd));
		const terminal = await this.getOrCreateTerminal(cwdUri);
		terminal.show(false);

		const shellIntegration = await this.waitForShellIntegration(terminal);
		if (!shellIntegration) {
			terminal.sendText(commandLine, true);
			return vscode.l10n.t('Sent command to terminal without shell integration: {0}', commandLine);
		}

		const execution = shellIntegration.executeCommand(commandLine);
		const chunks: string[] = [];
		const readTask = (async () => {
			try {
				for await (const chunk of execution.read()) {
					chunks.push(chunk);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(vscode.l10n.t('Failed to read command output: {0}', message));
			}
		})();

		const exitCode = await new Promise<number | undefined>(resolve => {
			const timer = setTimeout(() => {
				disposable.dispose();
				resolve(undefined);
			}, COMMAND_TIMEOUT_MS);

			const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
				if (event.execution !== execution) {
					return;
				}

				clearTimeout(timer);
				disposable.dispose();
				resolve(event.exitCode);
			});
		});
		await readTask;

		const output = truncateText(stripAnsi(chunks.join('')).trim(), MAX_COMMAND_OUTPUT);
		const header = cwdUri ? `cwd: ${getEditorLabel(cwdUri)}` : 'cwd: workspace root';
		const codeLabel = exitCode === undefined ? 'exit: unknown' : `exit: ${exitCode}`;
		return [header, codeLabel, `command: ${commandLine}`, output].filter(Boolean).join('\n');
	}

	private createRange(input: Record<string, unknown>): vscode.Range {
		return new vscode.Range(
			new vscode.Position(Math.max(0, asNumber(input.startLine, 'startLine') - 1), Math.max(0, asNumber(input.startColumn, 'startColumn') - 1)),
			new vscode.Position(Math.max(0, asNumber(input.endLine, 'endLine') - 1), Math.max(0, asNumber(input.endColumn, 'endColumn') - 1))
		);
	}

	private resolveWorkspacePath(pathInput: unknown): vscode.Uri {
		const pathValue = asString(pathInput, 'path');
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error(vscode.l10n.t('No workspace folder is open.'));
		}

		const normalized = pathValue === '.' ? '' : pathValue.replace(/^\/+/, '');
		return normalized ? vscode.Uri.joinPath(folder.uri, normalized) : folder.uri;
	}

	private resolveWorkspaceFolderCwd(pathInput: string | undefined): vscode.Uri | undefined {
		if (!pathInput || pathInput === '.') {
			return vscode.workspace.workspaceFolders?.[0]?.uri;
		}

		return this.resolveWorkspacePath(pathInput);
	}

	private async fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async ensureParentDirectory(uri: vscode.Uri): Promise<void> {
		const parentPath = uri.path.replace(/\/[^/]+$/, '') || '/';
		const parentUri = uri.with({ path: parentPath });
		await vscode.workspace.fs.createDirectory(parentUri);
	}

	private async getOrCreateTerminal(cwd: vscode.Uri | undefined): Promise<vscode.Terminal> {
		for (const terminal of this.managedTerminals) {
			if (vscode.window.terminals.includes(terminal)) {
				return terminal;
			}
		}

		const terminal = vscode.window.createTerminal({
			name: 'Cursor Agent',
			cwd
		});
		this.managedTerminals.add(terminal);
		return terminal;
	}

	private async waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number = 5000): Promise<vscode.TerminalShellIntegration | undefined> {
		if (terminal.shellIntegration) {
			return terminal.shellIntegration;
		}

		return new Promise<vscode.TerminalShellIntegration | undefined>(resolve => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve(terminal.shellIntegration);
			}, timeoutMs);

			const disposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
				if (event.terminal !== terminal) {
					return;
				}

				clearTimeout(timeout);
				disposable.dispose();
				resolve(event.shellIntegration);
			});
		});
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(vscode.l10n.t('{0} must be a non-empty string.', name));
	}

	return value;
}

function asStringAllowEmpty(value: unknown, name: string): string {
	if (typeof value !== 'string') {
		throw new Error(vscode.l10n.t('{0} must be a string.', name));
	}

	return value;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(vscode.l10n.t('{0} must be a number.', name));
	}

	return value;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 12))}\n...[truncated]`;
}

function formatSeverity(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return 'Error';
		case vscode.DiagnosticSeverity.Warning:
			return 'Warning';
		case vscode.DiagnosticSeverity.Information:
			return 'Information';
		case vscode.DiagnosticSeverity.Hint:
			return 'Hint';
		default:
			return 'Unknown';
	}
}

function formatRange(range: vscode.Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

function isSafeCommand(value: string): boolean {
	return SAFE_COMMAND_PATTERN.test(value) && !/[|&;<>`$(){}[\]\\]/.test(value);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
