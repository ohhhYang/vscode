/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { SymbolOutlineProvider } from './symbolOutline';

export function activate(context: vscode.ExtensionContext) {
	const symbolOutlineProvider = new SymbolOutlineProvider(context);
	vscode.window.registerTreeDataProvider('symbolOutline', symbolOutlineProvider);
	vscode.commands.registerCommand('symbolOutline.refresh', () => {
		symbolOutlineProvider.refresh();
	});
	vscode.commands.registerCommand('symbolOutline.revealRange', (editor: vscode.TextEditor, range: vscode.Range) => {
		editor.revealRange(
			range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		editor.selection = new vscode.Selection(range.start, range.end);
		vscode.window.showTextDocument(editor.document);
	});
}

export function deactivate() {
}
