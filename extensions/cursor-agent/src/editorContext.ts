/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

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
