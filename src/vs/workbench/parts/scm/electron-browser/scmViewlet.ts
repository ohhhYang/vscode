/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/scmViewlet';
import { localize } from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { chain } from 'vs/base/common/event';
import { basename } from 'vs/base/common/paths';
import { onUnexpectedError } from 'vs/base/common/errors';
import { IDisposable, dispose, combinedDisposable } from 'vs/base/common/lifecycle';
import { Builder } from 'vs/base/browser/builder';
import { PersistentViewsViewlet, CollapsibleView, IViewletViewOptions, IViewletView, IViewOptions } from 'vs/workbench/browser/parts/views/views';
import { append, $, toggleClass, trackFocus, addClass, removeClass } from 'vs/base/browser/dom';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { List } from 'vs/base/browser/ui/list/listWidget';
import { IDelegate, IRenderer, IListEvent, IListContextMenuEvent } from 'vs/base/browser/ui/list/list';
import { VIEWLET_ID } from 'vs/workbench/parts/scm/common/scm';
import { FileLabel } from 'vs/workbench/browser/labels';
import { CountBadge } from 'vs/base/browser/ui/countBadge/countBadge';
import { ISCMService, ISCMRepository, ISCMResourceGroup, ISCMResource } from 'vs/workbench/services/scm/common/scm';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IContextViewService, IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IMessageService } from 'vs/platform/message/common/message';
import { IListService } from 'vs/platform/list/browser/listService';
import { MenuItemAction } from 'vs/platform/actions/common/actions';
import { IAction, Action, IActionItem, ActionRunner } from 'vs/base/common/actions';
import { MenuItemActionItem } from 'vs/platform/actions/browser/menuItemActionItem';
import { SCMMenus } from './scmMenus';
import { ActionBar, IActionItemProvider, Separator, ActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IThemeService, LIGHT } from 'vs/platform/theme/common/themeService';
import { isSCMResource } from './scmUtil';
import { attachListStyler, attachBadgeStyler, attachInputBoxStyler } from 'vs/platform/theme/common/styler';
import Severity from 'vs/base/common/severity';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ViewLocation, ViewsRegistry, IViewDescriptor } from 'vs/workbench/browser/parts/views/viewsRegistry';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { ViewSizing } from 'vs/base/browser/ui/splitview/splitview';
import { IExtensionsViewlet, VIEWLET_ID as EXTENSIONS_VIEWLET_ID } from 'vs/workbench/parts/extensions/common/extensions';
import { InputBox } from 'vs/base/browser/ui/inputbox/inputBox';
import * as platform from 'vs/base/common/platform';
import { domEvent } from 'vs/base/browser/event';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Command } from 'vs/editor/common/modes';
import { render as renderOcticons } from 'vs/base/browser/ui/octiconLabel/octiconLabel';
import { CombinedSCMRepository, CombinedSCMProvider } from './scmCombo';

const ENABLE_SCM_COMBO = false;

// TODO@Joao
// Need to subclass MenuItemActionItem in order to respect
// the action context coming from any action bar, without breaking
// existing users
class SCMMenuItemActionItem extends MenuItemActionItem {

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		if (this._context instanceof CombinedSCMProvider) {
			TPromise.join(this._context.providers.map(provider => this.actionRunner.run(this._commandAction, provider)))
				.done(undefined, err => this._messageService.show(Severity.Error, err));
			return;
		}

		this.actionRunner.run(this._commandAction, this._context)
			.done(undefined, err => this._messageService.show(Severity.Error, err));
	}
}

function identityProvider(r: ISCMResourceGroup | ISCMResource): string {
	if (isSCMResource(r)) {
		const group = r.resourceGroup;
		const provider = group.provider;
		return `${provider.contextValue}/${group.id}/${r.sourceUri.toString()}`;
	} else {
		const provider = r.provider;
		return `${provider.contextValue}/${r.id}`;
	}
}

interface IViewModel {
	isRepositoryVisible(repository: ISCMRepository): boolean;
	toggleRepositoryVisibility(repository: ISCMRepository, visible: boolean);
	setRepositoriesVisible(repositories: ISCMRepository[]);
	getPendingChangesCount(repository: ISCMRepository): number;
}

