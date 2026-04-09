/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BeamService } from './beamService';

const MAX_PREFIX_CHARS = 3000;
const MAX_SUFFIX_CHARS = 1800;
const MAX_PROMPT_CHARS = 7000;
const MAX_COMPLETION_CHARS = 1200;
const CACHE_TTL_MS = 20000;

interface ICachedInlineCompletion {
	readonly createdAt: number;
	readonly insertText: string;
	readonly range: vscode.Range;
}

export class BeamInlineCompletionProvider implements vscode.InlineCompletionItemProvider {

	private readonly cache = new Map<string, ICachedInlineCompletion>();

	constructor(private readonly beamService: BeamService) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
		if (!vscode.workspace.getConfiguration('beam').get<boolean>('inlineCompletions.enabled', true)) {
			return undefined;
		}

		if (!shouldProvideInlineCompletion(document, position, context)) {
			return undefined;
		}

		const replaceRange = resolveReplaceRange(document, position, context);
		const cacheKey = createCacheKey(document, position, replaceRange);
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
			return [new vscode.InlineCompletionItem(cached.insertText, cached.range)];
		}

		const prompt = buildInlineCompletionPrompt(document, position, replaceRange);
		if (!prompt) {
			return undefined;
		}

		let rawCompletion: string | undefined;
		try {
			rawCompletion = await this.beamService.requestInlineCompletion(
				prompt,
				{ silentAuth: true, maxTokens: 384 },
				token
			);
		} catch {
			return undefined;
		}
		if (!rawCompletion) {
			return undefined;
		}

		const insertText = normalizeCompletionText(document, position, replaceRange, rawCompletion);
		if (!insertText) {
			return undefined;
		}

		const completion = {
			createdAt: Date.now(),
			insertText,
			range: replaceRange
		};
		this.cache.set(cacheKey, completion);
		pruneCache(this.cache);

		return [new vscode.InlineCompletionItem(insertText, replaceRange)];
	}
}

function shouldProvideInlineCompletion(
	document: vscode.TextDocument,
	position: vscode.Position,
	context: vscode.InlineCompletionContext
): boolean {
	if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
		return false;
	}

	if (context.selectedCompletionInfo) {
		return false;
	}

	const line = document.lineAt(position.line).text;
	const before = line.slice(0, position.character);
	const documentPrefix = document.getText(new vscode.Range(0, 0, position.line, position.character));
	if (!before.trim() && !documentPrefix.trim()) {
		return false;
	}

	const after = line.slice(position.character);
	const indentationOnlyLine = /^\s*$/.test(before) && /^\s*$/.test(after);
	if (indentationOnlyLine && !documentPrefix.trim()) {
		return false;
	}

	if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
		if (indentationOnlyLine) {
			return true;
		}

		const lastChar = before[before.length - 1];
		if (!lastChar || !/[\w)\]}'"`.>:,/]/.test(lastChar)) {
			return false;
		}
	}

	return true;
}

function resolveReplaceRange(
	document: vscode.TextDocument,
	position: vscode.Position,
	context: vscode.InlineCompletionContext
): vscode.Range {
	if (context.selectedCompletionInfo) {
		return context.selectedCompletionInfo.range;
	}

	const line = document.lineAt(position.line).text;
	let endCharacter = position.character;
	while (endCharacter < line.length) {
		const char = line[endCharacter];
		if (!/[\w$]/.test(char)) {
			break;
		}

		endCharacter++;
	}

	return new vscode.Range(position.line, position.character, position.line, endCharacter);
}

function buildInlineCompletionPrompt(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range
): string {
	const fullText = document.getText();
	const offset = document.offsetAt(position);
	const prefix = trimStartBoundary(fullText.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset), MAX_PREFIX_CHARS);
	const suffix = trimEndBoundary(fullText.slice(offset, Math.min(fullText.length, offset + MAX_SUFFIX_CHARS)), MAX_SUFFIX_CHARS);
	const selectedText = document.getText(range);

	const sections = [
		`语言: ${document.languageId || 'plaintext'}`,
		`文件: ${document.uri.fsPath || document.uri.toString()}`,
		`光标: 第 ${position.line + 1} 行，第 ${position.character + 1} 列`,
		'要求: 只补全光标处接下来的代码，不能重复 prefix 中已经存在的内容。',
		`待替换文本:\n${selectedText || '<EMPTY>'}`,
		`Prefix:\n${prefix || '<EMPTY>'}`,
		`Suffix:\n${suffix || '<EMPTY>'}`
	];

	const prompt = sections.join('\n\n');
	return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(prompt.length - MAX_PROMPT_CHARS) : prompt;
}

function normalizeCompletionText(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	rawCompletion: string
): string {
	const normalizedLineEndings = rawCompletion.replace(/\r\n/g, '\n');
	const currentLinePrefix = document.lineAt(position.line).text.slice(0, position.character);
	let completion = stripPrefixOverlap(normalizedLineEndings, currentLinePrefix);

	const replacingText = document.getText(range);
	if (replacingText && completion.startsWith(replacingText)) {
		completion = completion.slice(replacingText.length);
	}

	completion = completion.replace(/\s+$/u, match => match.includes('\n') ? '\n' : match);
	completion = completion.slice(0, MAX_COMPLETION_CHARS);

	if (!completion.trim() && !completion.includes('\n')) {
		return '';
	}

	return completion;
}

function stripPrefixOverlap(completion: string, existingPrefix: string): string {
	const maxOverlap = Math.min(completion.length, existingPrefix.length);
	for (let size = maxOverlap; size > 0; size--) {
		if (existingPrefix.endsWith(completion.slice(0, size))) {
			return completion.slice(size);
		}
	}

	return completion;
}

function trimStartBoundary(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	return value.slice(value.length - maxChars);
}

function trimEndBoundary(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	return value.slice(0, maxChars);
}

function createCacheKey(document: vscode.TextDocument, position: vscode.Position, range: vscode.Range): string {
	return [
		document.uri.toString(),
		document.version,
		position.line,
		position.character,
		range.start.character,
		range.end.character
	].join(':');
}

function pruneCache(cache: Map<string, ICachedInlineCompletion>): void {
	const now = Date.now();
	for (const [key, value] of cache) {
		if (now - value.createdAt >= CACHE_TTL_MS) {
			cache.delete(key);
		}
	}
}
