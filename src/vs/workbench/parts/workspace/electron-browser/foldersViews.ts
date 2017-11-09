/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as errors from 'vs/base/common/errors';
import { isMacintosh } from 'vs/base/common/platform';
import { localize } from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { chain } from 'vs/base/common/event';
import { PagedModel, IPagedModel } from 'vs/base/common/paging';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { append, $, toggleClass } from 'vs/base/browser/dom';
import { PagedList } from 'vs/base/browser/ui/list/listPaging';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Delegate, Renderer } from 'vs/workbench/parts/workspace/browser/foldersList';
import { IFolder, IFoldersWorkbenchService, WorkspaceFolderState } from 'vs/workbench/services/folders/common/folders';
import { IFolderAction, AddWorkspaceFolderAction, RemoveWorkspaceFoldersAction, ExploreWorkspaceFolderAction, AddAndExploreWorkspaceFolderAction } from 'vs/workbench/parts/workspace/browser/folderActions';
import { IListService } from 'vs/platform/list/browser/listService';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachListStyler, attachBadgeStyler } from 'vs/platform/theme/common/styler';
import { ViewsViewletPanel, IViewletViewOptions, IViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { CountBadge } from 'vs/base/browser/ui/countBadge/countBadge';
import { domEvent } from 'vs/base/browser/event';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode } from 'vs/base/common/keyCodes';
import { defaultGenerator } from 'vs/base/common/idGenerator';

export abstract class FoldersListView extends ViewsViewletPanel {

	private messageBox: HTMLElement;
	private foldersList: HTMLElement;
	private badge: CountBadge;

	private list: PagedList<IFolder>;

	constructor(
		private options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IFoldersWorkbenchService protected catalogService: IFoldersWorkbenchService,
	) {
		super({ ...(options as IViewOptions), ariaHeaderLabel: options.name }, keybindingService, contextMenuService);

		this.registerListeners();
	}

	protected registerListeners(): void { }

	renderHeader(container: HTMLElement): void {
		const titleDiv = append(container, $('div.title'));
		append(titleDiv, $('span')).textContent = this.options.name;
		this.badge = new CountBadge(append(container, $('.count-badge-wrapper')));
		this.disposables.push(attachBadgeStyler(this.badge, this.themeService));
	}