class ProvidersViewDescriptor implements IViewDescriptor {
	readonly id = 'providers';
	readonly name = '';
	readonly location = ViewLocation.SCM;
	readonly ctor = null;
}

class ProvidersListDelegate implements IDelegate<ISCMRepository> {

	getHeight(element: ISCMRepository): number {
		return 22;
	}

	getTemplateId(element: ISCMRepository): string {
		return 'provider';
	}
}

interface RepositoryTemplateData {
	provider: HTMLElement;
	checkbox: HTMLInputElement;
	title: HTMLElement;
	type: HTMLElement;
	actionBar: ActionBar;
	badge: CountBadge;
	disposable: IDisposable;
	templateDisposable: IDisposable;
}

class StatusBarAction extends Action {

	constructor(
		private command: Command,
		private commandService: ICommandService
	) {
		super(`statusbaraction{${command.id}}`, command.title, '', true);
		this.tooltip = command.tooltip;
	}

	run(): TPromise<void> {
		return this.commandService.executeCommand(this.command.id, ...this.command.arguments);
	}
}

class StatusBarActionItem extends ActionItem {

	constructor(action: StatusBarAction) {
		super(null, action, {});
	}

	_updateLabel(): void {
		if (this.options.label) {
			this.$e.innerHtml(renderOcticons(this.getAction().label));
		}
	}
}

class ProviderRenderer implements IRenderer<ISCMRepository, RepositoryTemplateData> {

	readonly templateId = 'provider';

	constructor(
		protected viewModel: IViewModel,
		@IThemeService private themeService: IThemeService,
		@ICommandService protected commandService: ICommandService
	) { }

	renderTemplate(container: HTMLElement): RepositoryTemplateData {
		const provider = append(container, $('.scm-provider'));
		const checkbox = append(provider, $('input', { type: 'checkbox', checked: 'true' })) as HTMLInputElement;
		checkbox.style.display = 'none'; // TODO(sqs)
		const name = append(provider, $('.name'));
		const title = append(name, $('span.title'));
		const type = append(name, $('span.type'));
		const actionBar = new ActionBar(provider, { actionItemProvider: a => new StatusBarActionItem(a as StatusBarAction) });
		const badge = new CountBadge(append(provider, $('.badge')));
		const disposable = combinedDisposable([attachBadgeStyler(badge, this.themeService)]);
		const templateDisposable = combinedDisposable([actionBar]);

		return { provider, checkbox, title, type, actionBar, badge, disposable, templateDisposable };
	}

	renderElement(repository: ISCMRepository, index: number, templateData: RepositoryTemplateData): void {
		templateData.disposable.dispose();
		const disposables: IDisposable[] = [];

		if (repository.provider.rootUri) {
			templateData.title.textContent = basename(repository.provider.rootUri.fsPath);
			templateData.type.textContent = repository.provider.label;
		} else {
			templateData.title.textContent = repository.provider.label;
			templateData.type.textContent = '';
		}

		templateData.checkbox.checked = this.viewModel.isRepositoryVisible(repository);
		const onClick = domEvent(templateData.checkbox, 'change');
		disposables.push(onClick(() => this.viewModel.toggleRepositoryVisibility(repository, templateData.checkbox.checked)));

		// const disposables = commands.map(c => this.statusbarService.addEntry({
		// 	text: c.title,
		// 	tooltip: `${repository.provider.label} - ${c.tooltip}`,
		// 	command: c.id,
		// 	arguments: c.arguments
		// }, MainThreadStatusBarAlignment.LEFT, 10000));

		const actions = [];
		const disposeActions = () => dispose(actions);
		disposables.push({ dispose: disposeActions });

		const updateActions = () => {
			disposeActions();

			const commands = repository.provider.statusBarCommands || [];
			actions.splice(0, actions.length, ...commands.map(c => new StatusBarAction(c, this.commandService)));
			templateData.actionBar.clear();
			templateData.actionBar.push(actions);

			const count = this.viewModel.getPendingChangesCount(repository);
			templateData.badge.setCount(count);
			templateData.badge.setTitleFormat(count > 1 ? localize('repositoryPendingChanges', "{0} pending changes", count) : localize('repositoryPendingChange', "{0} pending change", count));

			if (count > 0) {
				addClass(templateData.provider, 'dirty');
			} else {
				removeClass(templateData.provider, 'dirty');
			}
		};

		repository.provider.onDidChange(updateActions, null, disposables);
		updateActions();

		templateData.disposable = combinedDisposable(disposables);
	}

