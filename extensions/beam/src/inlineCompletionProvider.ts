/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BeamService } from './beamService';

const MAX_PREFIX_CHARS = 1600;
const MAX_SUFFIX_CHARS = 900;
const MAX_NEARBY_CHARS = 2600;
const MAX_FILE_HEADER_CHARS = 900;
const MAX_PROMPT_CHARS = 7600;
const MAX_COMPLETION_CHARS = 700;
const CACHE_TTL_MS = 20000;
const FILE_HEADER_LINE_COUNT = 80;
const MAX_SCOPE_CHARS = 1600;
const MAX_SCOPE_SYMBOLS = 6;
const INLINE_COMPLETION_REQUEST_TIMEOUT_MS = 12000;
const INLINE_COMPLETION_MAX_REQUEST_ATTEMPTS = 1;
const BACKGROUND_AI_REQUEST_DELAY_MS = 320;

interface ICachedInlineCompletion {
	readonly createdAt: number;
	readonly insertText: string;
	readonly range: vscode.Range;
}

interface IPromptContext {
	readonly prefix: string;
	readonly suffix: string;
	readonly selectedText: string;
	readonly effectiveCursorOffset: number;
}

interface IContainingDocumentSymbol {
	readonly name: string;
	readonly kind: vscode.SymbolKind;
	readonly range: vscode.Range;
}

export class BeamInlineCompletionProvider implements vscode.InlineCompletionItemProvider {

	private readonly cache = new Map<string, ICachedInlineCompletion>();
	private backgroundRequestCancellation: vscode.CancellationTokenSource | undefined;
	private backgroundRequestTimer: ReturnType<typeof setTimeout> | undefined;
	private backgroundRequestSequence = 0;

	constructor(private readonly beamService: BeamService) {}

	dispose(): void {
		this.clearBackgroundRequest();
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		_token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
		if (!vscode.workspace.getConfiguration('beam').get<boolean>('inlineCompletions.enabled', true)) {
			this.beamService.logInlineCompletion('设置已关闭。');
			return undefined;
		}

		if (!shouldProvideInlineCompletion(document, position, context)) {
			return undefined;
		}

		const replaceRange = resolveReplaceRange(document, position, context);
		const cacheKey = createCacheKey(document, position, replaceRange, context);
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
			this.beamService.logInlineCompletion('命中 AI 缓存。');
			return createInlineCompletionList([createInlineCompletionItem(cached.insertText, cached.range, context)]);
		}

