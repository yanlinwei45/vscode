/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ICodexTomlConfiguration {
	readonly model?: string;
	readonly baseUrl?: string;
	readonly modelMigrations: ReadonlyMap<string, string>;
}

export interface ICodexAuthConfiguration {
	readonly apiKey?: string;
}

export interface ICodexOpenAIConfiguration extends ICodexTomlConfiguration, ICodexAuthConfiguration { }

export function readCodexOpenAIConfiguration(homeDir: string = os.homedir()): ICodexOpenAIConfiguration {
	const codexDirectory = path.join(homeDir, '.codex');
	const config = parseCodexTomlConfiguration(readFileIfExists(path.join(codexDirectory, 'config.toml')) || '');
	const auth = parseCodexAuthConfiguration(readFileIfExists(path.join(codexDirectory, 'auth.json')) || '');
	return {
		apiKey: auth.apiKey,
		baseUrl: config.baseUrl,
		model: config.model,
		modelMigrations: config.modelMigrations
	};
}

export function parseCodexTomlConfiguration(contents: string): ICodexTomlConfiguration {
	let currentSection = '';
	let model: string | undefined;
	let baseUrl: string | undefined;
	const modelMigrations = new Map<string, string>();

	for (const rawLine of contents.split(/\r?\n/g)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const sectionMatch = line.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			currentSection = sectionMatch[1];
			continue;
		}

		const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
		if (!entryMatch) {
			continue;
		}

		const [, key, rawValue] = entryMatch;
		const value = parseTomlStringValue(rawValue);
		if (!value) {
			continue;
		}

		if (!currentSection && key === 'model') {
			model = value;
			continue;
		}

		if (currentSection === 'model_providers.codex' && key === 'base_url') {
			baseUrl = value;
			continue;
		}

		if (currentSection === 'notice.model_migrations') {
			modelMigrations.set(key, value);
		}
	}

	return {
		model,
		baseUrl,
		modelMigrations
	};
}

export function parseCodexAuthConfiguration(contents: string): ICodexAuthConfiguration {
	if (!contents.trim()) {
		return {};
	}

	try {
		const value = JSON.parse(contents) as { OPENAI_API_KEY?: unknown };
		return {
			apiKey: typeof value.OPENAI_API_KEY === 'string' ? value.OPENAI_API_KEY.trim() || undefined : undefined
		};
	} catch {
		return {};
	}
}

function readFileIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}

		return undefined;
	}
}

function parseTomlStringValue(rawValue: string): string | undefined {
	const match = rawValue.match(/^"((?:[^"\\]|\\.)*)"/);
	if (!match) {
		return undefined;
	}

	try {
		return JSON.parse(match[0]) as string;
	} catch {
		return undefined;
	}
}
