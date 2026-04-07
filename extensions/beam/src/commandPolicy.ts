/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SAFE_COMMAND_PATTERN = /^[\w./:@%+=, -]+$/;

const READ_ONLY_COMMANDS = new Set([
	'cat',
	'file',
	'git',
	'grep',
	'head',
	'ls',
	'pwd',
	'rg',
	'stat',
	'tail',
	'wc',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	'blame',
	'diff',
	'grep',
	'log',
	'show',
	'status',
]);

export function isSafeCommand(value: string): boolean {
	return SAFE_COMMAND_PATTERN.test(value) && !/[|&;<>`$(){}[\]\\]/.test(value);
}

export function isReadOnlyCommand(value: string): boolean {
	const parts = value.split(/\s+/).filter(Boolean);
	const command = parts[0]?.toLowerCase();
	if (!command || !READ_ONLY_COMMANDS.has(command)) {
		return false;
	}

	if (command === 'git') {
		const subcommand = parts.find(part => !part.startsWith('-') && part.toLowerCase() !== 'git')?.toLowerCase();
		return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
	}

	return true;
}
