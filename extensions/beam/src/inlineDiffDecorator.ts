/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface IDiffRange {
	readonly firstChangeLine: number;
	readonly hasChanges: boolean;
}

export class InlineDiffDecorator {
	private insertDecorationType: vscode.TextEditorDecorationType;
	private deleteDecorationType: vscode.TextEditorDecorationType;
	private modifyDecorationType: vscode.TextEditorDecorationType;
	private lastDiffRange: IDiffRange | undefined;

	constructor() {
		this.insertDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			isWholeLine: true,
			gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNOCAzVjEzTTMgOEgxMyIgc3Ryb2tlPSIjNTg5NjM2IiBzdHJva2Utd2lkdGg9IjIiLz48L3N2Zz4='),
			gutterIconSize: 'contain'
		});

		this.deleteDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
			isWholeLine: true,
			textDecoration: 'line-through',
			opacity: '0.6',
			gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMyA4SDEzIiBzdHJva2U9IiNjYzY2NjYiIHN0cm9rZS13aWR0aD0iMiIvPjwvc3ZnPg=='),
			gutterIconSize: 'contain'
		});

		this.modifyDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			isWholeLine: true,
			gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSI4IiBjeT0iOCIgcj0iMyIgZmlsbD0iI2NjYTcwMCIvPjwvc3ZnPg=='),
			gutterIconSize: 'contain'
		});
	}

	showInlineDiff(editor: vscode.TextEditor, originalText: string, proposedText: string): IDiffRange {
		const originalLines = originalText.split('\n');
		const proposedLines = proposedText.split('\n');

		const insertDecorations: vscode.DecorationOptions[] = [];
		const deleteDecorations: vscode.DecorationOptions[] = [];
		const modifyDecorations: vscode.DecorationOptions[] = [];

		let firstChangeLine = -1;

		// Simple line-by-line diff
		const maxLines = Math.max(originalLines.length, proposedLines.length);
		for (let i = 0; i < maxLines; i++) {
			const originalLine = originalLines[i];
			const proposedLine = proposedLines[i];

			if (originalLine === undefined && proposedLine !== undefined) {
				// Insert
				if (firstChangeLine === -1) {
					firstChangeLine = i;
				}
				const range = new vscode.Range(i, 0, i, proposedLine.length);
				insertDecorations.push({ range });
			} else if (originalLine !== undefined && proposedLine === undefined) {
				// Delete
				if (firstChangeLine === -1) {
					firstChangeLine = i;
				}
				const range = new vscode.Range(i, 0, i, originalLine.length);
				deleteDecorations.push({ range });
			} else if (originalLine !== proposedLine) {
				// Modify
				if (firstChangeLine === -1) {
					firstChangeLine = i;
				}
				const range = new vscode.Range(i, 0, i, Math.max(originalLine?.length || 0, proposedLine?.length || 0));
				modifyDecorations.push({ range });
			}
		}

		editor.setDecorations(this.insertDecorationType, insertDecorations);
		editor.setDecorations(this.deleteDecorationType, deleteDecorations);
		editor.setDecorations(this.modifyDecorationType, modifyDecorations);

		this.lastDiffRange = {
			firstChangeLine: firstChangeLine >= 0 ? firstChangeLine : 0,
			hasChanges: firstChangeLine >= 0
		};

		return this.lastDiffRange;
	}

	getLastDiffRange(): IDiffRange | undefined {
		return this.lastDiffRange;
	}

	clearDecorations(editor: vscode.TextEditor): void {
		editor.setDecorations(this.insertDecorationType, []);
		editor.setDecorations(this.deleteDecorationType, []);
		editor.setDecorations(this.modifyDecorationType, []);
		this.lastDiffRange = undefined;
	}

	dispose(): void {
		this.insertDecorationType.dispose();
		this.deleteDecorationType.dispose();
		this.modifyDecorationType.dispose();
	}
}
