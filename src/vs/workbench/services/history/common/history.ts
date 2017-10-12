/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Event from 'vs/base/common/event';
import { createDecorator, ServiceIdentifier } from 'vs/platform/instantiation/common/instantiation';
import { IEditorInput, IResourceInput, ITextEditorSelection } from 'vs/platform/editor/common/editor';
import URI from 'vs/base/common/uri';

export interface IStackEntry {
	input: IEditorInput | IResourceInput;
	selection?: ITextEditorSelection;
	timestamp: number;
}

export const IHistoryService = createDecorator<IHistoryService>('historyService');

export interface IHistoryService {

	_serviceBrand: ServiceIdentifier<any>;

	/**
	 * An event that is fired whenever the history changes.
	 */
	onDidChange: Event<void>;

	/**
	 * Re-opens the last closed editor if any.
	 */
	reopenLastClosedEditor(): void;

	/**
	 * Go forward or back in history.
	 *
	 * @param offset positive number for forward, negative number for back
	 */
	go(offset: number): void;

	/**
	 * Navigate forwards in history.
	 *
	 * @param acrossEditors instructs the history to skip navigation entries that
	 * are only within the same document.
	 */
	forward(acrossEditors?: boolean): void;

	/**
	 * Navigate backwards in history.
	 *
	 * @param acrossEditors instructs the history to skip navigation entries that
	 * are only within the same document.
	 */
	back(acrossEditors?: boolean): void;

	/**
	 * Returns whether it is possible to go back and forward from the current state.
	 */
	canNavigate(): { back: boolean, forward: boolean };

	/**
	 * Navigate forward or backwards to previous entry in history.
	 */
	last(): void;

	/**
	 * Removes an entry from history.
	 */
	remove(input: IEditorInput | IResourceInput): void;

	/**
	 * Clears all history.
	 */
	clear(): void;

	/**
	 * Get the entire history of opened editors.
	 */
	getHistory(): (IEditorInput | IResourceInput)[];

	/**
	 * Get the entire history stack of editors and selections and the index of the current
	 * entry.
	 */
	getStack(): { stack: IStackEntry[], index: number };

	/**
	 * Looking at the editor history, returns the workspace root of the last file that was
	 * inside the workspace and part of the editor history.
	 */
	getLastActiveWorkspaceRoot(): URI;
}