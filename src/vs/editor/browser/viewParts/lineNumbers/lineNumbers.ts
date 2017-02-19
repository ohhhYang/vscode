/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./lineNumbers';
import * as platform from 'vs/base/common/platform';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { DynamicViewOverlay } from 'vs/editor/browser/view/dynamicViewOverlay';
import { ClassNames } from 'vs/editor/browser/editorBrowser';
import { ViewContext } from 'vs/editor/common/view/viewContext';
import { IRenderingContext } from 'vs/editor/common/view/renderingContext';
import * as viewEvents from 'vs/editor/common/view/viewEvents';
import { ScrollEvent } from 'vs/base/common/scrollable';

export class LineNumbersOverlay extends DynamicViewOverlay {

	private _context: ViewContext;
	private _lineHeight: number;
	private _renderLineNumbers: boolean;
	private _renderRelativeLineNumbers: boolean;
	private _lineNumbersLeft: number;
	private _lineNumbersWidth: number;
	private _renderResult: string[];

	constructor(context: ViewContext) {
		super();
		this._context = context;
		this._lineHeight = this._context.configuration.editor.lineHeight;
		this._renderLineNumbers = this._context.configuration.editor.viewInfo.renderLineNumbers;
		this._renderRelativeLineNumbers = this._context.configuration.editor.viewInfo.renderRelativeLineNumbers;
		this._lineNumbersLeft = this._context.configuration.editor.layoutInfo.lineNumbersLeft;
		this._lineNumbersWidth = this._context.configuration.editor.layoutInfo.lineNumbersWidth;
		this._renderResult = null;
		this._context.addEventHandler(this);
	}

	public dispose(): void {
		this._context.removeEventHandler(this);
		this._context = null;
		this._renderResult = null;
	}

	// --- begin event handlers

	public onModelFlushed(): boolean {
		return true;
	}
	public onModelDecorationsChanged(e: viewEvents.IViewDecorationsChangedEvent): boolean {
		return false;
	}
	public onModelLinesDeleted(e: viewEvents.IViewLinesDeletedEvent): boolean {
		return true;
	}
	public onModelLineChanged(e: viewEvents.IViewLineChangedEvent): boolean {
		return true;
	}
	public onModelLinesInserted(e: viewEvents.IViewLinesInsertedEvent): boolean {
		return true;
	}
	public onCursorPositionChanged(e: viewEvents.IViewCursorPositionChangedEvent): boolean {
		if (this._renderRelativeLineNumbers) {
			return true;
		}
		return false;
	}
	public onCursorSelectionChanged(e: viewEvents.IViewCursorSelectionChangedEvent): boolean {
		return false;
	}
	public onCursorRevealRange(e: viewEvents.IViewRevealRangeEvent): boolean {
		return false;
	}
	public onConfigurationChanged(e: editorCommon.IConfigurationChangedEvent): boolean {
		if (e.lineHeight) {
			this._lineHeight = this._context.configuration.editor.lineHeight;
		}
		if (e.viewInfo.renderLineNumbers) {
			this._renderLineNumbers = this._context.configuration.editor.viewInfo.renderLineNumbers;
		}
		if (e.viewInfo.renderRelativeLineNumbers) {
			this._renderRelativeLineNumbers = this._context.configuration.editor.viewInfo.renderRelativeLineNumbers;
		}
		if (e.layoutInfo) {
			this._lineNumbersLeft = this._context.configuration.editor.layoutInfo.lineNumbersLeft;
			this._lineNumbersWidth = this._context.configuration.editor.layoutInfo.lineNumbersWidth;
		}
		return true;
	}
	public onScrollChanged(e: ScrollEvent): boolean {
		return e.scrollTopChanged;
	}
	public onZonesChanged(): boolean {
		return true;
	}

	// --- end event handlers

	public prepareRender(ctx: IRenderingContext): void {
		if (!this._renderLineNumbers) {
			this._renderResult = null;
			return;
		}

		let lineHeightClassName = (platform.isLinux ? (this._lineHeight % 2 === 0 ? ' lh-even' : ' lh-odd') : '');
		let visibleStartLineNumber = ctx.visibleRange.startLineNumber;
		let visibleEndLineNumber = ctx.visibleRange.endLineNumber;
		let common = '<div class="' + ClassNames.LINE_NUMBERS + lineHeightClassName + '" style="left:' + this._lineNumbersLeft.toString() + 'px;width:' + (this._lineNumbersWidth + 5).toString() + 'px;">';

		let output: string[] = [];
		for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {
			let lineIndex = lineNumber - visibleStartLineNumber;

			let renderLineNumber = this._context.model.getLineRenderLineNumber(lineNumber);
			if (renderLineNumber) {
				output[lineIndex] = (
					common
					+ renderLineNumber
					+ '</div>'
				);
			} else {
				output[lineIndex] = '';
			}
		}

		this._renderResult = output;
	}

	public render(startLineNumber: number, lineNumber: number): string {
		if (!this._renderResult) {
			return '';
		}
		let lineIndex = lineNumber - startLineNumber;
		if (lineIndex < 0 || lineIndex >= this._renderResult.length) {
			throw new Error('Unexpected render request');
		}
		return this._renderResult[lineIndex];
	}
}
