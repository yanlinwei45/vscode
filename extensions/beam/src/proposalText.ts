/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IBeamTextOffsetRange {
	readonly start: number;
	readonly end: number;
}

export function applyProposalTextToContent(
	text: string,
	code: string,
	mode: 'replace' | 'insert',
	insertOffset: number,
	selections: readonly IBeamTextOffsetRange[],
): string {
	if (mode === 'insert') {
		return `${text.slice(0, insertOffset)}${code}${text.slice(insertOffset)}`;
	}

	const orderedSelections = [...selections]
		.filter(selection => selection.start < selection.end)
		.sort((a, b) => b.start - a.start);

	if (!orderedSelections.length) {
		return code;
	}

	let nextText = text;
	for (const selection of orderedSelections) {
		nextText = `${nextText.slice(0, selection.start)}${code}${nextText.slice(selection.end)}`;
	}

	return nextText;
}