	disposeTemplate(templateData: RepositoryTemplateData): void {
		templateData.disposable.dispose();
		templateData.templateDisposable.dispose();
	}
}

class ProvidersView extends CollapsibleView {

	private list: List<ISCMRepository>;
	private repositoryMenus = new Map<ISCMRepository, SCMMenus>();

	constructor(
		initialSize: number,
		protected viewModel: IViewModel,
		options: IViewletViewOptions,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@ISCMService protected scmService: ISCMService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		super(initialSize, {
			...(options as IViewOptions),
			sizing: ViewSizing.Fixed,
			name: localize('scm providers', "Source Control Providers"),
		}, keybindingService, contextMenuService);
	}

	renderHeader(container: HTMLElement): void {
		const title = append(container, $('div.title'));
		title.textContent = this.name;

		super.renderHeader(container);
	}

	protected renderBody(container: HTMLElement): void {
		const delegate = new ProvidersListDelegate();
		const renderer = this.instantiationService.createInstance(ProviderRenderer, this.viewModel);
		this.list = new List<ISCMRepository>(container, delegate, [renderer]);

		this.toDispose.push(attachListStyler(this.list, this.themeService));

		this.list.onSelectionChange(this.onListSelectionChange, this, this.toDispose);
		this.list.onContextMenu(this.onListContextMenu, this, this.toDispose);
		this.toDispose.push(this.listService.register(this.list));
		this.toDispose.push(this.list);

		this.scmService.onDidAddRepository(this.onDidAddRepository, this, this.toDispose);
		this.scmService.onDidRemoveRepository(this.onDidRemoveRepository, this, this.toDispose);
		this.updateList();
	}

	layoutBody(size: number): void {
		if (!this.list) {
			return;
		}

		this.list.layout(size);
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible).then(() => {
			if (this.list.length && this.list.getFocus().length === 0 && this.list.getSelection().length === 0) {
				this.list.setFocus([0]);
				this.list.setSelection([0]);
			}
		});
	}

	private updateList(): void {
		const focused = this.list.getFocusedElements();
		this.list.splice(0, this.list.length, this.scmService.repositories);
		if (focused.length) {
			const indexes = focused.map(repository => this.scmService.repositories.indexOf(repository)).filter(i => i !== -1);
			this.list.setFocus(indexes);
			this.list.setSelection(indexes);
		}
	}

	private onDidAddRepository(repository: ISCMRepository): void {
		const wasEmpty = this.list.length === 0;
		this.updateList();
		this.setBodySize(this.getExpandedBodySize());
		if (wasEmpty) {
			this.list.setFocus([0]);
			this.list.setSelection([0]);
		}
	}

	private onDidRemoveRepository(repository: ISCMRepository): void {
		this.updateList();
		this.setBodySize(this.getExpandedBodySize());
	}

	private getExpandedBodySize(): number {
		return Math.min(5, this.scmService.repositories.length) * 22;
	}

	private getSCMMenus(repository: ISCMRepository): SCMMenus {
		let menus = this.repositoryMenus.get(repository);
		if (!menus) {
			menus = this.instantiationService.createInstance(SCMMenus, repository.provider);
			this.toDispose.push(menus);
			this.repositoryMenus.set(repository, menus);
		}
		return menus;
	}

	private onListSelectionChange(e: IListEvent<ISCMRepository>): void {
		this.viewModel.setRepositoriesVisible(e.elements);
	}

	private onListContextMenu(e: IListContextMenuEvent<ISCMRepository>): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => TPromise.as(this.getSCMMenus(e.element).getTitleSecondaryActions()),
			getActionsContext: () => e.element,
		});
	}
}