		this.scheduleBackgroundAICompletion(document, position, replaceRange, context, cacheKey);
		const fallbackText = createLocalFallbackCompletion(document, position);
		this.beamService.logInlineCompletion(`返回本地兜底提示：${JSON.stringify(fallbackText)}。`);
		return createInlineCompletionList([createInlineCompletionItem(fallbackText, replaceRange, context)]);
	}

	private scheduleBackgroundAICompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
		replaceRange: vscode.Range,
		context: vscode.InlineCompletionContext,
		cacheKey: string
	): void {
		const documentVersion = document.version;
		const requestSequence = ++this.backgroundRequestSequence;
		this.clearBackgroundRequest();
		this.backgroundRequestTimer = setTimeout(() => {
			this.backgroundRequestTimer = undefined;
			if (requestSequence !== this.backgroundRequestSequence || document.isClosed || document.version !== documentVersion) {
				return;
			}

			void this.requestBackgroundAICompletion(document, position, replaceRange, context, cacheKey, documentVersion, requestSequence);
		}, BACKGROUND_AI_REQUEST_DELAY_MS);
	}

	private async requestBackgroundAICompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
		replaceRange: vscode.Range,
		context: vscode.InlineCompletionContext,
		cacheKey: string,
		documentVersion: number,
		requestSequence: number
	): Promise<void> {
		this.backgroundRequestCancellation = new vscode.CancellationTokenSource();
		const token = this.backgroundRequestCancellation.token;
		const startedAt = Date.now();
		try {
			const prompt = await buildInlineCompletionPrompt(document, position, replaceRange, context);
			if (!prompt || requestSequence !== this.backgroundRequestSequence || document.version !== documentVersion) {
				return;
			}

			this.beamService.logInlineCompletion(`后台请求 AI：${document.languageId || 'plaintext'} ${position.line + 1}:${position.character + 1}。`);
			const rawCompletion = await this.beamService.requestInlineCompletion(
				prompt,
				{
					silentAuth: true,
					maxTokens: 96,
					requestTimeoutMs: INLINE_COMPLETION_REQUEST_TIMEOUT_MS,
					maxAttempts: INLINE_COMPLETION_MAX_REQUEST_ATTEMPTS
				},
				token
			);

			if (!rawCompletion || requestSequence !== this.backgroundRequestSequence || document.version !== documentVersion || token.isCancellationRequested) {
				return;
			}

			const insertText = normalizeCompletionText(document, position, replaceRange, rawCompletion, context);
			if (!insertText) {
				this.beamService.logInlineCompletion('AI 规范化后没有内容。');
				return;
			}

			this.cache.set(cacheKey, {
				createdAt: Date.now(),
				insertText,
				range: replaceRange
			});
			pruneCache(this.cache);
			this.beamService.logInlineCompletion(`AI 返回 ${insertText.length} 个字符，耗时 ${Date.now() - startedAt}ms。`);
			void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.beamService.logInlineCompletion(`后台 AI 请求失败：${message}`);
		} finally {
			if (this.backgroundRequestCancellation?.token === token) {
				this.backgroundRequestCancellation.dispose();
				this.backgroundRequestCancellation = undefined;
			}
		}
	}

	private clearBackgroundRequest(): void {
		if (this.backgroundRequestTimer) {
			clearTimeout(this.backgroundRequestTimer);
			this.backgroundRequestTimer = undefined;
		}

		if (this.backgroundRequestCancellation) {
			this.backgroundRequestCancellation.cancel();
			this.backgroundRequestCancellation.dispose();
			this.backgroundRequestCancellation = undefined;
		}
	}
}

function shouldProvideInlineCompletion(
	document: vscode.TextDocument,
	_position: vscode.Position,
	_context: vscode.InlineCompletionContext
): boolean {
	if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
		return false;
	}

	return document.getText().length > 0;
}

function createLocalFallbackCompletion(document: vscode.TextDocument, position: vscode.Position): string {
	const line = document.lineAt(position.line).text;
	const before = line.slice(0, position.character);
	const after = line.slice(position.character);
	const trimmedBefore = before.trimEnd();
	const currentWord = trimmedBefore.match(/[A-Za-z_$][\w$]*$/)?.[0] ?? '';
	const lowerWord = currentWord.toLowerCase();
	const keywordCompletion = completeCommonTypeScriptToken(lowerWord, currentWord.length);
	if (keywordCompletion) {
		return keywordCompletion;
	}

	const lastChar = trimmedBefore[trimmedBefore.length - 1];
	if (lastChar === '.') {
		return 'value';
	}

	if (lastChar === '=') {
		return ' value';
	}

	if (lastChar === '(' && !after.trim()) {
		return ')';
	}

	if (lastChar === '{' && !after.trim()) {
		return '\n\t';
	}

	if (!trimmedBefore) {
		return 'const value = ';
	}

	if (!after.trim() && /[\w)\]'"`]$/u.test(lastChar ?? '')) {
		return ';';
	}

	return '/* continue */';
}

