/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';
import { OverviewRulerLane, ICommonCodeEditor, IDecorationOptions } from 'vs/editor/common/editorCommon';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { ICodeCommentsService } from 'vs/editor/common/services/codeCommentsService';
import { ISCMService } from 'vs/workbench/services/scm/common/scm';
import URI from 'vs/base/common/uri';
import { isFileLikeResource } from 'vs/platform/files/common/files';
import { buttonBackground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';

const DECORATION_KEY = 'codeComment';

/**
 * DecorationRenderer is responsible for decorating the text editor
 * with indications of comments. This may include highlighting ranges
 * as well as a comment icon in the left gutter or glyph margin.
 */
export class CodeCommentsDecorationRenderer extends Disposable {

	private toDisposeOnEditorRemove = new Map<string, IDisposable>();

	constructor(
		@ICodeEditorService private codeEditorService: ICodeEditorService,
		@ICodeCommentsService private codeCommentsService: ICodeCommentsService,
		@ISCMService scmService: ISCMService,
		@IThemeService themeService: IThemeService,
	) {
		super();
		this._register(this.codeEditorService.onCodeEditorAdd(editor => {
			this.toDisposeOnEditorRemove.set(editor.getId(), editor.onDidChangeModel(e => this.renderEditorDecorations(editor)));
		}));
		this._register(this.codeEditorService.onCodeEditorRemove(e => {
			const sub = this.toDisposeOnEditorRemove.get(e.getId());
			if (sub) {
				this.toDisposeOnEditorRemove.delete(e.getId());
				sub.dispose();
			}
		}));

		scmService.onDidChangeProvider(e => this.renderDecorations());

		const gutterIconPath = URI.parse(require.toUrl('./../electron-browser/media/comment.svg')).fsPath;
		const color = themeService.getTheme().getColor(buttonBackground).toString();
		codeEditorService.registerDecorationType(DECORATION_KEY, {
			backgroundColor: color,
			overviewRulerLane: OverviewRulerLane.Full,
			overviewRulerColor: color,
			gutterIconPath: gutterIconPath,
			gutterIconSize: 'contain',
		});

		this._register(codeCommentsService.onCommentsDidChange(() => this.renderDecorations()));
	}

	public getId(): string {
		return 'sg.codeComments.decorationRenderer';
	}

	private renderDecorations(): void {
		this.codeEditorService.listCodeEditors().map(this.renderEditorDecorations, this);
	}

	private renderEditorDecorations(editor: ICommonCodeEditor) {
		const model = editor.getModel();
		if (!model) {
			return;
		}
		if (model.getLineCount() < 1) {
			return;
		}
		if (!isFileLikeResource(model.uri)) {
			return;
		}
		this.codeCommentsService.getThreads(model.uri, false).then(threads => {
			const decorations: IDecorationOptions[] = threads.map(thread => ({ range: thread.range }));
			editor.setDecorations(DECORATION_KEY, decorations);
		}, err => {
			// Ignore errors.
			// This commonly happens if decorations are requested before a scm provider is registered.
			// Decorations will be re-rendered when the scm provider becomes available.
		});
	}
}