interface ResourceGroupTemplate {
	name: HTMLElement;
	count: CountBadge;
	actionBar: ActionBar;
	dispose: () => void;
}

class ResourceGroupRenderer implements IRenderer<ISCMResourceGroup, ResourceGroupTemplate> {

	static TEMPLATE_ID = 'resource group';
	get templateId(): string { return ResourceGroupRenderer.TEMPLATE_ID; }

	constructor(
		private scmMenus: SCMMenus,
		private actionItemProvider: IActionItemProvider,
		private themeService: IThemeService
	) { }

	renderTemplate(container: HTMLElement): ResourceGroupTemplate {
		const element = append(container, $('.resource-group'));
		const name = append(element, $('.name'));
		const actionsContainer = append(element, $('.actions'));
		const actionBar = new ActionBar(actionsContainer, { actionItemProvider: this.actionItemProvider });
		const countContainer = append(element, $('.count'));
		const count = new CountBadge(countContainer);
		const styler = attachBadgeStyler(count, this.themeService);

		return {
			name, count, actionBar, dispose: () => {
				actionBar.dispose();
				styler.dispose();
			}
		};
	}

	renderElement(group: ISCMResourceGroup, index: number, template: ResourceGroupTemplate): void {
		template.name.textContent = group.label;
		template.count.setCount(group.resourceCollection.resources.length);
		template.actionBar.clear();
		template.actionBar.context = group;
		template.actionBar.push(this.scmMenus.getResourceGroupActions(group), { icon: true, label: false });
	}

	disposeTemplate(template: ResourceGroupTemplate): void {
		template.dispose();
	}
}

interface ResourceTemplate {
	element: HTMLElement;
	name: HTMLElement;
	fileLabel: FileLabel;
	decorationIcon: HTMLElement;
	actionBar: ActionBar;
	dispose: () => void;
}

class MultipleSelectionActionRunner extends ActionRunner {

	constructor(private getSelectedResources: () => ISCMResource[]) {
		super();
	}

	runAction(action: IAction, context: ISCMResource): TPromise<any> {
		if (action instanceof MenuItemAction) {
			const selection = this.getSelectedResources();
			const filteredSelection = selection.filter(s => s !== context);

			if (selection.length === filteredSelection.length || selection.length === 1) {
				return action.run(context);
			}

			return action.run(context, ...filteredSelection);
		}

		return super.runAction(action, context);
	}
}

class ResourceRenderer implements IRenderer<ISCMResource, ResourceTemplate> {

	static TEMPLATE_ID = 'resource';
	get templateId(): string { return ResourceRenderer.TEMPLATE_ID; }

	constructor(
		private scmMenus: SCMMenus,
		private actionItemProvider: IActionItemProvider,
		private getSelectedResources: () => ISCMResource[],
		@IThemeService private themeService: IThemeService,
		@IInstantiationService private instantiationService: IInstantiationService
	) { }

	renderTemplate(container: HTMLElement): ResourceTemplate {
		const element = append(container, $('.resource'));
		const name = append(element, $('.name'));
		const fileLabel = this.instantiationService.createInstance(FileLabel, name, void 0);
		const actionsContainer = append(element, $('.actions'));
		const actionBar = new ActionBar(actionsContainer, {
			actionItemProvider: this.actionItemProvider,
			actionRunner: new MultipleSelectionActionRunner(this.getSelectedResources)
		});

		const decorationIcon = append(element, $('.decoration-icon'));

		return {
			element, name, fileLabel, decorationIcon, actionBar, dispose: () => {
				actionBar.dispose();
				fileLabel.dispose();
			}
		};
	}

