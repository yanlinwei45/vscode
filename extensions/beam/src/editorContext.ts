/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const MAX_SELECTION_PREVIEW = 320;
const DEFAULT_SELECTION_CONTEXT_LINE_COUNT = 2;

export interface IEditorSelectionSnapshot {
	readonly fileLabel: string;
	readonly language: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly characterCount: number;
	readonly selectedText: string;
	readonly preview: string;
	readonly rangeLabel: string;
	readonly contextBefore: string;
	readonly contextAfter: string;
}

export function getPreferredCodeEditor(): vscode.TextEditor | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (isUsableCodeEditor(activeEditor)) {
		return activeEditor;
	}

	return vscode.window.visibleTextEditors.find(editor => isUsableCodeEditor(editor));
}

function isUsableCodeEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
	if (!editor) {
		return false;
	}

	const { document } = editor;
	if (document.isClosed) {
		return false;
	}

	return document.uri.scheme === 'file' || document.uri.scheme === 'untitled';
}

export function getEditorSelectionSnapshot(
	editor: vscode.TextEditor | undefined,
	maxPreviewLength: number = MAX_SELECTION_PREVIEW,
	contextLineCount: number = DEFAULT_SELECTION_CONTEXT_LINE_COUNT
): IEditorSelectionSnapshot | undefined {
	if (!editor || editor.selection.isEmpty) {
		return undefined;
	}

	const document = editor.document;
	const range = new vscode.Range(editor.selection.start, editor.selection.end);
	const text = document.getText(range);
	const contextBeforeStartLine = Math.max(0, range.start.line - contextLineCount);
	const contextAfterEndLine = Math.min(document.lineCount - 1, range.end.line + contextLineCount);
	const contextBeforeRange = new vscode.Range(
		new vscode.Position(contextBeforeStartLine, 0),
		range.start
	);
	const contextAfterRange = new vscode.Range(
		range.end,
		document.lineAt(contextAfterEndLine).range.end
	);

	return {
		fileLabel: getEditorLabel(document.uri),
		language: document.languageId || 'plaintext',
		startLine: range.start.line + 1,
		endLine: range.end.line + 1,
		characterCount: text.length,
		selectedText: text,
		preview: truncateText(text.trim(), maxPreviewLength),
		rangeLabel: formatRangeLabel(range),
		contextBefore: document.getText(contextBeforeRange).trimEnd(),
		contextAfter: document.getText(contextAfterRange).trimStart()
	};
}

export function getEditorLabel(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri, false) || uri.fsPath || uri.toString();
}

export function revealEditorRange(editor: vscode.TextEditor | undefined, range?: vscode.Range): vscode.Range | undefined {
	if (!editor) {
		return undefined;
	}

	const targetRange = range ?? (editor.selection.isEmpty
		? editor.document.lineAt(editor.selection.active.line).range
		: new vscode.Range(editor.selection.start, editor.selection.end));

	editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	return targetRange;
}

export function setEditorRangeSelection(editor: vscode.TextEditor | undefined, range: vscode.Range): vscode.Range | undefined {
	if (!editor) {
		return undefined;
	}

	editor.selection = new vscode.Selection(range.start, range.end);
	revealEditorRange(editor, range);
	return range;
}

export async function selectCurrentFunction(editor: vscode.TextEditor | undefined): Promise<vscode.Range | undefined> {
	if (!editor) {
		return undefined;
	}

	const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
		'vscode.executeDocumentSymbolProvider',
		editor.document.uri
	) ?? [];
	const position = editor.selection.active;
	const candidates = flattenSymbolRanges(symbols, editor.document.uri).filter(entry => entry.range.contains(position));
	if (!candidates.length) {
		return undefined;
	}

	const functionLike = candidates
		.filter(entry => isFunctionLikeKind(entry.kind))
		.sort((a, b) => compareRangeSize(a.range, b.range))[0];
	const fallback = candidates.sort((a, b) => compareRangeSize(a.range, b.range))[0];
	return setEditorRangeSelection(editor, (functionLike ?? fallback)?.range);
}

export async function selectCurrentBlock(editor: vscode.TextEditor | undefined): Promise<vscode.Range | undefined> {
	if (!editor) {
		return undefined;
	}

	const selectionRanges = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
		'vscode.executeSelectionRangeProvider',
		editor.document.uri,
		[editor.selection.active]
	) ?? [];

	const nextRange = findNextSelectionRange(editor.selection, selectionRanges[0]);
	if (nextRange) {
		return setEditorRangeSelection(editor, nextRange);
	}

	await vscode.commands.executeCommand('editor.action.smartSelect.expand');
	return editor.selection.isEmpty ? undefined : new vscode.Range(editor.selection.start, editor.selection.end);
}

export function formatRangeLabel(range: vscode.Range): string {
	const startLine = range.start.line + 1;
	const endLine = range.end.line + 1;
	if (startLine === endLine) {
		return `L${startLine}:${range.start.character + 1}-${range.end.character + 1}`;
	}

	return `L${startLine}-${endLine}`;
}

interface ISymbolRangeEntry {
	readonly range: vscode.Range;
	readonly kind: vscode.SymbolKind;
}

function flattenSymbolRanges(
	symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
	uri: vscode.Uri,
	bucket: ISymbolRangeEntry[] = []
): ISymbolRangeEntry[] {
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			bucket.push({ range: symbol.range, kind: symbol.kind });
			flattenSymbolRanges(symbol.children, uri, bucket);
			continue;
		}

		if (symbol.location.uri.toString() === uri.toString()) {
			bucket.push({ range: symbol.location.range, kind: symbol.kind });
		}
	}

	return bucket;
}

function isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
	return 'children' in symbol && Array.isArray(symbol.children);
}

function isFunctionLikeKind(kind: vscode.SymbolKind): boolean {
	return kind === vscode.SymbolKind.Function
		|| kind === vscode.SymbolKind.Method
		|| kind === vscode.SymbolKind.Constructor;
}

function compareRangeSize(a: vscode.Range, b: vscode.Range): number {
	return rangeWeight(a) - rangeWeight(b);
}

function rangeWeight(range: vscode.Range): number {
	return ((range.end.line - range.start.line) * 100000) + (range.end.character - range.start.character);
}

function findNextSelectionRange(selection: vscode.Selection, range: vscode.SelectionRange | undefined): vscode.Range | undefined {
	const currentRange = new vscode.Range(selection.start, selection.end);
	let current = range;
	while (current) {
		if (!rangesEqual(current.range, currentRange) && containsRange(current.range, currentRange)) {
			return current.range;
		}
		current = current.parent;
	}

	return undefined;
}

function containsRange(container: vscode.Range, value: vscode.Range): boolean {
	return container.contains(value.start) && container.contains(value.end);
}

function rangesEqual(a: vscode.Range, b: vscode.Range): boolean {
	return a.start.line === b.start.line
		&& a.start.character === b.start.character
		&& a.end.line === b.end.line
		&& a.end.character === b.end.character;
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 12))}\n...[\u5df2\u622a\u65ad]`;
}