	renderBody(container: HTMLElement): void {
		this.foldersList = append(container, $('.folders-list'));
		this.messageBox = append(container, $('.message'));
		const delegate = new Delegate();
		const renderer = this.instantiationService.createInstance(Renderer);
		this.list = new PagedList(this.foldersList, delegate, [renderer], {
			ariaLabel: localize('folders', "Folders"),
			keyboardSupport: false,
		});

		const onKeyDown = chain(domEvent(this.foldersList, 'keydown'))
			.map(e => new StandardKeyboardEvent(e));

		const onKeyDownForList = onKeyDown.filter(() => this.count() > 0);
		onKeyDownForList.filter(e => e.keyCode === KeyCode.Enter && (e.ctrlKey || (isMacintosh && e.metaKey)))
			.on(this.onModifierEnter, this, this.disposables);
		onKeyDownForList.filter(e => e.keyCode === KeyCode.Delete || e.keyCode === KeyCode.Backspace)
			.on(this.onDelete, this, this.disposables);

		this.disposables.push(attachListStyler(this.list.widget, this.themeService));
		this.disposables.push(this.listService.register(this.list.widget));

		chain(this.list.onPin)
			.map(e => e.elements[0])
			.filter(e => !!e)
			.on(this.pin, this, this.disposables);
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible).then(() => {
			if (!visible) {
				this.setModel(new PagedModel([]));
			}
		});
	}

	layoutBody(size: number): void {
		this.foldersList.style.height = size + 'px';
		this.list.layout(size);
	}

	async show(query: string): TPromise<IPagedModel<IFolder>> {
		const model = await this.query(query);
		this.setModel(model);
		return model;
	}

	select(): void {
		this.list.setSelection(this.list.getFocus());
	}

	showPrevious(): void {
		this.list.focusPrevious();
		this.list.reveal(this.list.getFocus()[0]);
	}

	showPreviousPage(): void {
		this.list.focusPreviousPage();
		this.list.reveal(this.list.getFocus()[0]);
	}

	showNext(): void {
		this.list.focusNext();
		this.list.reveal(this.list.getFocus()[0]);
	}

	showNextPage(): void {
		this.list.focusNextPage();
		this.list.reveal(this.list.getFocus()[0]);
	}

	count(): number {
		return this.list.length;
	}

	protected abstract async query(value: string): TPromise<IPagedModel<IFolder>>;

	/**
	 * Returns how long to delay before performing the search. Views that know their results
	 * are cached should return 0 to provide faster responses to user input.
	 */
	public getDelayForQuery(value: string): number {
		return 500;
	}

	private setModel(model: IPagedModel<IFolder>) {
		this.list.model = model;
		this.list.scrollTop = 0;
		const count = this.count();

		toggleClass(this.foldersList, 'hidden', count === 0);
		toggleClass(this.messageBox, 'hidden', count > 0);
		this.badge.setCount(count);

		if (count === 0 && this.isVisible()) {
			this.messageBox.textContent = localize('workspaceFolders.noResults', "No repositories or folders found.");
		} else {
			this.messageBox.textContent = '';
		}
	}

	public hasFocusedElements(): boolean {
		return !!this.list.getFocus().length;
	}

	public onDelete(e: StandardKeyboardEvent): void {
		e.preventDefault();
		e.stopPropagation();

		const folders = this.list.widget.getSelection().map(i => this.list.model.get(i));
		if (folders.length) {
			this.list.focusNext();
		}

		const foldersToRemove = folders.filter(f => f.state === WorkspaceFolderState.Active);
		const removeAction = this.instantiationService.createInstance(RemoveWorkspaceFoldersAction, foldersToRemove);
		removeAction.run().done(null, errors.onUnexpectedError);
	}

	public onModifierEnter(e: StandardKeyboardEvent): void {
		e.preventDefault();
		e.stopPropagation();

		const folders = this.list.getFocus().map(index => this.list.model.get(index));
		let selectNext = false;
		const promises = folders.map(folder => {
			const actionClass = folder.state === WorkspaceFolderState.Active ? ExploreWorkspaceFolderAction : AddAndExploreWorkspaceFolderAction;
			const action = this.instantiationService.createInstance<IFolderAction>(actionClass);
			action.folder = folder;
			return action.run();
		});

		TPromise.join(promises)
			.then(() => {
				if (selectNext) {
					this.list.selectNext();
				}
			})
			.done(null, errors.onUnexpectedError);
	}

	private pin(folder: IFolder): void {
		const actionClass = folder.state === WorkspaceFolderState.Active ? ExploreWorkspaceFolderAction : AddWorkspaceFolderAction;
		const action = this.instantiationService.createInstance<IFolderAction>(actionClass);
		action.folder = folder;
		action.run().done(null, errors.onUnexpectedError);
	}
}

export class CurrentWorkspaceFoldersView extends FoldersListView {
	protected registerListeners(): void {
		super.registerListeners();

		// The only time that an entry can be deleted (a list structural change) is when
		// a root is removed. All other changes are handled by the actions' and widgets'
		// own listeners within an entry.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			this.disposables.push(this.contextService.onDidChangeWorkspaceFolders(() => {
				this.show(''); // trigger a reload; query is always empty in this view
			}));
		}
	}

	protected query(value: string): TPromise<IPagedModel<IFolder>> {
		return this.catalogService.getCurrentWorkspaceFolders().then(folders => new PagedModel(folders));
	}
}

export class SearchFoldersView extends FoldersListView {
	private cacheKey = defaultGenerator.nextId();

	setVisible(visible: boolean): TPromise<void> {
		// Reset the cache each time we show/hide the viewlet, to avoid stale results.
		this.cacheKey = defaultGenerator.nextId();

		return super.setVisible(visible);
	}

	public getDelayForQuery(value: string): number {
		if (this.catalogService.isSearchCached({ value, cacheKey: this.cacheKey })) {
			return 0;
		}
		// Shorter queries will return more irrelevant results slowly, so don't
		// immediately fire off short searches.
		if (value.length <= 2) {
			return 1250;
		} else if (value.length <= 3) {
			return 1000;
		}
		return 500;
	}

	protected query(value: string): TPromise<IPagedModel<IFolder>> {
		return this.catalogService.search({ value, cacheKey: this.cacheKey }).then(complete => {
			return new PagedModel(complete.results);
		});
	}
}