	renderElement(resource: ISCMResource, index: number, template: ResourceTemplate): void {
		template.fileLabel.setFile(resource.sourceUri);
		template.actionBar.clear();
		template.actionBar.context = resource;
		template.actionBar.push(this.scmMenus.getResourceActions(resource), { icon: true, label: false });
		toggleClass(template.name, 'strike-through', resource.decorations.strikeThrough);
		toggleClass(template.element, 'faded', resource.decorations.faded);

		const theme = this.themeService.getTheme();
		const icon = theme.type === LIGHT ? resource.decorations.icon : resource.decorations.iconDark;

		if (icon) {
			template.decorationIcon.style.backgroundImage = `url('${icon}')`;
			template.decorationIcon.title = resource.decorations.tooltip;
		} else {
			template.decorationIcon.style.backgroundImage = '';
		}
	}

	disposeTemplate(template: ResourceTemplate): void {
		template.dispose();
	}
}

class ProviderListDelegate implements IDelegate<ISCMResourceGroup | ISCMResource> {

	getHeight() { return 22; }

	getTemplateId(element: ISCMResourceGroup | ISCMResource) {
		return isSCMResource(element) ? ResourceRenderer.TEMPLATE_ID : ResourceGroupRenderer.TEMPLATE_ID;
	}
}

class ProviderViewDescriptor implements IViewDescriptor {

	// This ID magic needs to happen in order to preserve
	// good splitview state when reloading the workbench
	static idCount = 0;
	static freeIds: string[] = [];

	readonly id: string;

	get repository(): ISCMRepository { return this._repository; }
	get name(): string {
		return this._repository.provider.rootUri
			? `${basename(this._repository.provider.rootUri.fsPath)} (${this._repository.provider.label})`
			: this._repository.provider.label;
	}
	get ctor(): any { return null; }
	get location(): ViewLocation { return ViewLocation.SCM; }
	get order(): number { return 10; }

	constructor(private _repository: ISCMRepository) {
		if (ProviderViewDescriptor.freeIds.length > 0) {
			this.id = ProviderViewDescriptor.freeIds.shift();
		} else {
			this.id = `scm${ProviderViewDescriptor.idCount++}`;
		}
	}

	dispose(): void {
		ProviderViewDescriptor.freeIds.push(this.id);
	}
}

class ProviderView extends CollapsibleView {


	private cachedHeight: number | undefined;
	private inputBoxContainer: HTMLElement;
	private inputBox: InputBox;
	private listContainer: HTMLElement;
	private list: List<ISCMResourceGroup | ISCMResource>;
	private menus: SCMMenus;
	private disposables: IDisposable[] = [];

	constructor(
		initialSize: number,
		private repository: ISCMRepository,
		options: IViewletViewOptions,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IThemeService protected themeService: IThemeService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IContextViewService protected contextViewService: IContextViewService,
		@IListService protected listService: IListService,
		@ICommandService protected commandService: ICommandService,
		@IMessageService protected messageService: IMessageService,
		@IWorkbenchEditorService protected editorService: IWorkbenchEditorService,
		@IEditorGroupService protected editorGroupService: IEditorGroupService,
		@IStorageService private storageService: IStorageService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IInstantiationService protected instantiationService: IInstantiationService
	) {
		super(initialSize, { ...(options as IViewOptions), sizing: ViewSizing.Flexible }, keybindingService, contextMenuService);

		this.menus = instantiationService.createInstance(SCMMenus, repository.provider);
		this.menus.onDidChangeTitle(this.updateActions, this, this.disposables);
	}

	renderHeader(container: HTMLElement): void {
		const header = append(container, $('.title.scm-provider'));
		const name = append(header, $('.name'));
		const title = append(name, $('span.title'));
		const type = append(name, $('span.type'));

		if (this.repository.provider.rootUri) {
			title.textContent = basename(this.repository.provider.rootUri.fsPath);
			type.textContent = this.repository.provider.label;
		} else {
			title.textContent = this.repository.provider.label;
			type.textContent = '';
		}

		super.renderHeader(container);
	}

