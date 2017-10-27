/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import { KeyMod, KeyChord, KeyCode } from 'vs/base/common/keyCodes';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { CommonEditorRegistry } from 'vs/editor/common/editorCommonExtensions';
import { NoEditorsVisibleContext, InZenModeContext } from 'vs/workbench/electron-browser/workbench';
import { IWindowsService, IWindowService } from 'vs/platform/windows/common/windows';
import { IListService, ListFocusContext } from 'vs/platform/list/browser/listService';
import { List } from 'vs/base/browser/ui/list/listWidget';
import errors = require('vs/base/common/errors');
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import URI from 'vs/base/common/uri';
import { IEditorOptions, Position as EditorPosition } from 'vs/platform/editor/common/editor';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IRemoteService, requestGraphQL } from 'vs/platform/remote/node/remote';
import { openFolderCommand, openFileInNewWindowCommand, openFileFolderInNewWindowCommand, openFolderInNewWindowCommand, openWorkspaceInNewWindowCommand } from 'vs/workbench/browser/actions/workspaceActions';

// --- List Commands

export function registerCommands(): void {

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusDown',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.DownArrow,
		mac: {
			primary: KeyCode.DownArrow,
			secondary: [KeyMod.WinCtrl | KeyCode.KEY_N]
		},
		handler: (accessor, arg2) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();
			const count = typeof arg2 === 'number' ? arg2 : 1;

			// List
			if (focused instanceof List) {
				const list = focused;

				list.focusNext(count);
				list.reveal(list.getFocus()[0]);
			}

			// Tree
			else if (focused) {
				const tree = focused;

				tree.focusNext(count, { origin: 'keyboard' });
				tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusUp',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.UpArrow,
		mac: {
			primary: KeyCode.UpArrow,
			secondary: [KeyMod.WinCtrl | KeyCode.KEY_P]
		},
		handler: (accessor, arg2) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();
			const count = typeof arg2 === 'number' ? arg2 : 1;

			// List
			if (focused instanceof List) {
				const list = focused;

				list.focusPrevious(count);
				list.reveal(list.getFocus()[0]);
			}

			// Tree
			else if (focused) {
				const tree = focused;

				tree.focusPrevious(count, { origin: 'keyboard' });
				tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.collapse',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.LeftArrow,
		mac: {
			primary: KeyCode.LeftArrow,
			secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow]
		},
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// Tree only
			if (focused && !(focused instanceof List)) {
				const tree = focused;
				const focus = tree.getFocus();

				tree.collapse(focus).then(didCollapse => {
					if (focus && !didCollapse) {
						tree.focusParent({ origin: 'keyboard' });

						return tree.reveal(tree.getFocus());
					}

					return void 0;
				}).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.expand',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.RightArrow,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// Tree only
			if (focused && !(focused instanceof List)) {
				const tree = focused;
				const focus = tree.getFocus();

				tree.expand(focus).then(didExpand => {
					if (focus && !didExpand) {
						tree.focusFirstChild({ origin: 'keyboard' });

						return tree.reveal(tree.getFocus());
					}

					return void 0;
				}).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusPageUp',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.PageUp,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// List
			if (focused instanceof List) {
				const list = focused;

				list.focusPreviousPage();
				list.reveal(list.getFocus()[0]);
			}

			// Tree
			else if (focused) {
				const tree = focused;

				tree.focusPreviousPage({ origin: 'keyboard' });
				tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusPageDown',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.PageDown,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// List
			if (focused instanceof List) {
				const list = focused;

				list.focusNextPage();
				list.reveal(list.getFocus()[0]);
			}

			// Tree
			else if (focused) {
				const tree = focused;

				tree.focusNextPage({ origin: 'keyboard' });
				tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusFirst',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.Home,
		handler: accessor => listFocusFirst(accessor)
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusFirstChild',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: null,
		handler: accessor => listFocusFirst(accessor, { fromFocused: true })
	});

	function listFocusFirst(accessor: ServicesAccessor, options?: { fromFocused: boolean }): void {
		const listService = accessor.get(IListService);
		const focused = listService.getFocused();

		// List
		if (focused instanceof List) {
			const list = focused;

			list.setFocus([0]);
			list.reveal(0);
		}

		// Tree
		else if (focused) {
			const tree = focused;

			tree.focusFirst({ origin: 'keyboard' }, options && options.fromFocused ? tree.getFocus() : void 0);
			tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
		}
	}

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusLast',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.End,
		handler: accessor => listFocusLast(accessor)
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.focusLastChild',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: null,
		handler: accessor => listFocusLast(accessor, { fromFocused: true })
	});

	function listFocusLast(accessor: ServicesAccessor, options?: { fromFocused: boolean }): void {
		const listService = accessor.get(IListService);
		const focused = listService.getFocused();

		// List
		if (focused instanceof List) {
			const list = focused;

			list.setFocus([list.length - 1]);
			list.reveal(list.length - 1);
		}

		// Tree
		else if (focused) {
			const tree = focused;

			tree.focusLast({ origin: 'keyboard' }, options && options.fromFocused ? tree.getFocus() : void 0);
			tree.reveal(tree.getFocus()).done(null, errors.onUnexpectedError);
		}
	}

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.select',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.Enter,
		secondary: [KeyMod.CtrlCmd | KeyCode.Enter],
		mac: {
			primary: KeyCode.Enter,
			secondary: [KeyMod.CtrlCmd | KeyCode.Enter, KeyMod.CtrlCmd | KeyCode.DownArrow]
		},
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// List
			if (focused instanceof List) {
				const list = focused;
				list.setSelection(list.getFocus());
				list.open(list.getFocus());
			}

			// Tree
			else if (focused) {
				const tree = focused;
				const focus = tree.getFocus();

				if (focus) {
					tree.setSelection([focus], { origin: 'keyboard' });
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.toggleExpand',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.Space,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// Tree only
			if (focused && !(focused instanceof List)) {
				const tree = focused;
				const focus = tree.getFocus();

				if (focus) {
					tree.toggleExpansion(focus);
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'list.clear',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ListFocusContext,
		primary: KeyCode.Escape,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const focused = listService.getFocused();

			// Tree only
			if (focused && !(focused instanceof List)) {
				const tree = focused;

				if (tree.getSelection().length) {
					tree.clearSelection({ origin: 'keyboard' });

					return void 0;
				}

				if (tree.getFocus()) {
					tree.clearFocus({ origin: 'keyboard' });

					return void 0;
				}
			}
		}
	});

	// --- commands

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'workbench.action.closeWindow', // close the window when the last editor is closed by reusing the same keybinding
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: NoEditorsVisibleContext,
		primary: KeyMod.CtrlCmd | KeyCode.KEY_W,
		handler: accessor => {
			const windowService = accessor.get(IWindowService);
			windowService.closeWindow();
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'workbench.action.exitZenMode',
		weight: CommonEditorRegistry.commandWeight(-1000),
		handler(accessor: ServicesAccessor, configurationOrName: any) {
			const partService = accessor.get(IPartService);
			partService.toggleZenMode();
		},
		when: InZenModeContext,
		primary: KeyChord(KeyCode.Escape, KeyCode.Escape)
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'workbench.action.quit',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		handler(accessor: ServicesAccessor) {
			const windowsService = accessor.get(IWindowsService);
			windowsService.quit();
		},
		when: void 0,
		primary: KeyMod.CtrlCmd | KeyCode.KEY_Q,
		win: { primary: void 0 }
	});

	CommandsRegistry.registerCommand('_workbench.diff', function (accessor: ServicesAccessor, args: [URI, URI, string, string, IEditorOptions, EditorPosition]) {
		const editorService = accessor.get(IWorkbenchEditorService);
		let [leftResource, rightResource, label, description, options, position] = args;

		if (!options || typeof options !== 'object') {
			options = {
				preserveFocus: false
			};
		}

		if (!label) {
			label = nls.localize('diffLeftRightLabel', "{0} ⟷ {1}", leftResource.toString(true), rightResource.toString(true));
		}

		return editorService.openEditor({ leftResource, rightResource, label, description, options }, position).then(() => {
			return void 0;
		});
	});

	CommandsRegistry.registerCommand('_workbench.open', function (accessor: ServicesAccessor, args: [URI, number]) {
		const editorService = accessor.get(IWorkbenchEditorService);
		const [resource, column] = args;

		return editorService.openEditor({ resource }, column).then(() => {
			return void 0;
		});
	});

	CommandsRegistry.registerCommand('_workbench.addRoots', function (accessor: ServicesAccessor, foldersToAdd: URI[]) {
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);
		const configurationService = accessor.get(IConfigurationService);

		return workspaceEditingService.addFolders(foldersToAdd.map(uri => ({ uri }))).then(() => {
			// Wait for workspace to reload and detect its newly added root.
			return configurationService.reloadConfiguration();
		});
	});

	CommandsRegistry.registerCommand('_workbench.getDependents', function (accessor: ServicesAccessor, lang: string, pkgData: { [k: string]: string }) {
		const remoteService = accessor.get(IRemoteService);

		const otherArgs: string[] = [];
		for (let k of Object.keys(pkgData)) {
			otherArgs.push(`, ${k}: ${JSON.stringify(pkgData[k])}`);
		}

		return requestGraphQL<any>(remoteService, `query ($lang: String!, $id: String, $type: String, $name: String, $commit: String, $baseDir: String, $repoURL: String, $version: String, $package: String, $limit: Int) {
			root {
				dependents(lang: $lang, id: $id, type: $type, name: $name, commit: $commit, baseDir: $baseDir, repoURL: $repoURL, version: $version, package: $package, limit: $limit) {
					id
					type
					name
					commit
					repoURL
					version
					repo {
						id
						uri
						description
						language
						fork
					}
				}
			}
		}`, {
				lang: lang,
				limit: 10,
				...pkgData
			},
		).then(data => data.dependents);
	});

	CommandsRegistry.registerCommand('_files.pickFolderAndOpen', openFolderCommand);

	CommandsRegistry.registerCommand('workbench.action.files.openFileInNewWindow', openFileInNewWindowCommand);
	CommandsRegistry.registerCommand('workbench.action.files.openFolderInNewWindow', openFolderInNewWindowCommand);
	CommandsRegistry.registerCommand('workbench.action.files.openFileFolderInNewWindow', openFileFolderInNewWindowCommand);
	CommandsRegistry.registerCommand('workbench.action.openWorkspaceInNewWindow', openWorkspaceInNewWindowCommand);
}
