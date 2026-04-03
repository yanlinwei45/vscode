/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface IPendingFileChange {
	readonly id: string;
	readonly uri: vscode.Uri;
	readonly label: string;
	readonly mode?: 'replace' | 'insert' | 'file';
	readonly status: 'pending' | 'accepted' | 'rejected';
	readonly isActive?: boolean;
}

export class PendingChangesTreeProvider implements vscode.TreeDataProvider<IPendingFileChange> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<IPendingFileChange | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private changes: IPendingFileChange[] = [];

	setChanges(changes: readonly IPendingFileChange[]): void {
		this.changes = [...changes];
		this._onDidChangeTreeData.fire();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: IPendingFileChange): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.command = {
			command: 'beam.openPendingChange',
			title: vscode.l10n.t('\u6253\u5f00\u5f85\u5904\u7406\u66f4\u6539'),
			arguments: [element.id]
		};
		item.contextValue = 'pendingChange';
		item.resourceUri = element.uri;
		const modeLabel = element.mode === 'insert'
			? vscode.l10n.t('\u63d2\u5165')
			: element.mode === 'replace'
				? vscode.l10n.t('\u66ff\u6362')
				: vscode.l10n.t('\u6587\u4ef6');
		item.description = element.isActive
			? vscode.l10n.t('\u5f53\u524d · {0}', modeLabel)
			: `${modeLabel}`;
		return item;
	}

	getChildren(element?: IPendingFileChange): IPendingFileChange[] {
		if (element) {
			return [];
		}

		return this.changes;
	}
}