	renderBody(container: HTMLElement): void {
		const focusTracker = trackFocus(container);
		this.disposables.push(focusTracker.addFocusListener(() => this.repository.focus()));
		this.disposables.push(focusTracker);

		// Input
		this.inputBoxContainer = append(container, $('.scm-editor'));

		this.inputBox = new InputBox(this.inputBoxContainer, this.contextViewService, {
			placeholder: localize('commitMessage', "Message (press {0} to commit)", platform.isMacintosh ? 'Cmd+Enter' : 'Ctrl+Enter'),
			flexibleHeight: true
		});
		this.disposables.push(attachInputBoxStyler(this.inputBox, this.themeService));
		this.disposables.push(this.inputBox);

		this.inputBox.value = this.repository.input.value;
		this.inputBox.onDidChange(value => this.repository.input.value = value, null, this.disposables);
		this.repository.input.onDidChange(value => this.inputBox.value = value, null, this.disposables);
		this.disposables.push(this.inputBox.onDidHeightChange(() => this.layoutBody()));

		chain(domEvent(this.inputBox.inputElement, 'keydown'))
			.map(e => new StandardKeyboardEvent(e))
			.filter(e => e.equals(KeyMod.CtrlCmd | KeyCode.Enter) || e.equals(KeyMod.CtrlCmd | KeyCode.KEY_S))
			.on(this.onDidAcceptInput, this, this.disposables);

		if (this.repository.provider.onDidChangeCommitTemplate) {
			this.repository.provider.onDidChangeCommitTemplate(this.updateInputBox, this, this.disposables);
		}

		this.updateInputBox();

		// List

		this.listContainer = append(container, $('.scm-status.show-file-icons'));
		const delegate = new ProviderListDelegate();

		const actionItemProvider = (action: IAction) => this.getActionItem(action);

		const renderers = [
			new ResourceGroupRenderer(this.menus, actionItemProvider, this.themeService),
			this.instantiationService.createInstance(ResourceRenderer, this.menus, actionItemProvider, () => this.getSelectedResources()),
		];

		this.list = new List(this.listContainer, delegate, renderers, {
			identityProvider,
			keyboardSupport: false
		});

		this.disposables.push(attachListStyler(this.list, this.themeService));
		this.disposables.push(this.listService.register(this.list));

		chain(this.list.onOpen)
			.map(e => e.elements[0])
			.filter(e => !!e && isSCMResource(e))
			.on(this.open, this, this.disposables);

		chain(this.list.onPin)
			.map(e => e.elements[0])
			.filter(e => !!e && isSCMResource(e))
			.on(this.pin, this, this.disposables);

		this.list.onContextMenu(this.onListContextMenu, this, this.disposables);
		this.disposables.push(this.list);

		this.repository.provider.onDidChangeResources(this.updateList, this, this.disposables);
		this.updateList();
	}

	layoutBody(height: number = this.cachedHeight): void {
		if (!height === undefined) {
			return;
		}

		this.list.layout(height);
		this.cachedHeight = height;
		this.inputBox.layout();

		const editorHeight = this.inputBox.height;
		const listHeight = height - (editorHeight + 12 /* margin */);
		this.listContainer.style.height = `${listHeight}px`;
		this.list.layout(listHeight);

		toggleClass(this.inputBoxContainer, 'scroll', editorHeight >= 134);
	}

	focus(): void {
		if (this.isExpanded()) {
			this.inputBox.focus();
		}
	}

	getActions(): IAction[] {
		return this.menus.getTitleActions();
	}

	getSecondaryActions(): IAction[] {
		return this.menus.getTitleSecondaryActions();
	}

	getActionItem(action: IAction): IActionItem {
		if (!(action instanceof MenuItemAction)) {
			return undefined;
		}

		return new SCMMenuItemActionItem(action, this.keybindingService, this.messageService);
	}

	getActionsContext(): any {
		return this.repository.provider;
	}

	private updateList(): void {
		const elements = this.repository.provider.resources
			.reduce<(ISCMResourceGroup | ISCMResource)[]>((r, g) => {
				if (g.resourceCollection.resources.length === 0 && g.hideWhenEmpty) {
					return r;
				}

				return [...r, g, ...g.resourceCollection.resources];
			}, []);

		this.list.splice(0, this.list.length, elements);
	}

	private open(e: ISCMResource): void {
		e.open().done(undefined, onUnexpectedError);
	}