function completeCommonTypeScriptToken(lowerWord: string, currentWordLength: number): string | undefined {
	const completions: Array<{ readonly keyword: string; readonly suffix: string }> = [
		{ keyword: 'const', suffix: ' value = ' },
		{ keyword: 'let', suffix: ' value = ' },
		{ keyword: 'var', suffix: ' value = ' },
		{ keyword: 'return', suffix: ' value;' },
		{ keyword: 'function', suffix: ' name() {\n\t\n}' },
		{ keyword: 'if', suffix: ' (condition) {\n\t\n}' },
		{ keyword: 'for', suffix: ' (const item of items) {\n\t\n}' },
		{ keyword: 'while', suffix: ' (condition) {\n\t\n}' },
		{ keyword: 'switch', suffix: ' (value) {\n\tcase value:\n\t\tbreak;\n}' },
		{ keyword: 'try', suffix: ' {\n\t\n} catch (error) {\n\t\n}' },
		{ keyword: 'class', suffix: ' Name {\n\t\n}' },
		{ keyword: 'interface', suffix: ' Name {\n\t\n}' },
		{ keyword: 'type', suffix: ' Name = ' },
		{ keyword: 'import', suffix: ' {  } from \'\';' },
		{ keyword: 'export', suffix: ' ' },
		{ keyword: 'async', suffix: ' ' },
		{ keyword: 'await', suffix: ' ' },
		{ keyword: 'console', suffix: '.log()' }
	];

	const exactCompletion = completions.find(completion => completion.keyword === lowerWord);
	if (exactCompletion) {
		return exactCompletion.suffix;
	}

	const prefixCompletion = completions.find(completion => lowerWord && completion.keyword.startsWith(lowerWord));
	if (prefixCompletion) {
		return `${prefixCompletion.keyword.slice(currentWordLength)}${prefixCompletion.suffix}`;
	}

	return undefined;
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

async function buildInlineCompletionPrompt(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	context: vscode.InlineCompletionContext
): Promise<string> {
	const promptContext = createPromptContext(document, position, range, context);
	const fileContext = createFileContext(document, position, range, promptContext);
	const scopeContext = await createScopeContext(document, position);

	const sections = [
		`任务: 在 <CURSOR> 位置续写代码，只返回插入文本。`,
		`语言: ${document.languageId || 'plaintext'}`,
		`文件: ${document.uri.fsPath || document.uri.toString()}`,
		`文件概况: 共 ${document.lineCount} 行，光标在第 ${position.line + 1} 行，第 ${position.character + 1} 列`,
		fileContext.currentLine ? `当前行:\n${fileContext.currentLine}` : undefined,
		fileContext.fileHeader ? `文件开头/导入与全局上下文:\n${fileContext.fileHeader}` : undefined,
		scopeContext.symbolTrail ? `当前作用域:\n${scopeContext.symbolTrail}` : undefined,
		scopeContext.scopeSnippet ? `当前函数/类附近实现:\n${scopeContext.scopeSnippet}` : undefined,
		`光标附近代码（<CURSOR> 为补全位置）:\n${fileContext.nearbyCode}`,
		context.selectedCompletionInfo
			? '要求: 基于当前选中的补全候选继续补全，并返回包含该候选文本在内的完整替换结果。'
			: '要求: 只补全光标处接下来的代码，不能重复 prefix 中已经存在的内容。',
		context.selectedCompletionInfo ? `当前补全候选:\n${context.selectedCompletionInfo.text}` : undefined,
		`待替换文本:\n${promptContext.selectedText || '<EMPTY>'}`,
		`精确 Prefix（光标前，不能重复）:\n${promptContext.prefix || '<EMPTY>'}`,
		`精确 Suffix（光标后，需要自然衔接）:\n${promptContext.suffix || '<EMPTY>'}`
	];

	const prompt = sections.filter((section): section is string => Boolean(section)).join('\n\n');
	return trimPromptPreservingTask(prompt, MAX_PROMPT_CHARS);
}

function normalizeCompletionText(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	rawCompletion: string,
	context: vscode.InlineCompletionContext
): string {
	const normalizedLineEndings = rawCompletion.replace(/\r\n/g, '\n');

	if (context.selectedCompletionInfo) {
		const selectedText = context.selectedCompletionInfo.text;
		const completion = finalizeCompletionText(
			`${selectedText}${stripPrefixOverlap(normalizedLineEndings, selectedText)}`,
			selectedText
		);
		return completion === selectedText ? '' : completion;
	}

	const currentLinePrefix = document.lineAt(position.line).text.slice(0, position.character);
	let completion = stripPrefixOverlap(normalizedLineEndings, currentLinePrefix);

	const replacingText = document.getText(range);
	if (replacingText && completion.startsWith(replacingText)) {
		completion = completion.slice(replacingText.length);
	}

	return finalizeCompletionText(completion);
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

function createCacheKey(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	context: vscode.InlineCompletionContext
): string {
	return [
		document.uri.toString(),
		document.version,
		position.line,
		position.character,
		range.start.character,
		range.end.character,
		context.selectedCompletionInfo?.text ?? ''
	].join(':');
}

function createInlineCompletionItem(
	insertText: string,
	range: vscode.Range,
	context: vscode.InlineCompletionContext
): vscode.InlineCompletionItem {
	const item = new vscode.InlineCompletionItem(insertText, range);
	if (context.selectedCompletionInfo) {
		item.filterText = insertText;
	}

	return item;
}

function createInlineCompletionList(items: vscode.InlineCompletionItem[]): vscode.InlineCompletionList {
	const list = new vscode.InlineCompletionList(items) as vscode.InlineCompletionList & { suppressSuggestions?: boolean };
	list.suppressSuggestions = true;
	return list;
}

function createPromptContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	context: vscode.InlineCompletionContext
): IPromptContext {
	const fullText = document.getText();
	const startOffset = document.offsetAt(range.start);
	const endOffset = document.offsetAt(range.end);
	const selectedText = context.selectedCompletionInfo?.text ?? document.getText(range);
	if (!context.selectedCompletionInfo) {
		const offset = document.offsetAt(position);
		return {
			prefix: trimStartBoundary(fullText.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset), MAX_PREFIX_CHARS),
			suffix: trimEndBoundary(fullText.slice(offset, Math.min(fullText.length, offset + MAX_SUFFIX_CHARS)), MAX_SUFFIX_CHARS),
			selectedText,
			effectiveCursorOffset: offset
		};
	}

	const syntheticText = `${fullText.slice(0, startOffset)}${selectedText}${fullText.slice(endOffset)}`;
	const syntheticOffset = startOffset + selectedText.length;
	return {
		prefix: trimStartBoundary(syntheticText.slice(Math.max(0, syntheticOffset - MAX_PREFIX_CHARS), syntheticOffset), MAX_PREFIX_CHARS),
		suffix: trimEndBoundary(syntheticText.slice(syntheticOffset, Math.min(syntheticText.length, syntheticOffset + MAX_SUFFIX_CHARS)), MAX_SUFFIX_CHARS),
		selectedText,
		effectiveCursorOffset: syntheticOffset
	};
}

function createFileContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	range: vscode.Range,
	promptContext: IPromptContext
): { readonly fileHeader: string; readonly nearbyCode: string; readonly currentLine: string } {
	const fullText = document.getText();
	const effectiveText = promptContext.selectedText && range.end.isAfter(range.start)
		? `${fullText.slice(0, document.offsetAt(range.start))}${promptContext.selectedText}${fullText.slice(document.offsetAt(range.end))}`
		: fullText;
	const cursorOffset = Math.min(promptContext.effectiveCursorOffset, effectiveText.length);
	const fileHeader = createFileHeader(document);
	const nearbyStart = Math.max(0, cursorOffset - Math.floor(MAX_NEARBY_CHARS * 0.6));
	const nearbyEnd = Math.min(effectiveText.length, cursorOffset + Math.floor(MAX_NEARBY_CHARS * 0.4));
	const beforeCursor = effectiveText.slice(nearbyStart, cursorOffset);
	const afterCursor = effectiveText.slice(cursorOffset, nearbyEnd);

	return {
		fileHeader,
		nearbyCode: `${trimStartBoundary(beforeCursor, Math.floor(MAX_NEARBY_CHARS * 0.6))}<CURSOR>${trimEndBoundary(afterCursor, Math.floor(MAX_NEARBY_CHARS * 0.4))}`,
		currentLine: document.lineAt(position.line).text
	};
}

function createFileHeader(document: vscode.TextDocument): string {
	const endLine = Math.min(document.lineCount - 1, FILE_HEADER_LINE_COUNT - 1);
	if (endLine < 0) {
		return '';
	}

	const header = document.getText(new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length));
	return trimEndBoundary(header, MAX_FILE_HEADER_CHARS);
}

async function createScopeContext(
	document: vscode.TextDocument,
	position: vscode.Position
): Promise<{ readonly symbolTrail: string; readonly scopeSnippet: string }> {
	const scopeSymbols = await getContainingDocumentSymbols(document, position);
	const symbolTrail = scopeSymbols
		.slice(-MAX_SCOPE_SYMBOLS)
		.map(symbol => `${getSymbolKindLabel(symbol.kind)}: ${symbol.name} (${symbol.range.start.line + 1}-${symbol.range.end.line + 1})`)
		.join('\n');
	const activeSymbol = scopeSymbols[scopeSymbols.length - 1];

	return {
		symbolTrail,
		scopeSnippet: activeSymbol ? createScopeSnippet(document, activeSymbol.range, position) : ''
	};
}

