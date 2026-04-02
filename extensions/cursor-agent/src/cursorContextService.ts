/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getEditorLabel, getEditorSelectionSnapshot, getPreferredCodeEditor } from './editorContext';

const RECENT_FILES_KEY = 'cursorAgent.recentFiles.v1';
const FAILED_TERMINALS_KEY = 'cursorAgent.failedTerminalCommands.v1';
const MAX_RECENT_FILES = 8;
const MAX_FAILED_COMMANDS = 4;
const MAX_FAILURE_OUTPUT = 1200;
const MAX_SELECTION_CONTEXT = 3000;
const MAX_DIAGNOSTICS = 8;
const MAX_TREE_ENTRIES_PER_DIR = 10;
const MAX_TREE_DEPTH = 2;
const MAX_TREE_TOTAL_LINES = 40;

interface IFailedTerminalCommand {
	readonly commandLine: string;
	readonly terminalName: string;
	readonly cwd?: string;
	readonly exitCode?: number;
	readonly output: string;
	readonly timestamp: number;
}

interface ITerminalCapture {
	readonly commandLine: string;
	readonly terminalName: string;
	readonly cwd?: string;
	output: string;
}

export interface ICursorContextState {
	readonly summary: readonly string[];
	readonly selection?: {
		readonly fileLabel: string;
		readonly language: string;
		readonly lines: string;
		readonly characterCount: number;
		readonly preview: string;
	};
}

export class CursorContextService implements vscode.Disposable {

	private readonly _onDidChangeState = new vscode.EventEmitter<ICursorContextState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly terminalCaptures = new Map<vscode.TerminalShellExecution, ITerminalCapture>();
	private recentFiles: string[];
	private failedTerminalCommands: IFailedTerminalCommand[];