	private pin(): void {
		const activeEditor = this.editorService.getActiveEditor();
		const activeEditorInput = this.editorService.getActiveEditorInput();
		this.editorGroupService.pinEditor(activeEditor.position, activeEditorInput);
	}

	private onListContextMenu(e: IListContextMenuEvent<ISCMResourceGroup | ISCMResource>): void {
		const element = e.element;
		let actions: IAction[];

		if (isSCMResource(element)) {
			actions = this.menus.getResourceContextActions(element);
		} else {
			actions = this.menus.getResourceGroupContextActions(element);
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => TPromise.as(actions),
			getActionsContext: () => element,
			actionRunner: new MultipleSelectionActionRunner(() => this.getSelectedResources())
		});
	}

	private getSelectedResources(): ISCMResource[] {
		return this.list.getSelectedElements()
			.filter(r => isSCMResource(r)) as ISCMResource[];
	}

	private updateInputBox(): void {
		if (typeof this.repository.provider.commitTemplate === 'undefined') {
			return;
		}

		this.inputBox.value = this.repository.provider.commitTemplate;
	}

	private onDidAcceptInput(): void {
		if (!this.repository.provider.acceptInputCommand) {
			return;
		}

		const id = this.repository.provider.acceptInputCommand.id;
		const args = this.repository.provider.acceptInputCommand.arguments;

		this.commandService.executeCommand(id, ...args)
			.done(undefined, onUnexpectedError);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}

class InstallAdditionalSCMProvidersAction extends Action {

	constructor( @IViewletService private viewletService: IViewletService) {
		super('scm.installAdditionalSCMProviders', localize('installAdditionalSCMProviders', "Install Additional SCM Providers..."), '', true);
	}

	run(): TPromise<void> {
		return this.viewletService.openViewlet(EXTENSIONS_VIEWLET_ID, true).then(viewlet => viewlet as IExtensionsViewlet)
			.then(viewlet => {
				viewlet.search('category:"SCM Providers" @sort:installs');
				viewlet.focus();
			});
	}
}

export class SCMViewlet extends PersistentViewsViewlet {

	private menus: SCMMenus;
	private repositoryToViewDescriptor = new Map<string, ProviderViewDescriptor>();
	private disposables: IDisposable[] = [];