async function getContainingDocumentSymbols(
	document: vscode.TextDocument,
	position: vscode.Position
): Promise<IContainingDocumentSymbol[]> {
	const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
		'vscode.executeDocumentSymbolProvider',
		document.uri
	) ?? [];

	return flattenDocumentSymbols(symbols, document.uri)
		.filter(symbol => symbol.range.contains(position))
		.sort((a, b) => compareRangeSize(b.range, a.range));
}

function flattenDocumentSymbols(
	symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
	uri: vscode.Uri,
	bucket: IContainingDocumentSymbol[] = []
): IContainingDocumentSymbol[] {
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			bucket.push({
				name: symbol.name,
				kind: symbol.kind,
				range: symbol.range
			});
			flattenDocumentSymbols(symbol.children, uri, bucket);
			continue;
		}

		if (symbol.location.uri.toString() === uri.toString()) {
			bucket.push({
				name: symbol.name,
				kind: symbol.kind,
				range: symbol.location.range
			});
		}
	}

	return bucket;
}

function isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
	return 'children' in symbol && Array.isArray(symbol.children);
}

function compareRangeSize(a: vscode.Range, b: vscode.Range): number {
	return rangeWeight(a) - rangeWeight(b);
}

function rangeWeight(range: vscode.Range): number {
	return ((range.end.line - range.start.line) * 100000) + (range.end.character - range.start.character);
}

function getSymbolKindLabel(kind: vscode.SymbolKind): string {
	const label = vscode.SymbolKind[kind];
	return typeof label === 'string' ? label : 'Symbol';
}

function createScopeSnippet(document: vscode.TextDocument, range: vscode.Range, position: vscode.Position): string {
	const scopeText = document.getText(range);
	if (!scopeText) {
		return '';
	}

	if (scopeText.length <= MAX_SCOPE_CHARS) {
		return scopeText;
	}

	const relativeCursorOffset = Math.max(0, Math.min(scopeText.length, document.offsetAt(position) - document.offsetAt(range.start)));
	const beforeBudget = Math.floor(MAX_SCOPE_CHARS * 0.6);
	const afterBudget = Math.floor(MAX_SCOPE_CHARS * 0.3);
	const before = trimStartBoundary(scopeText.slice(0, relativeCursorOffset), beforeBudget);
	const after = trimEndBoundary(scopeText.slice(relativeCursorOffset), afterBudget);
	const prefix = before.length < relativeCursorOffset ? '...[已截断]\n' : '';
	const suffix = relativeCursorOffset + after.length < scopeText.length ? '\n...[已截断]' : '';
	return `${prefix}${before}<CURSOR>${after}${suffix}`;
}

function trimPromptPreservingTask(prompt: string, maxChars: number): string {
	if (prompt.length <= maxChars) {
		return prompt;
	}

	const marker = '光标附近代码（<CURSOR> 为补全位置）:';
	const markerIndex = prompt.indexOf(marker);
	if (markerIndex < 0) {
		return prompt.slice(prompt.length - maxChars);
	}

	const head = prompt.slice(0, markerIndex);
	const tailBudget = Math.max(0, maxChars - head.length);
	return `${head}${prompt.slice(prompt.length - tailBudget)}`;
}

function finalizeCompletionText(value: string, originalValue?: string): string {
	let completion = value.replace(/\s+$/u, match => match.includes('\n') ? '\n' : match);
	completion = completion.slice(0, MAX_COMPLETION_CHARS);

	if (originalValue !== undefined && completion === originalValue) {
		return '';
	}

	if (!completion.trim() && !completion.includes('\n')) {
		return '';
	}

	return completion;
}

function pruneCache(cache: Map<string, ICachedInlineCompletion>): void {
	const now = Date.now();
	for (const [key, value] of cache) {
		if (now - value.createdAt >= CACHE_TTL_MS) {
			cache.delete(key);
		}
	}
}