	constructor(
		private readonly storage: vscode.Memento,
		private readonly outputChannel: vscode.OutputChannel
	) {
		this.recentFiles = this.restoreRecentFiles();
		this.failedTerminalCommands = this.restoreFailedTerminalCommands();
		this.trackEditor(vscode.window.activeTextEditor);

		this.disposables.push(this._onDidChangeState);
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			this.trackEditor(editor);
			this.fireState();
		}));
		this.disposables.push(vscode.window.onDidChangeTextEditorSelection(() => {
			this.fireState();
		}));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
			const activeEditor = getPreferredCodeEditor();
			if (activeEditor && event.document.uri.toString() === activeEditor.document.uri.toString()) {
				this.fireState();
			}
		}));
		this.disposables.push(vscode.languages.onDidChangeDiagnostics(() => this.fireState()));
		this.disposables.push(vscode.window.onDidStartTerminalShellExecution(event => this.captureTerminalExecution(event)));
		this.disposables.push(vscode.window.onDidEndTerminalShellExecution(event => this.finalizeTerminalExecution(event)));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	getState(): ICursorContextState {
		const summary: string[] = [];
		const activeEditor = getPreferredCodeEditor();
		const selection = getEditorSelectionSnapshot(activeEditor);
		if (activeEditor) {
			summary.push(vscode.l10n.t('File: {0}', getEditorLabel(activeEditor.document.uri)));
		}

		if (this.recentFiles.length) {
			summary.push(vscode.l10n.t('Recent: {0}', this.recentFiles.length));
		}

		const diagnostics = this.getDiagnosticTotals();
		if (diagnostics.errors || diagnostics.warnings) {
			summary.push(vscode.l10n.t('Problems: {0}E {1}W', diagnostics.errors, diagnostics.warnings));
		}

		if (this.failedTerminalCommands.length) {
			summary.push(vscode.l10n.t('Terminal Failures: {0}', this.failedTerminalCommands.length));
		}

		return {
			summary,
			selection: selection ? {
				fileLabel: selection.fileLabel,
				language: selection.language,
				lines: `${selection.startLine}-${selection.endLine}`,
				characterCount: selection.characterCount,
				preview: selection.preview
			} : undefined
		};
	}

	async buildPromptContext(): Promise<string> {
		const sections: string[] = [];
		const activeEditorSection = this.buildActiveEditorSection();
		if (activeEditorSection) {
			sections.push(activeEditorSection);
		}

		const workspaceTreeSection = await this.buildWorkspaceTreeSection();
		if (workspaceTreeSection) {
			sections.push(workspaceTreeSection);
		}

		const recentFilesSection = this.buildRecentFilesSection();
		if (recentFilesSection) {
			sections.push(recentFilesSection);
		}

		const diagnosticsSection = this.buildDiagnosticsSection();
		if (diagnosticsSection) {
			sections.push(diagnosticsSection);
		}

		const terminalSection = this.buildTerminalFailuresSection();
		if (terminalSection) {
			sections.push(terminalSection);
		}

		return sections.join('\n\n');
	}

	private trackEditor(editor: vscode.TextEditor | undefined): void {
		const documentUri = editor?.document.uri;
		if (!documentUri || documentUri.scheme !== 'file') {
			return;
		}

		const formatted = this.formatUri(documentUri);
		this.recentFiles = [formatted, ...this.recentFiles.filter(value => value !== formatted)].slice(0, MAX_RECENT_FILES);
		void this.storage.update(RECENT_FILES_KEY, this.recentFiles);
	}

	private captureTerminalExecution(event: vscode.TerminalShellExecutionStartEvent): void {
		const commandLine = event.execution.commandLine.value.trim();
		if (!commandLine) {
			return;
		}

		const capture: ITerminalCapture = {
			commandLine,
			terminalName: event.terminal.name,
			cwd: this.formatUri(event.execution.cwd ?? event.shellIntegration.cwd),
			output: ''
		};
		this.terminalCaptures.set(event.execution, capture);
		void this.readTerminalExecution(event.execution, capture);
	}

	private async readTerminalExecution(execution: vscode.TerminalShellExecution, capture: ITerminalCapture): Promise<void> {
		try {
			for await (const chunk of execution.read()) {
				capture.output = truncateText(`${capture.output}${chunk}`, MAX_FAILURE_OUTPUT);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(vscode.l10n.t('Failed to read terminal execution output: {0}', message));
		}
	}

	private finalizeTerminalExecution(event: vscode.TerminalShellExecutionEndEvent): void {
		const capture = this.terminalCaptures.get(event.execution);
		this.terminalCaptures.delete(event.execution);

		if (event.exitCode === 0) {
			return;
		}

		const commandLine = event.execution.commandLine.value.trim();
		if (!commandLine) {
			return;
		}

		const failure: IFailedTerminalCommand = {
			commandLine,
			terminalName: capture?.terminalName ?? event.terminal.name,
			cwd: capture?.cwd ?? this.formatUri(event.execution.cwd ?? event.shellIntegration.cwd),
			exitCode: event.exitCode,
			output: normalizeTerminalOutput(capture?.output ?? ''),
			timestamp: Date.now()
		};

		this.failedTerminalCommands = [failure, ...this.failedTerminalCommands].slice(0, MAX_FAILED_COMMANDS);
		void this.storage.update(FAILED_TERMINALS_KEY, this.failedTerminalCommands);
		this.log(vscode.l10n.t('Captured failed terminal command: {0}', commandLine));
		this.fireState();
	}

	private buildActiveEditorSection(): string | undefined {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return undefined;
		}

		const lines: string[] = [
			'Active editor:',
			`- File: ${this.formatUri(editor.document.uri)}`,
			`- Language: ${editor.document.languageId || 'plaintext'}`
		];

		if (!editor.selection.isEmpty) {
			const selectedText = truncateText(editor.document.getText(editor.selection), MAX_SELECTION_CONTEXT);
			lines.push(`- Selection: lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`);
			lines.push('```');
			lines.push(selectedText);
			lines.push('```');
		}

		return lines.join('\n');
	}

	private async buildWorkspaceTreeSection(): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders?.length) {
			return undefined;
		}

		const lines = ['Workspace tree:'];
		const budget = { lines: 0 };

		for (const folder of workspaceFolders.slice(0, 2)) {
			if (budget.lines >= MAX_TREE_TOTAL_LINES) {
				break;
			}

			lines.push(`${folder.name}/`);
			budget.lines++;
			await this.appendDirectoryLines(folder.uri, '  ', 0, lines, budget);
		}

		return lines.join('\n');
	}

	private async appendDirectoryLines(
		directory: vscode.Uri,
		indent: string,
		depth: number,
		lines: string[],
		budget: { lines: number }
	): Promise<void> {
		if (depth >= MAX_TREE_DEPTH || budget.lines >= MAX_TREE_TOTAL_LINES) {
			return;
		}

		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(directory);
		} catch {
			return;
		}

		const filtered = entries
			.filter(([name]) => !shouldIgnoreDirectoryEntry(name))
			.sort((a, b) => compareDirectoryEntries(a, b))
			.slice(0, MAX_TREE_ENTRIES_PER_DIR);

		for (const [name, type] of filtered) {
			if (budget.lines >= MAX_TREE_TOTAL_LINES) {
				return;
			}

			const isDirectory = type === vscode.FileType.Directory;
			lines.push(`${indent}${name}${isDirectory ? '/' : ''}`);
			budget.lines++;

			if (isDirectory) {
				await this.appendDirectoryLines(vscode.Uri.joinPath(directory, name), `${indent}  `, depth + 1, lines, budget);
			}
		}
	}

	private buildRecentFilesSection(): string | undefined {
		if (!this.recentFiles.length) {
			return undefined;
		}

		return [
			'Recent files:',
			...this.recentFiles.map((file, index) => `${index + 1}. ${file}`)
		].join('\n');
	}

	private buildDiagnosticsSection(): string | undefined {
		const diagnostics = vscode.languages.getDiagnostics();
		if (!diagnostics.length) {
			return undefined;
		}

		const activeUri = getPreferredCodeEditor()?.document.uri;
		const lines = ['Diagnostics summary:'];
		const totals = this.getDiagnosticTotals();
		lines.push(`- Workspace totals: ${totals.errors} errors, ${totals.warnings} warnings`);

		const flattened = diagnostics
			.flatMap(([uri, values]) => values.map(diagnostic => ({ uri, diagnostic })))
			.filter(({ diagnostic }) => diagnostic.severity === vscode.DiagnosticSeverity.Error || diagnostic.severity === vscode.DiagnosticSeverity.Warning)
			.sort((a, b) => {
				const aIsActive = activeUri ? a.uri.toString() === activeUri.toString() : false;
				const bIsActive = activeUri ? b.uri.toString() === activeUri.toString() : false;
				if (aIsActive !== bIsActive) {
					return aIsActive ? -1 : 1;
				}
				return a.diagnostic.severity - b.diagnostic.severity;
			})
			.slice(0, MAX_DIAGNOSTICS);

		for (const { uri, diagnostic } of flattened) {
			const source = diagnostic.source ? ` (${diagnostic.source})` : '';
			lines.push(`- ${this.formatUri(uri)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${formatSeverity(diagnostic.severity)}]${source} ${diagnostic.message}`);
		}

		return lines.join('\n');
	}

	private buildTerminalFailuresSection(): string | undefined {
		if (!this.failedTerminalCommands.length) {
			return undefined;
		}

		const lines = ['Recent failed terminal commands:'];
		for (const failure of this.failedTerminalCommands) {
			const cwd = failure.cwd ? ` in ${failure.cwd}` : '';
			const exitCode = failure.exitCode === undefined ? 'unknown exit code' : `exit ${failure.exitCode}`;
			lines.push(`- ${failure.commandLine} (${exitCode})${cwd}`);
			if (failure.output) {
				lines.push('```');
				lines.push(truncateText(failure.output, 400));
				lines.push('```');
			}
		}

		return lines.join('\n');
	}

	private getDiagnosticTotals(): { readonly errors: number; readonly warnings: number } {
		let errors = 0;
		let warnings = 0;

		for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
			for (const diagnostic of diagnostics) {
				if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
					errors++;
				} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
					warnings++;
				}
			}
		}

		return { errors, warnings };
	}

	private restoreRecentFiles(): string[] {
		const stored = this.storage.get<string[]>(RECENT_FILES_KEY);
		if (!Array.isArray(stored)) {
			return [];
		}

		return stored.filter(value => typeof value === 'string').slice(0, MAX_RECENT_FILES);
	}

	private restoreFailedTerminalCommands(): IFailedTerminalCommand[] {
		const stored = this.storage.get<IFailedTerminalCommand[]>(FAILED_TERMINALS_KEY);
		if (!Array.isArray(stored)) {
			return [];
		}

		return stored.filter(isFailedTerminalCommand).slice(0, MAX_FAILED_COMMANDS);
	}

	private formatUri(uri: vscode.Uri | undefined): string {
		if (!uri) {
			return '';
		}

		return getEditorLabel(uri);
	}

	private fireState(): void {
		this._onDidChangeState.fire(this.getState());
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function shouldIgnoreDirectoryEntry(name: string): boolean {
	return ['.git', 'node_modules', '.next', 'out', 'dist', 'build', 'coverage'].includes(name);
}

function compareDirectoryEntries(a: [string, vscode.FileType], b: [string, vscode.FileType]): number {
	const aIsDirectory = a[1] === vscode.FileType.Directory;
	const bIsDirectory = b[1] === vscode.FileType.Directory;
	if (aIsDirectory !== bIsDirectory) {
		return aIsDirectory ? -1 : 1;
	}

	return a[0].localeCompare(b[0]);
}

function normalizeTerminalOutput(value: string): string {
	return truncateText(value.replace(/\x1b\[[0-9;]*m/g, '').trim(), MAX_FAILURE_OUTPUT);
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

function isFailedTerminalCommand(value: IFailedTerminalCommand | undefined): value is IFailedTerminalCommand {
	return Boolean(
		value &&
		typeof value.commandLine === 'string' &&
		typeof value.terminalName === 'string' &&
		typeof value.output === 'string' &&
		typeof value.timestamp === 'number' &&
		(typeof value.cwd === 'undefined' || typeof value.cwd === 'string') &&
		(typeof value.exitCode === 'undefined' || typeof value.exitCode === 'number')
	);
}