	private combinedRepository: CombinedSCMRepository;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@ISCMService protected scmService: ISCMService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService protected contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IMessageService protected messageService: IMessageService,
		@IListService protected listService: IListService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IThemeService protected themeService: IThemeService,
		@ICommandService protected commandService: ICommandService,
		@IEditorGroupService protected editorGroupService: IEditorGroupService,
		@IWorkbenchEditorService protected editorService: IWorkbenchEditorService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IExtensionService extensionService: IExtensionService
	) {
		super(VIEWLET_ID, ViewLocation.SCM, 'scm', false,
			telemetryService, storageService, instantiationService, themeService, contextService, contextKeyService, contextMenuService, extensionService);

		this.menus = instantiationService.createInstance(SCMMenus, undefined);
		this.menus.onDidChangeTitle(this.updateTitleArea, this, this.disposables);

		if (ENABLE_SCM_COMBO) {
			this.combinedRepository = new CombinedSCMRepository('git', localize('combinedRepository', "Combined"), scmService.repositories);
			this.scmService.onDidAddRepository(r => this.combinedRepository.addRepository(r), this, this.disposables);
			this.scmService.onDidRemoveRepository(r => this.combinedRepository.removeRepository(r), this, this.disposables);
		}
	}

	private onDidAddRepository(repository: ISCMRepository): void {
		const viewDescriptor = new ProviderViewDescriptor(repository);
		this.repositoryToViewDescriptor.set(repository.provider.id, viewDescriptor);

		ViewsRegistry.registerViews([viewDescriptor]);
		toggleClass(this.getContainer().getHTMLElement(), 'empty', this.views.length === 0);
		this.updateTitleArea();
	}

	private onDidRemoveRepository(repository: ISCMRepository): void {
		const viewDescriptor = this.repositoryToViewDescriptor.get(repository.provider.id);
		this.repositoryToViewDescriptor.delete(repository.provider.id);
		viewDescriptor.dispose();

		ViewsRegistry.deregisterViews([viewDescriptor.id], ViewLocation.SCM);
		toggleClass(this.getContainer().getHTMLElement(), 'empty', this.views.length === 0);
		this.updateTitleArea();
	}

	async create(parent: Builder): TPromise<void> {
		await super.create(parent);

		parent.addClass('scm-viewlet', 'empty');
		append(parent.getHTMLElement(), $('div.empty-message', null, localize('no active repo', "There are no active repositories.")));

		this.scmService.onDidAddRepository(this.onDidAddRepository, this, this.disposables);
		this.scmService.onDidRemoveRepository(this.onDidRemoveRepository, this, this.disposables);
		this.scmService.repositories.forEach(p => this.onDidAddRepository(p));

		if (ENABLE_SCM_COMBO) {
			this.onDidAddRepository(this.combinedRepository);
		}

		ViewsRegistry.registerViews([new ProvidersViewDescriptor()]);
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible).then(() => {
			toggleClass(this.getContainer().getHTMLElement(), 'empty', this.views.length === 0);
		});
	}

	isRepositoryVisible(repository: ISCMRepository): boolean {
		const view = this.repositoryToViewDescriptor.get(repository.provider.id);
		return !!this.getView(view.id);
	}

	toggleRepositoryVisibility(repository: ISCMRepository, visible: boolean): void {
		const view = this.repositoryToViewDescriptor.get(repository.provider.id);
		this.toggleViewVisibility(view.id, visible);
	}

	setRepositoriesVisible(repositories: ISCMRepository[]) {
		this.repositoryToViewDescriptor.forEach(view => {
			const visible = repositories.indexOf(view.repository) !== -1;
			if (this.isVisible()) {
				this.toggleViewVisibility(view.id, visible);
			}
		});
	}

	getPendingChangesCount(repository: ISCMRepository): number {
		if (typeof repository.provider.count === 'number') {
			return repository.provider.count;
		}
		return repository.provider.resources.reduce<number>((r, g) => r + g.resourceCollection.resources.length, 0);
	}

	protected createView(viewDescriptor: IViewDescriptor, initialSize: number, options: IViewletViewOptions): IViewletView {
		if (viewDescriptor instanceof ProviderViewDescriptor) {
			return this.instantiationService.createInstance(ProviderView, initialSize, viewDescriptor.repository, options);
		} else if (viewDescriptor instanceof ProvidersViewDescriptor) {
			return this.instantiationService.createInstance(ProvidersView, initialSize, this, options);
		}

		return this.instantiationService.createInstance(viewDescriptor.ctor, initialSize, options);
	}

	protected getDefaultViewSize(): number | undefined {
		return this.dimension && this.dimension.height / Math.max(this.views.length, 1);
	}

	getOptimalWidth(): number {
		return 400;
	}

	getTitle(): string {
		const title = localize('source control', "Source Control");
		const views = ViewsRegistry.getViews(ViewLocation.SCM);

		if (views.length === 1) {
			const view = views[0];
			return localize('viewletTitle', "{0}: {1}", title, view.name);
		} else {
			return title;
		}
	}

	getActions(): IAction[] {
		if (this.showHeaderInTitleArea() && this.views.length === 1) {
			return this.views[0].getActions();
		}

		return this.menus.getTitleActions();
	}

	getSecondaryActions(): IAction[] {
		let result: IAction[];

		if (this.showHeaderInTitleArea() && this.views.length === 1) {
			result = [
				...this.views[0].getSecondaryActions(),
				new Separator()
			];
		} else {
			result = this.menus.getTitleSecondaryActions();

			if (result.length > 0) {
				result.push(new Separator());
			}
		}

		result.push(this.instantiationService.createInstance(InstallAdditionalSCMProvidersAction));

		return result;
	}

	getActionItem(action: IAction): IActionItem {
		if (!(action instanceof MenuItemAction)) {
			return undefined;
		}

		return new SCMMenuItemActionItem(action, this.keybindingService, this.messageService);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}
