/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isReadOnlyCommand, isSafeCommand } from './commandPolicy';
import { BeamContextService } from './contextService';
import { getEditorLabel, getPreferredCodeEditor, revealEditorRange, selectCurrentBlock, selectCurrentFunction, setEditorRangeSelection } from './editorContext';
import { BeamProposalService } from './proposalService';

const MAX_READ_LENGTH = 20000;
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_FILE_SCAN = 100;
const MAX_DIRECTORY_ENTRIES = 50;
const MAX_COMMAND_OUTPUT = 4000;
const COMMAND_TIMEOUT_MS = 120000;

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
				description: '\u83b7\u53d6\u5f53\u524d\u4ee3\u7801\u7f16\u8f91\u5668\u7684\u6587\u4ef6\u3001\u9009\u533a\u548c\u8f7b\u91cf\u4e0a\u4e0b\u6587\u3002',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'read_file',
				description: '\u6309\u5de5\u4f5c\u533a\u76f8\u5bf9\u8def\u5f84\u8bfb\u53d6\u6587\u4ef6\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' }
					},
					required: ['path']
				}
			},
			{
				name: 'list_directory',
				description: '\u5217\u51fa\u5de5\u4f5c\u533a\u76f8\u5bf9\u76ee\u5f55\u4e0b\u7684\u6587\u4ef6\u548c\u5b50\u76ee\u5f55\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u76ee\u5f55\u8def\u5f84\u3002\u5de5\u4f5c\u533a\u6839\u76ee\u5f55\u8bf7\u4f7f\u7528 .\u3002' }
					}
				}
			},
			{
				name: 'search_workspace',
				description: '\u5728\u5de5\u4f5c\u533a\u6587\u4ef6\u4e2d\u641c\u7d22\u6587\u672c\u3002',
				input_schema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: '\u8981\u641c\u7d22\u7684\u7eaf\u6587\u672c\u3002' }
					},
					required: ['query']
				}
			},
			{
				name: 'get_diagnostics',
				description: '\u83b7\u53d6\u5f53\u524d\u6587\u4ef6\u6216\u6307\u5b9a\u5de5\u4f5c\u533a\u76f8\u5bf9\u8def\u5f84\u6587\u4ef6\u7684\u8bca\u65ad\u4fe1\u606f\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u53ef\u9009\u7684\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' }
					}
				}
			},
			{
				name: 'open_file',
				description: '\u5728\u7f16\u8f91\u5668\u4e2d\u6253\u5f00\u6587\u4ef6\uff0c\u53ef\u9009\u6307\u5b9a\u884c\u53f7\u548c\u5217\u53f7\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' },
						line: { type: 'number', description: '\u4ece 1 \u5f00\u59cb\u7684\u884c\u53f7\u3002' },
						column: { type: 'number', description: '\u4ece 1 \u5f00\u59cb\u7684\u5217\u53f7\u3002' }
					},
					required: ['path']
				}
			},
			{
				name: 'select_editor_range',
				description: '\u5728\u5f53\u524d\u6253\u5f00\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u4e2d\u9009\u4e2d\u6307\u5b9a\u8303\u56f4\u3002',
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
				description: '\u9009\u4e2d\u5149\u6807\u9644\u8fd1\u7684\u5f53\u524d\u51fd\u6570\u6216\u65b9\u6cd5\u3002',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'select_current_block',
				description: '\u5c06\u5f53\u524d\u9009\u533a\u6269\u5c55\u5230\u4e0b\u4e00\u4e2a\u8bed\u4e49\u4ee3\u7801\u5757\u3002',
				input_schema: {
					type: 'object',
					properties: {}
				}
			},
			{
				name: 'reveal_range',
				description: '\u5728\u5f53\u524d\u7f16\u8f91\u5668\u4e2d\u5b9a\u4f4d\u5230\u6307\u5b9a\u8303\u56f4\uff0c\u4e0d\u4fee\u6539\u6587\u4ef6\u5185\u5bb9\u3002',
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
				description: '\u57fa\u4e8e\u7ed9\u5b9a\u4ee3\u7801\u5728\u5f53\u524d\u7f16\u8f91\u5668\u4e2d\u521b\u5efa\u4e00\u4e2a\u53ef\u9884\u89c8\u7684\u7f16\u8f91\u63d0\u8bae\u3002',
				input_schema: {
					type: 'object',
					properties: {
						code: { type: 'string', description: '\u8981\u5e94\u7528\u7684\u4ee3\u7801\u3002' },
						mode: { type: 'string', enum: ['insert', 'replace'], description: '\u662f\u5728\u5149\u6807\u5904\u63d2\u5165\uff0c\u8fd8\u662f\u66ff\u6362\u5f53\u524d\u9009\u533a\uff08\u82e5\u6ca1\u6709\u9009\u533a\uff0creplace \u4f1a\u5bf9\u5f53\u524d\u6587\u4ef6\u751f\u6210\u6574\u6587\u66ff\u6362\u63d0\u6848\uff09\u3002' }
					},
					required: ['code', 'mode']
				}
			},
			{
				name: 'write_file',
				description: '\u7528\u5b8c\u6574\u5185\u5bb9\u8986\u76d6\u4e00\u4e2a\u5de5\u4f5c\u533a\u6587\u4ef6\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' },
						content: { type: 'string', description: '\u5b8c\u6574\u7684\u65b0\u6587\u4ef6\u5185\u5bb9\u3002' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'create_file',
				description: '\u521b\u5efa\u4e00\u4e2a\u5e26\u5185\u5bb9\u7684\u65b0\u5de5\u4f5c\u533a\u6587\u4ef6\uff1b\u5982\u679c\u6587\u4ef6\u5df2\u5b58\u5728\u5219\u5931\u8d25\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' },
						content: { type: 'string', description: '\u521d\u59cb\u6587\u4ef6\u5185\u5bb9\u3002' }
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'replace_in_file',
				description: '\u5728\u5de5\u4f5c\u533a\u6587\u4ef6\u4e2d\u66ff\u6362\u7cbe\u786e\u6587\u672c\u3002',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '\u5de5\u4f5c\u533a\u76f8\u5bf9\u6587\u4ef6\u8def\u5f84\u3002' },
						search: { type: 'string', description: '\u8981\u66ff\u6362\u7684\u7cbe\u786e\u6587\u672c\u3002' },
						replace: { type: 'string', description: '\u66ff\u6362\u540e\u7684\u6587\u672c\u3002' },
						all: { type: 'boolean', description: '\u662f\u5426\u66ff\u6362\u5168\u90e8\u5339\u914d\uff0c\u800c\u4e0d\u662f\u4ec5\u66ff\u6362\u7b2c\u4e00\u4e2a\u3002' }
					},
					required: ['path', 'search', 'replace']
				}
			},
			{
				name: 'run_command',
				description: '\u5728\u96c6\u6210\u7ec8\u7aef\u4e2d\u8fd0\u884c\u53ea\u8bfb\u7684 shell \u547d\u4ee4\uff0c\u5e76\u8fd4\u56de\u8f93\u51fa\u6458\u8981\u3002\u4e0d\u5141\u8bb8\u4efb\u4f55\u4f1a\u4fee\u6539\u6587\u4ef6\u6216\u5de5\u4f5c\u533a\u72b6\u6001\u7684\u547d\u4ee4\u3002',
				input_schema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: '\u8981\u8fd0\u884c\u7684\u4e00\u6761\u53ea\u8bfb\u547d\u4ee4\uff0c\u4e0d\u80fd\u5305\u542b\u7ba1\u9053\u3001\u94fe\u5f0f\u6267\u884c\u3001\u91cd\u5b9a\u5411\u3001\u5b50 shell \u6216\u4efb\u4f55\u5199\u5165\u64cd\u4f5c\u3002' },
						cwd: { type: 'string', description: '\u53ef\u9009\u7684\u5de5\u4f5c\u533a\u76f8\u5bf9\u5de5\u4f5c\u76ee\u5f55\u3002' }
					},
					required: ['command']
				}
			}
		];
	}

	async invoke(toolName: string, input: unknown): Promise<IBeamToolCallResult> {
		this.log(vscode.l10n.t('\u6b63\u5728\u8c03\u7528\u5de5\u5177 {0}\u3002', toolName));
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
				throw new Error(vscode.l10n.t('\u672a\u77e5\u5de5\u5177\uff1a{0}', toolName));
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
			.map(([name, type]) => `${type === vscode.FileType.Directory ? '\u76ee\u5f55' : '\u6587\u4ef6'} ${name}`)
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

		return results.length ? results.join('\n') : vscode.l10n.t('\u6ca1\u6709\u627e\u5230\u5339\u914d\u7ed3\u679c\u3002');
	}

	private async getDiagnostics(pathInput?: string): Promise<string> {
		let targetUri: vscode.Uri | undefined;
		if (pathInput) {
			targetUri = this.resolveWorkspacePath(pathInput);
		} else {
			targetUri = getPreferredCodeEditor()?.document.uri;
		}

		if (!targetUri) {
			return vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002');
		}

		const diagnostics = vscode.languages.getDiagnostics(targetUri);
		if (!diagnostics.length) {
			return vscode.l10n.t('\u6ca1\u6709\u8bca\u65ad\u4fe1\u606f\u3002');
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
		return vscode.l10n.t('\u5df2\u6253\u5f00 {0}\uff0c\u5b9a\u4f4d\u5230\u7b2c {1} \u884c\u3001\u7b2c {2} \u5217\u3002', getEditorLabel(uri), line, column);
	}

	private async selectEditorRange(input: Record<string, unknown>): Promise<string> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002');
		}

		const range = this.createRange(input);
		setEditorRangeSelection(editor, range);
		return vscode.l10n.t('\u5df2\u9009\u4e2d {0}\u3002', formatRange(range));
	}

	private async selectCurrentFunction(): Promise<string> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentFunction(editor);
		if (!range) {
			return vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u51fd\u6570\u6216\u65b9\u6cd5\u3002');
		}

		return vscode.l10n.t('\u5df2\u9009\u4e2d\u5f53\u524d\u51fd\u6570\uff1a{0}\u3002', formatRange(range));
	}

	private async selectCurrentBlock(): Promise<string> {
		const editor = getPreferredCodeEditor();
		const range = await selectCurrentBlock(editor);
		if (!range) {
			return vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u53ef\u8bc6\u522b\u7684\u4ee3\u7801\u5757\u3002');
		}

		return vscode.l10n.t('\u5df2\u5c06\u9009\u533a\u6269\u5c55\u5230 {0}\u3002', formatRange(range));
	}

	private async revealRange(input: Record<string, unknown>): Promise<string> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u7684\u4ee3\u7801\u7f16\u8f91\u5668\u3002');
		}

		const range = this.createRange(input);
		revealEditorRange(editor, range);
		return vscode.l10n.t('\u5df2\u5b9a\u4f4d\u5230 {0}\u3002', formatRange(range));
	}

	private async createEditProposal(input: Record<string, unknown>): Promise<string> {
		const code = asString(input.code, 'code');
		const mode = asString(input.mode, 'mode');
		if (mode !== 'insert' && mode !== 'replace') {
			throw new Error(vscode.l10n.t('mode \u5fc5\u987b\u662f insert \u6216 replace\u3002'));
		}

		await this.proposalService.createProposalFromCodeBlock(code, mode);
		return vscode.l10n.t('\u5df2\u521b\u5efa {0} \u63d0\u8bae\u3002', mode);
	}

	private async writeFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		await this.proposalService.createFileProposal(uri, content, 'file');
		return vscode.l10n.t('\u5df2\u4e3a {1} \u751f\u6210 {0} \u4e2a\u5b57\u7b26\u7684\u6587\u4ef6\u66f4\u6539\u63d0\u8bae\u3002', content.length, getEditorLabel(uri));
	}

	private async createFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const content = asStringAllowEmpty(input.content, 'content');
		await this.proposalService.createFileProposal(uri, content, 'file');
		return vscode.l10n.t('\u5df2\u4e3a {0} \u751f\u6210\u65b0\u6587\u4ef6\u63d0\u8bae\u3002', getEditorLabel(uri));
	}

	private async replaceInFile(input: Record<string, unknown>): Promise<string> {
		const uri = this.resolveWorkspacePath(input.path);
		const search = asString(input.search, 'search');
		const replace = asStringAllowEmpty(input.replace, 'replace');
		const replaceAll = Boolean(input.all);
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.getText();

		if (!text.includes(search)) {
			throw new Error(vscode.l10n.t('\u5728 {0} \u4e2d\u6ca1\u6709\u627e\u5230\u8981\u66ff\u6362\u7684\u6587\u672c\u3002', getEditorLabel(uri)));
		}

		const nextText = replaceAll ? text.split(search).join(replace) : text.replace(search, replace);
		await this.proposalService.createFileProposal(uri, nextText, 'file');

		const count = replaceAll ? Math.max(0, text.split(search).length - 1) : 1;
		return vscode.l10n.t('\u5df2\u4e3a {1} \u751f\u6210 {0} \u5904\u66ff\u6362\u7684\u63d0\u8bae\u3002', count, getEditorLabel(uri));
	}

	private async runCommand(input: Record<string, unknown>): Promise<string> {
		const commandLine = asString(input.command, 'command').trim();
		if (!isSafeCommand(commandLine)) {
			throw new Error(vscode.l10n.t('\u547d\u4ee4\u5305\u542b\u4e0d\u652f\u6301\u7684 shell \u63a7\u5236\u5b57\u7b26\u3002\u53ea\u80fd\u8fd0\u884c\u5355\u6761\u53ea\u8bfb\u547d\u4ee4\u3002'));
		}

		if (!isReadOnlyCommand(commandLine)) {
			throw new Error(vscode.l10n.t('\u53ea\u5141\u8bb8\u8fd0\u884c\u8bfb\u53d6\u3001\u641c\u7d22\u6216 git \u67e5\u770b\u7c7b\u547d\u4ee4\u3002\u4efb\u4f55\u4f1a\u4fee\u6539\u6587\u4ef6\u7684\u64cd\u4f5c\u90fd\u5fc5\u987b\u901a\u8fc7 Beam \u7684\u7f16\u8f91\u63d0\u8bae\u6d41\u7a0b\u3002'));
		}

		const cwdUri = this.resolveWorkspaceFolderCwd(asOptionalString(input.cwd));
		const terminal = await this.getOrCreateTerminal(cwdUri);
		terminal.show(false);

		const shellIntegration = await this.waitForShellIntegration(terminal);
		if (!shellIntegration) {
			terminal.sendText(commandLine, true);
			return vscode.l10n.t('\u5df2\u5c06\u547d\u4ee4\u53d1\u9001\u5230\u7ec8\u7aef\uff0c\u4f46\u5f53\u524d\u6ca1\u6709 shell integration\uff1a{0}', commandLine);
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
		const header = cwdUri ? `\u76ee\u5f55\uff1a${getEditorLabel(cwdUri)}` : '\u76ee\u5f55\uff1a\u5de5\u4f5c\u533a\u6839\u76ee\u5f55';
		const codeLabel = exitCode === undefined ? '\u9000\u51fa\u7801\uff1a\u672a\u77e5' : `\u9000\u51fa\u7801\uff1a${exitCode}`;
		return [header, codeLabel, `\u547d\u4ee4\uff1a${commandLine}`, output].filter(Boolean).join('\n');
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
			throw new Error(vscode.l10n.t('\u5f53\u524d\u6ca1\u6709\u6253\u5f00\u7684\u5de5\u4f5c\u533a\u6587\u4ef6\u5939\u3002'));
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
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(vscode.l10n.t('{0} \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32\u3002', name));
	}

	return value;
}

function asStringAllowEmpty(value: unknown, name: string): string {
	if (typeof value !== 'string') {
		throw new Error(vscode.l10n.t('{0} \u5fc5\u987b\u662f\u5b57\u7b26\u4e32\u3002', name));
	}

	return value;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(vscode.l10n.t('{0} \u5fc5\u987b\u662f\u6570\u5b57\u3002', name));
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

	return `${value.slice(0, Math.max(0, maxLength - 12))}\n...[\u5df2\u622a\u65ad]`;
}

function formatSeverity(severity: vscode.DiagnosticSeverity): string {
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

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
