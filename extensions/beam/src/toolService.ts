/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { isReadOnlyCommand, isSafeCommand } from './commandPolicy';
import { BeamContextService } from './contextService';
import { getEditorLabel, getPreferredCodeEditor, revealEditorRange, selectCurrentBlock, selectCurrentFunction, setEditorRangeSelection } from './editorContext';
import { BeamProposalService, type IBeamProposalChangeSummary } from './proposalService';

const MAX_READ_LENGTH = 20000;
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_FILE_SCAN = 100;
const MAX_DIRECTORY_ENTRIES = 50;
const MAX_COMMAND_OUTPUT = 4000;
const COMMAND_TIMEOUT_MS = 30000;

export interface IBeamToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input_schema: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface IBeamToolCallResult {
	readonly toolName: string;
	readonly content: string;
	readonly displayContent?: string;
}

interface IWorkspaceSearchMatch {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly text: string;
}

interface IBeamToolText {
	readonly model: string;
	readonly display: string;
}

export class BeamToolService {

	private readonly managedTerminals = new Set<vscode.Terminal>();

	constructor(
		private readonly contextService: BeamContextService,
		private readonly proposalService: BeamProposalService,
		private readonly outputChannel: vscode.OutputChannel
	) { }

	getDefinitions(): readonly IBeamToolDefinition[] {
		return [
			{
				name: 'get_active_editor_context',
				description: 'Get the current code editor file, selection, and lightweight surrounding context.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'read_file',
				description: 'Read a file by workspace-relative path.',
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
				description: 'List files and subdirectories inside a workspace-relative directory.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative directory path. Use "." for the workspace root.' }
					}
				}
			},
			{
				name: 'search_workspace',
				description: 'Search for plain text across workspace files.',
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
				description: 'Get diagnostics for the current file or for a file specified by workspace-relative path.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Optional workspace-relative file path.' }
					}
				}
			},
			{
				name: 'open_file',
				description: 'Open a file in the editor, optionally at a specific line and column.',
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
				description: 'Select a specific range in the currently open code editor.',
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
				description: 'Select the current function or method near the cursor.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'select_current_block',
				description: 'Expand the current selection to the next semantic code block.',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'reveal_range',
				description: 'Reveal a specific range in the current editor without modifying file contents.',
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
				description: 'Create a previewable edit proposal in the current editor using the provided code.',
				input_schema: {
					type: 'object',
					properties: {
						code: { type: 'string', description: 'Code to apply.' },
						mode: { type: 'string', enum: ['insert', 'replace'], description: 'Whether to insert at the cursor or replace the current selection. If no selection exists, `replace` creates a full-file replacement proposal for the current file.' }
					},
					required: ['code', 'mode']
				}
			},
			{
				name: 'write_file',
				description: 'Create a reviewable proposal that overwrites a workspace file with full new contents.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						content: { type: 'string', description: 'Complete new file contents.' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'create_file',
				description: 'Create a reviewable proposal for a new workspace file with content; fail if the file already exists.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						content: { type: 'string', description: 'Initial file contents.' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'delete_file',
				description: 'Create a reviewable proposal that deletes a file.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative or absolute file path.' }
					},
					required: ['path']
				}
			},
			{
				name: 'replace_in_file',
				description: 'Create a reviewable proposal that replaces exact text inside a workspace file.',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path.' },
						search: { type: 'string', description: 'Exact text to replace.' },
						replace: { type: 'string', description: 'Replacement text.' },
						all: { type: 'boolean', description: 'Whether to replace all matches instead of only the first.' }
					},
					required: ['path', 'search', 'replace']
				}
			},
			{
				name: 'run_command',
				description: 'Run a read-only shell command in the integrated terminal and return a concise summary of the output. Commands that modify files or workspace state are not allowed.',
				input_schema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'A single read-only command. Do not include pipes, command chaining, redirection, subshells, or any write operation.' },
						cwd: { type: 'string', description: 'Optional workspace-relative working directory.' }
					},
					required: ['command']
				}
			}
		];
	}

	async invoke(toolName: string, input: unknown, token?: vscode.CancellationToken): Promise<IBeamToolCallResult> {
		this.log(vscode.l10n.t('\u6b63\u5728\u8c03\u7528\u5de5\u5177 {0}\u3002', toolName));
		try {
			this.throwIfCancelled(token);
			switch (toolName) {
				case 'get_active_editor_context':
					return this.toCallResult(toolName, {
						model: await this.contextService.buildPromptContext('model'),
						display: await this.contextService.buildPromptContext('display')
					});
				case 'read_file':
					return this.toCallResult(toolName, await this.readFile(asRecord(input).path));
				case 'list_directory':
					return this.toCallResult(toolName, await this.listDirectory(asOptionalString(asRecord(input).path) || '.'));
				case 'search_workspace':
					return this.toCallResult(toolName, await this.searchWorkspace(asRecord(input).query, token));
				case 'get_diagnostics':
					return this.toCallResult(toolName, await this.getDiagnostics(asOptionalString(asRecord(input).path)));
				case 'open_file':
					return this.toCallResult(toolName, await this.openFile(asRecord(input)));
				case 'select_editor_range':
					return this.toCallResult(toolName, await this.selectEditorRange(asRecord(input)));
				case 'select_current_function':
					return this.toCallResult(toolName, await this.selectCurrentFunction());
				case 'select_current_block':
					return this.toCallResult(toolName, await this.selectCurrentBlock());
				case 'reveal_range':
					return this.toCallResult(toolName, await this.revealRange(asRecord(input)));
				case 'create_edit_proposal':
					return this.toCallResult(toolName, await this.createEditProposal(asRecord(input)));
				case 'write_file':
					return this.toCallResult(toolName, await this.writeFile(asRecord(input)));
				case 'create_file':
					return this.toCallResult(toolName, await this.createFile(asRecord(input)));
				case 'delete_file':
					return this.toCallResult(toolName, await this.deleteFile(asRecord(input)));
				case 'replace_in_file':
					return this.toCallResult(toolName, await this.replaceInFile(asRecord(input)));
				case 'run_command':
					return this.toCallResult(toolName, await this.runCommand(asRecord(input), token));
				default:
					throw new Error(vscode.l10n.t('\u672a\u77e5\u5de5\u5177\uff1a{0}', toolName));
			}
		} catch (error) {
			const message = toErrorMessage(error);
			this.log(vscode.l10n.t('\u5de5\u5177 {0} \u6267\u884c\u5931\u8d25\uff1a{1}', toolName, message));
			return {
				toolName,
				content: `Tool execution failed: ${message}`,
				displayContent: vscode.l10n.t('\u5de5\u5177\u6267\u884c\u5931\u8d25\uff1a{0}', message)
			};
		}
	}

	private toCallResult(toolName: string, text: IBeamToolText): IBeamToolCallResult {
		return {
			toolName,
			content: text.model,
			displayContent: text.display
		};
	}

	private createToolText(model: string, display: string): IBeamToolText {
		return { model, display };
	}

	private async readFile(pathInput: unknown): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(pathInput);
		const document = await vscode.workspace.openTextDocument(uri);
		return this.createToolText(
			[
				'Summary: Read 1 file',
				`-- ${getEditorLabel(uri)}`,
				'',
				truncateText(document.getText(), MAX_READ_LENGTH)
			].join('\n'),
			[
				vscode.l10n.t('摘要：已读取 1 个文件'),
				`-- ${getEditorLabel(uri)}`,
				'',
				truncateText(document.getText(), MAX_READ_LENGTH)
			].join('\n')
		);
	}

	private async listDirectory(pathInput: string): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(pathInput);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const visibleEntries = entries.slice(0, MAX_DIRECTORY_ENTRIES);
		return this.createToolText(
			visibleEntries
				.map(([name, type]) => `${type === vscode.FileType.Directory ? 'Directory' : 'File'} ${name}`)
				.join('\n'),
			visibleEntries
				.map(([name, type]) => `${type === vscode.FileType.Directory ? '\u76ee\u5f55' : '\u6587\u4ef6'} ${name}`)
				.join('\n')
		);
	}

	private async searchWorkspace(queryInput: unknown, token?: vscode.CancellationToken): Promise<IBeamToolText> {
		const query = asString(queryInput, 'query');
		const workspaceFiles = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build}/**', MAX_SEARCH_FILE_SCAN);
		const results: IWorkspaceSearchMatch[] = [];

		for (const file of workspaceFiles) {
			this.throwIfCancelled(token);
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
				results.push({
					file: getEditorLabel(file),
					line: position.line + 1,
					column: position.character + 1,
					text: lineText
				});
				index = text.indexOf(query, index + query.length);
			}
		}

		if (!results.length) {
			return this.createToolText('No matches found.', vscode.l10n.t('\u6ca1\u6709\u627e\u5230\u5339\u914d\u7ed3\u679c\u3002'));
		}

		const files = [...new Set(results.map(result => result.file))];
		return this.createToolText(
			[
				`Summary: Found ${results.length} matches in ${files.length} file${files.length === 1 ? '' : 's'}`,
				...files.map(file => `-- ${file}`),
				'',
				...results.map(result => `${result.file}:${result.line}:${result.column} ${result.text}`)
			].join('\n'),
			[
				vscode.l10n.t('摘要：已搜索到 {0} 个文件中的 {1} 条匹配', files.length, results.length),
				...files.map(file => `-- ${file}`),
				'',
				...results.map(result => `${result.file}:${result.line}:${result.column} ${result.text}`)
			].join('\n')
		);
	}

	private async getDiagnostics(pathInput?: string): Promise<IBeamToolText> {
		let targetUri: vscode.Uri | undefined;
		if (pathInput) {
			targetUri = this.resolveWorkspacePath(pathInput);
		} else {
			targetUri = getPreferredCodeEditor()?.document.uri;
		}

		if (!targetUri) {
			return this.createToolText('No active code editor.', vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002'));
		}

		const diagnostics = vscode.languages.getDiagnostics(targetUri);
		if (!diagnostics.length) {
			return this.createToolText('No diagnostics.', vscode.l10n.t('\u6ca1\u6709\u8bca\u65ad\u4fe1\u606f\u3002'));
		}

		return this.createToolText(
			[
				`Summary: ${getEditorLabel(targetUri)} has ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`,
				`-- ${getEditorLabel(targetUri)}`,
				'',
				...diagnostics.map(diagnostic => {
					return `${formatSeverity(diagnostic.severity)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`;
				})
			].join('\n'),
			[
				vscode.l10n.t('摘要：{0} 中共有 {1} 条诊断信息', getEditorLabel(targetUri), diagnostics.length),
				`-- ${getEditorLabel(targetUri)}`,
				'',
				...diagnostics.map(diagnostic => {
					return `${formatSeverityDisplay(diagnostic.severity)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`;
				})
			].join('\n')
		);
	}

	private async openFile(input: Record<string, unknown>): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(input.path);
		const document = await vscode.workspace.openTextDocument(uri);
		const line = asOptionalNumber(input.line) ?? 1;
		const column = asOptionalNumber(input.column) ?? 1;
		const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(position, position)
		});
		return this.createToolText(
			`Opened ${getEditorLabel(uri)}, positioned at line ${line}, column ${column}.`,
			vscode.l10n.t('\u5df2\u6253\u5f00 {0}\uff0c\u5b9a\u4f4d\u5230\u7b2c {1} \u884c\u3001\u7b2c {2} \u5217\u3002', getEditorLabel(uri), line, column)
		);
	}

	private async selectEditorRange(input: Record<string, unknown>): Promise<IBeamToolText> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return this.createToolText('No active code editor.', vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002'));
		}

		const range = this.createRange(input);
		setEditorRangeSelection(editor, range);
		return this.createToolText(`Selected ${formatRange(range)}.`, vscode.l10n.t('\u5df2\u9009\u4e2d {0}\u3002', formatRange(range)));
	}

	private async selectCurrentFunction(): Promise<IBeamToolText> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentFunction(editor);
		if (!range) {
			return this.createToolText('No function or method was found near the current cursor position.', vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u51fd\u6570\u6216\u65b9\u6cd5\u3002'));
		}

		return this.createToolText(`Selected the current function: ${formatRange(range)}.`, vscode.l10n.t('\u5df2\u9009\u4e2d\u5f53\u524d\u51fd\u6570\uff1a{0}\u3002', formatRange(range)));
	}

	private async selectCurrentBlock(): Promise<IBeamToolText> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentBlock(editor);
		if (!range) {
			return this.createToolText('No recognizable code block was found near the current cursor position.', vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u53ef\u8bc6\u522b\u7684\u4ee3\u7801\u5757\u3002'));
		}

		return this.createToolText(`Expanded the selection to ${formatRange(range)}.`, vscode.l10n.t('\u5df2\u5c06\u9009\u533a\u6269\u5c55\u5230 {0}\u3002', formatRange(range)));
	}

	private async revealRange(input: Record<string, unknown>): Promise<IBeamToolText> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return this.createToolText('No active code editor.', vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002'));
		}

		const range = this.createRange(input);
		revealEditorRange(editor, range);
		return this.createToolText(`Revealed ${formatRange(range)}.`, vscode.l10n.t('\u5df2\u5b9a\u4f4d\u5230 {0}\u3002', formatRange(range)));
	}

	private async createEditProposal(input: Record<string, unknown>): Promise<IBeamToolText> {
		const code = asString(input.code, 'code');
		const mode = asString(input.mode, 'mode');
		if (mode !== 'insert' && mode !== 'replace') {
			throw new Error('mode must be insert or replace.');
		}

		const summary = await this.proposalService.createProposalFromCodeBlock(code, mode);
		return this.formatProposalCreatedMessage(summary, 'Applied the edit in the editor as a pending proposal. Waiting for user confirmation.', vscode.l10n.t('\u5df2\u5148\u5728\u7f16\u8f91\u5668\u4e2d\u5e94\u7528\u4fee\u6539\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002'));
	}

	private async writeFile(input: Record<string, unknown>): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		const summary = await this.proposalService.createFileProposal(uri, content, 'file');
		return this.formatProposalCreatedMessage(summary, `Applied a pending file change for ${getEditorLabel(uri)}. Waiting for user confirmation.`, vscode.l10n.t('\u5df2\u4e3a {0} \u5148\u5e94\u7528\u6587\u4ef6\u4fee\u6539\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002', getEditorLabel(uri)));
	}

	private async createFile(input: Record<string, unknown>): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		if (await this.uriExists(uri)) {
			throw new Error(`${getEditorLabel(uri)} already exists. Use write_file or replace_in_file instead.`);
		}
		const summary = await this.proposalService.createFileProposal(uri, content, 'file');
		return this.formatProposalCreatedMessage(summary, `Created a pending proposal for ${getEditorLabel(uri)}. Waiting for user confirmation.`, vscode.l10n.t('\u5df2\u5148\u521b\u5efa {0}\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002', getEditorLabel(uri)));
	}

	private async deleteFile(input: Record<string, unknown>): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(input.path);
		const summary = await this.proposalService.createDeleteProposal(uri);
		return this.formatProposalCreatedMessage(summary, `Created a pending delete proposal for ${getEditorLabel(uri)}. Waiting for user confirmation.`, vscode.l10n.t('\u5df2\u751f\u6210 {0} \u7684\u5220\u9664\u63d0\u8bae\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002', getEditorLabel(uri)));
	}

	private async replaceInFile(input: Record<string, unknown>): Promise<IBeamToolText> {
		const uri = this.resolveWorkspacePath(input.path);
		const search = asString(input.search, 'search');
		const replace = asStringAllowEmpty(input.replace, 'replace');
		const replaceAll = Boolean(input.all);
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.getText();

		if (!text.includes(search)) {
			throw new Error(`Could not find the target text to replace in ${getEditorLabel(uri)}.`);
		}

		const nextText = replaceAll ? text.split(search).join(replace) : text.replace(search, replace);
		const summary = await this.proposalService.createFileProposal(uri, nextText, 'file');

		const count = replaceAll ? Math.max(0, text.split(search).length - 1) : 1;
		return this.formatProposalCreatedMessage(summary, `Applied ${count} pending replacement${count === 1 ? '' : 's'} in ${getEditorLabel(uri)}. Waiting for user confirmation.`, vscode.l10n.t('\u5df2\u5728 {1} \u4e2d\u5148\u5e94\u7528 {0} \u5904\u66ff\u6362\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002', count, getEditorLabel(uri)));
	}

	private async runCommand(input: Record<string, unknown>, token?: vscode.CancellationToken): Promise<IBeamToolText> {
		const commandLine = asString(input.command, 'command').trim();
		if (!isSafeCommand(commandLine)) {
			throw new Error('The command contains unsupported shell control operators. Only a single read-only command is allowed.');
		}

		if (!isReadOnlyCommand(commandLine)) {
			throw new Error('Only read, search, or git inspection commands are allowed. Any file-changing operation must go through Beam proposals.');
		}

		const cwdUri = this.resolveWorkspaceFolderCwd(asOptionalString(input.cwd));
		const terminal = await this.getOrCreateTerminal(cwdUri);
		terminal.show(false);
		this.throwIfCancelled(token);

		const shellIntegration = await this.waitForShellIntegration(terminal);
		if (!shellIntegration) {
			terminal.sendText(commandLine, true);
			return this.createToolText(
				`Sent the command to the terminal, but shell integration is unavailable: ${commandLine}`,
				vscode.l10n.t('\u5df2\u5c06\u547d\u4ee4\u53d1\u9001\u5230\u7ec8\u7aef\uff0c\u4f46\u5f53\u524d\u6ca1\u6709 shell integration\uff1a{0}', commandLine)
			);
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
				this.log(vscode.l10n.t('\u8bfb\u53d6\u547d\u4ee4\u8f93\u51fa\u5931\u8d25\uff1a{0}', message));
			}
		})();

		const exitCode = await new Promise<number | undefined>((resolve, reject) => {
			const timer = setTimeout(() => {
				disposable.dispose();
				cancellationDisposable?.dispose();
				try {
					terminal.sendText('\u0003', false);
				} catch {
					// Best-effort interrupt.
				}
				resolve(undefined);
			}, COMMAND_TIMEOUT_MS);

			const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
				if (event.execution !== execution) {
					return;
				}

				clearTimeout(timer);
				disposable.dispose();
				cancellationDisposable?.dispose();
				resolve(event.exitCode);
			});

			const cancellationDisposable = token?.onCancellationRequested(() => {
				clearTimeout(timer);
				disposable.dispose();
				cancellationDisposable?.dispose();
				try {
					terminal.sendText('\u0003', false);
				} catch {
					// Best-effort interrupt.
				}
				reject(new Error('Beam request cancelled.'));
			});
		});
		this.throwIfCancelled(token);
		await raceWithTimeout(readTask, 300);

		const output = truncateText(stripAnsi(chunks.join('')).trim(), MAX_COMMAND_OUTPUT);
		const header = cwdUri ? `Cwd: ${getEditorLabel(cwdUri)}` : 'Cwd: workspace root';
		const codeLabel = exitCode === undefined ? 'Exit code: unknown' : `Exit code: ${exitCode}`;
		const displayHeader = cwdUri ? `\u76ee\u5f55\uff1a${getEditorLabel(cwdUri)}` : '\u76ee\u5f55\uff1a\u5de5\u4f5c\u533a\u6839\u76ee\u5f55';
		const displayCodeLabel = exitCode === undefined ? '\u9000\u51fa\u7801\uff1a\u672a\u77e5' : `\u9000\u51fa\u7801\uff1a${exitCode}`;
		return this.createToolText(
			[
				'Summary: Executed command',
				`Command: ${commandLine}`,
				header,
				codeLabel,
				'',
				'```text',
				output || '(no output)',
				'```'
			].join('\n'),
			[
				'摘要：已执行命令',
				`\u547d\u4ee4\uff1a${commandLine}`,
				displayHeader,
				displayCodeLabel,
				'',
				'```text',
				output || '\uff08\u65e0\u8f93\u51fa\uff09',
				'```'
			].join('\n')
		);
	}

	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) {
			throw new Error('Beam request cancelled.');
		}
	}

	private createRange(input: Record<string, unknown>): vscode.Range {
		return new vscode.Range(
			new vscode.Position(Math.max(0, asNumber(input.startLine, 'startLine') - 1), Math.max(0, asNumber(input.startColumn, 'startColumn') - 1)),
			new vscode.Position(Math.max(0, asNumber(input.endLine, 'endLine') - 1), Math.max(0, asNumber(input.endColumn, 'endColumn') - 1))
		);
	}

	private resolveWorkspacePath(pathInput: unknown): vscode.Uri {
		const pathValue = asString(pathInput, 'path');
		if (path.isAbsolute(pathValue)) {
			return vscode.Uri.file(path.normalize(pathValue));
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error('No workspace folder is open.');
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

	private async getOrCreateTerminal(cwd: vscode.Uri | undefined): Promise<vscode.Terminal> {
		for (const terminal of this.managedTerminals) {
			if (vscode.window.terminals.includes(terminal)) {
				return terminal;
			}
		}

		const terminal = vscode.window.createTerminal({
			name: 'Beam',
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

	private formatProposalCreatedMessage(summary: IBeamProposalChangeSummary, modelIntro: string, displayIntro: string): IBeamToolText {
		const modelLinePart = summary.firstChangeLine
			? (summary.lastChangeLine && summary.lastChangeLine !== summary.firstChangeLine
				? `Lines ${summary.firstChangeLine}-${summary.lastChangeLine}`
				: `Line ${summary.firstChangeLine}`)
			: 'Whole file';
		const displayLinePart = summary.firstChangeLine
			? (summary.lastChangeLine && summary.lastChangeLine !== summary.firstChangeLine
				? vscode.l10n.t('\u7b2c {0}-{1} \u884c', summary.firstChangeLine, summary.lastChangeLine)
				: vscode.l10n.t('\u7b2c {0} \u884c', summary.firstChangeLine))
			: vscode.l10n.t('\u6574\u6587\u4ef6');
		const statParts = formatCompactChangeStats(summary);
		const modelSummaryRowParts = [
			summary.label,
			...statParts,
			modelLinePart !== 'Whole file' ? '>' : ''
		].filter(Boolean);
		const displaySummaryRowParts = [
			summary.label,
			...statParts,
			displayLinePart !== vscode.l10n.t('\u6574\u6587\u4ef6') ? '>' : ''
		].filter(Boolean);
		const displayTitle = summary.isNewFile
			? vscode.l10n.t('新增')
			: summary.mode === 'delete'
				? vscode.l10n.t('删除')
				: vscode.l10n.t('改动');
		const modelTitle = summary.isNewFile
			? 'Created'
			: summary.mode === 'delete'
				? 'Deleted'
				: 'Changed';
		const language = inferCodeFenceLanguage(summary.label);
		const codeFenceHeader = language ? `\`\`\`${language}` : '```';
		const contentForDisplay = summary.mode === 'delete'
			? summary.originalText
			: summary.proposedText;
		const contentForModel = summary.mode === 'delete'
			? summary.originalText
			: summary.proposedText;

		return this.createToolText(
			[
				modelIntro,
				'',
				`Summary: ${modelTitle} 1 file`,
				`-- ${modelSummaryRowParts.join('  ') || summary.label}`,
				`Changed file: ${summary.label}`,
				`Location: ${modelLinePart}`,
				`Stats: ${statParts.join('  ') || 'Code differences detected'}`,
				'Status: Editor content has been modified as a pending proposal. The user can accept or reject it in Beam.',
				'',
				codeFenceHeader,
				contentForModel,
				'```'
			].join('\n'),
			[
				displayIntro,
				'',
				vscode.l10n.t('摘要：已修改 1 个文件'),
				`-- ${displaySummaryRowParts.join('  ') || summary.label}`,
				`${displayTitle}\uff1a${summary.label}`,
				vscode.l10n.t('变更文件：{0}', summary.label),
				vscode.l10n.t('位置：{0}', displayLinePart),
				vscode.l10n.t('统计：{0}', statParts.join('  ') || vscode.l10n.t('存在代码差异')),
				vscode.l10n.t('状态：已修改编辑器内容，可在 Beam 中接受或拒绝。'),
				'',
				codeFenceHeader,
				contentForDisplay,
				'```'
			].join('\n')
		);
	}

	private async uriExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
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
		throw new Error(`${name} must be a non-empty string.`);
	}

	return value;
}

function asStringAllowEmpty(value: unknown, name: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${name} must be a string.`);
	}

	return value;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(`${name} must be a number.`);
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

function formatSeverityDisplay(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return '\u9519\u8bef';
		case vscode.DiagnosticSeverity.Warning:
			return '\u8b66\u544a';
		case vscode.DiagnosticSeverity.Information:
			return '\u4fe1\u606f';
		case vscode.DiagnosticSeverity.Hint:
			return '\u63d0\u793a';
		default:
			return '\u672a\u77e5';
	}
}

function formatRange(range: vscode.Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

function formatCompactChangeStats(summary: Pick<IBeamProposalChangeSummary, 'addedLines' | 'deletedLines' | 'modifiedLines'>): string[] {
	const stats: string[] = [];
	if (summary.addedLines) {
		stats.push(`+${summary.addedLines}`);
	}
	if (summary.deletedLines) {
		stats.push(`-${summary.deletedLines}`);
	}
	if (summary.modifiedLines) {
		stats.push(`~${summary.modifiedLines}`);
	}
	return stats;
}

function inferCodeFenceLanguage(filePath: string): string {
	const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
	switch (extension) {
		case 'ts':
		case 'tsx':
		case 'js':
		case 'jsx':
		case 'json':
		case 'css':
		case 'scss':
		case 'html':
		case 'md':
		case 'rs':
		case 'py':
		case 'sh':
		case 'yaml':
		case 'yml':
		case 'toml':
			return extension === 'md' ? 'markdown' : extension;
		default:
			return '';
	}
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

async function raceWithTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
	await Promise.race([
		task,
		new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
	]);
}
