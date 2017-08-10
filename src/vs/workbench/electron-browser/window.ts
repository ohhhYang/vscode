/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import platform = require('vs/base/common/platform');
import * as path from 'path';
import URI from 'vs/base/common/uri';
import errors = require('vs/base/common/errors');
import types = require('vs/base/common/types');
import { TPromise } from 'vs/base/common/winjs.base';
import { stat } from 'vs/base/node/pfs';
import arrays = require('vs/base/common/arrays');
import DOM = require('vs/base/browser/dom');
import Severity from 'vs/base/common/severity';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { IAction, Action } from 'vs/base/common/actions';
import { extractResources } from 'vs/base/browser/dnd';
import { Builder, $ } from 'vs/base/browser/builder';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { AutoSaveConfiguration } from 'vs/platform/files/common/files';
import { toResource } from 'vs/workbench/common/editor';
import { IWorkbenchEditorService, IResourceInputType } from 'vs/workbench/services/editor/common/editorService';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IMessageService } from 'vs/platform/message/common/message';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { IWindowsService, IWindowService, IWindowSettings, IPath, IOpenFileRequest, IWindowConfiguration, IWindowsConfiguration } from 'vs/platform/windows/common/windows';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IConfigurationEditingService, ConfigurationTarget } from 'vs/workbench/services/configuration/common/configurationEditing';
import { ITitleService } from 'vs/workbench/services/title/common/titleService';
import { IWorkbenchThemeService, VS_HC_THEME, VS_DARK_THEME } from 'vs/workbench/services/themes/common/workbenchThemeService';
import * as browser from 'vs/base/browser/browser';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { Position, IResourceInput, IUntitledResourceInput, IEditor } from 'vs/platform/editor/common/editor';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { KeyboardMapperFactory } from 'vs/workbench/services/keybinding/electron-browser/keybindingService';
import { Themable, EDITOR_DRAG_AND_DROP_BACKGROUND } from 'vs/workbench/common/theme';
import { ISCMRevision, ISCMService, setSCMProviderRevision } from 'vs/workbench/services/scm/common/scm';

import { ipcRenderer as ipc, webFrame } from 'electron';
import { activeContrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { extname } from "vs/base/common/paths";
import { WORKSPACE_EXTENSION } from "vs/platform/workspaces/common/workspaces";

const TextInputActions: IAction[] = [
	new Action('undo', nls.localize('undo', "Undo"), null, true, () => document.execCommand('undo') && TPromise.as(true)),
	new Action('redo', nls.localize('redo', "Redo"), null, true, () => document.execCommand('redo') && TPromise.as(true)),
	new Separator(),
	new Action('editor.action.clipboardCutAction', nls.localize('cut', "Cut"), null, true, () => document.execCommand('cut') && TPromise.as(true)),
	new Action('editor.action.clipboardCopyAction', nls.localize('copy', "Copy"), null, true, () => document.execCommand('copy') && TPromise.as(true)),
	new Action('editor.action.clipboardPasteAction', nls.localize('paste', "Paste"), null, true, () => document.execCommand('paste') && TPromise.as(true)),
	new Separator(),
	new Action('editor.action.selectAll', nls.localize('selectAll', "Select All"), null, true, () => document.execCommand('selectAll') && TPromise.as(true))
];

export class ElectronWindow extends Themable {

	private static AUTO_SAVE_SETTING = 'files.autoSave';

	constructor(
		shellContainer: HTMLElement,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IPartService private partService: IPartService,
		@IWindowsService private windowsService: IWindowsService,
		@IWindowService private windowService: IWindowService,
		@IWorkspaceConfigurationService private configurationService: IWorkspaceConfigurationService,
		@ITitleService private titleService: ITitleService,
		@IWorkbenchThemeService protected themeService: IWorkbenchThemeService,
		@IMessageService private messageService: IMessageService,
		@IConfigurationEditingService private configurationEditingService: IConfigurationEditingService,
		@ICommandService private commandService: ICommandService,
		@IExtensionService private extensionService: IExtensionService,
		@IViewletService private viewletService: IViewletService,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@ISCMService private scmService: ISCMService
	) {
		super(themeService);

		this.registerListeners();
		this.setup();
	}

	private registerListeners(): void {

		// React to editor input changes
		this.editorGroupService.onEditorsChanged(() => {
			const file = toResource(this.editorService.getActiveEditorInput(), { supportSideBySide: true, filter: 'file' });

			this.titleService.setRepresentedFilename(file ? file.fsPath : '');
		});

		let draggedExternalResources: URI[];
		let dropOverlay: Builder;

		function cleanUp(): void {
			draggedExternalResources = void 0;

			if (dropOverlay) {
				dropOverlay.destroy();
				dropOverlay = void 0;
			}
		}

		// Detect resources dropped into Code from outside
		window.document.body.addEventListener(DOM.EventType.DRAG_OVER, (e: DragEvent) => {
			DOM.EventHelper.stop(e);

			if (!draggedExternalResources) {
				draggedExternalResources = extractResources(e, true /* external only */).map(d => d.resource);

				// Find out if folders/workspaces are dragged and show the appropiate feedback then
				this.shouldOpenAsWorkspace(draggedExternalResources).done(openAsWorkspace => {
					if (openAsWorkspace) {
						const activeContrastBorderColor = this.getColor(activeContrastBorder);
						dropOverlay = $(window.document.getElementById(this.partService.getWorkbenchElementId()))
							.div({
								id: 'monaco-workbench-drop-overlay'
							})
							.style({
								backgroundColor: this.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND),
								outlineColor: activeContrastBorderColor,
								outlineOffset: activeContrastBorderColor ? '-2px' : null,
								outlineStyle: activeContrastBorderColor ? 'dashed' : null,
								outlineWidth: activeContrastBorderColor ? '2px' : null
							})
							.on(DOM.EventType.DROP, (e: DragEvent) => {
								DOM.EventHelper.stop(e, true);

								this.windowService.focusWindow(); // make sure this window has focus so that the open call reaches the right window!

								// Ask the user when opening a potential large number of folders
								let doOpen = true;
								if (draggedExternalResources.length > 20) {
									doOpen = this.messageService.confirm({
										message: nls.localize('confirmOpen', "Are you sure you want to open {0} workspaces?", draggedExternalResources.length),
										primaryButton: nls.localize({ key: 'confirmOpenButton', comment: ['&& denotes a mnemonic'] }, "&&Open"),
										type: 'question'
									});
								}

								if (doOpen) {
									this.windowsService.openWindow(draggedExternalResources.map(r => r.fsPath), { forceReuseWindow: true });
								}

								cleanUp();
							})
							.on([DOM.EventType.DRAG_LEAVE, DOM.EventType.DRAG_END], () => {
								cleanUp();
							}).once(DOM.EventType.MOUSE_OVER, () => {
								// Under some circumstances we have seen reports where the drop overlay is not being
								// cleaned up and as such the editor area remains under the overlay so that you cannot
								// type into the editor anymore. This seems related to using VMs and DND via host and
								// guest OS, though some users also saw it without VMs.
								// To protect against this issue we always destroy the overlay as soon as we detect a
								// mouse event over it. The delay is used to guarantee we are not interfering with the
								// actual DROP event that can also trigger a mouse over event.
								// See also: https://github.com/Microsoft/vscode/issues/10970
								setTimeout(() => {
									cleanUp();
								}, 300);
							});
					}
				});
			}
		});

		// Clear our map and overlay on any finish of DND outside the overlay
		[DOM.EventType.DROP, DOM.EventType.DRAG_END].forEach(event => {
			window.document.body.addEventListener(event, (e: DragEvent) => {
				if (!dropOverlay || e.target !== dropOverlay.getHTMLElement()) {
					cleanUp(); // only run cleanUp() if we are not over the overlay (because we are being called in capture phase)
				}
			}, true /* use capture because components within may preventDefault() when they accept the drop */);
		});

		// prevent opening a real URL inside the shell
		window.document.body.addEventListener(DOM.EventType.DROP, (e: DragEvent) => {
			DOM.EventHelper.stop(e);
		});

		// Handle window.open() calls
		const $this = this;
		(<any>window).open = function (url: string, target: string, features: string, replace: boolean) {
			$this.windowsService.openExternal(url);

			return null;
		};
	}

	private setup(): void {

		ipc.on('vscode:scm:setRevision', (event, revision: ISCMRevision) => {
			const scmProvider = this.scmService.activeProvider;
			setSCMProviderRevision(this.commandService, scmProvider, revision)
				.done(null, err => this.messageService.show(Severity.Error, err));
		});

		// Support runAction event
		ipc.on('vscode:runAction', (event, actionId: string) => {
			this.commandService.executeCommand(actionId, { from: 'menu' }).done(_ => {
				this.telemetryService.publicLog('commandExecuted', { id: actionId, from: 'menu' });
			}, err => {
				this.messageService.show(Severity.Error, err);
			});
		});

		// Support resolve keybindings event
		ipc.on('vscode:resolveKeybindings', (event, rawActionIds: string) => {
			let actionIds: string[] = [];
			try {
				actionIds = JSON.parse(rawActionIds);
			} catch (error) {
				// should not happen
			}

			// Resolve keys using the keybinding service and send back to browser process
			this.resolveKeybindings(actionIds).done(keybindings => {
				if (keybindings.length) {
					ipc.send('vscode:keybindingsResolved', JSON.stringify(keybindings));
				}
			}, () => errors.onUnexpectedError);
		});

		// Send over all extension viewlets when extensions are ready
		this.extensionService.onReady().then(() => {
			ipc.send('vscode:extensionViewlets', JSON.stringify(this.viewletService.getViewlets().filter(v => !!v.extensionId).map(v => { return { id: v.id, label: v.name }; })));
		});

		ipc.on('vscode:reportError', (event, error) => {
			if (error) {
				const errorParsed = JSON.parse(error);
				errorParsed.mainProcess = true;
				errors.onUnexpectedError(errorParsed);
			}
		});

		// Support openFiles event for existing and new files
		ipc.on('vscode:openFiles', (event, request: IOpenFileRequest) => this.onOpenFiles(request));

		// Emit event when vscode has loaded
		this.partService.joinCreation().then(() => {
			ipc.send('vscode:workbenchLoaded', this.windowService.getCurrentWindowId());
		});

		// Message support
		ipc.on('vscode:showInfoMessage', (event, message: string) => {
			this.messageService.show(Severity.Info, message);
		});

		// Support toggling auto save
		ipc.on('vscode.toggleAutoSave', event => {
			this.toggleAutoSave();
		});

		// Fullscreen Events
		ipc.on('vscode:enterFullScreen', event => {
			this.partService.joinCreation().then(() => {
				browser.setFullscreen(true);
			});
		});

		ipc.on('vscode:leaveFullScreen', event => {
			this.partService.joinCreation().then(() => {
				browser.setFullscreen(false);
			});
		});

		// High Contrast Events
		ipc.on('vscode:enterHighContrast', event => {
			const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
			if (windowConfig && windowConfig.autoDetectHighContrast) {
				this.partService.joinCreation().then(() => {
					this.themeService.setColorTheme(VS_HC_THEME, null);
				});
			}
		});

		ipc.on('vscode:leaveHighContrast', event => {
			const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
			if (windowConfig && windowConfig.autoDetectHighContrast) {
				this.partService.joinCreation().then(() => {
					this.themeService.setColorTheme(VS_DARK_THEME, null);
				});
			}
		});

		// keyboard layout changed event
		ipc.on('vscode:keyboardLayoutChanged', (event, isISOKeyboard: boolean) => {
			KeyboardMapperFactory.INSTANCE._onKeyboardLayoutChanged(isISOKeyboard);
		});

		// keyboard layout changed event
		ipc.on('vscode:accessibilitySupportChanged', (event, accessibilitySupportEnabled: boolean) => {
			browser.setAccessibilitySupport(accessibilitySupportEnabled ? platform.AccessibilitySupport.Enabled : platform.AccessibilitySupport.Disabled);
		});

		// Configuration changes
		let previousConfiguredZoomLevel: number;
		this.configurationService.onDidUpdateConfiguration(e => {
			const windowConfig: IWindowsConfiguration = this.configurationService.getConfiguration<IWindowsConfiguration>();

			let newZoomLevel = 0;
			if (windowConfig.window && typeof windowConfig.window.zoomLevel === 'number') {
				newZoomLevel = windowConfig.window.zoomLevel;

				// Leave early if the configured zoom level did not change (https://github.com/Microsoft/vscode/issues/1536)
				if (previousConfiguredZoomLevel === newZoomLevel) {
					return;
				}

				previousConfiguredZoomLevel = newZoomLevel;
			}

			if (webFrame.getZoomLevel() !== newZoomLevel) {
				webFrame.setZoomLevel(newZoomLevel);
				browser.setZoomFactor(webFrame.getZoomFactor());
				// See https://github.com/Microsoft/vscode/issues/26151
				// Cannot be trusted because the webFrame might take some time
				// until it really applies the new zoom level
				browser.setZoomLevel(webFrame.getZoomLevel(), /*isTrusted*/false);
			}
		});

		// Context menu support in input/textarea
		window.document.addEventListener('contextmenu', e => {
			if (e.target instanceof HTMLElement) {
				const target = <HTMLElement>e.target;
				if (target.nodeName && (target.nodeName.toLowerCase() === 'input' || target.nodeName.toLowerCase() === 'textarea')) {
					e.preventDefault();
					e.stopPropagation();

					this.contextMenuService.showContextMenu({
						getAnchor: () => e,
						getActions: () => TPromise.as(TextInputActions)
					});
				}
			}
		});
	}

	private resolveKeybindings(actionIds: string[]): TPromise<{ id: string; label: string, isNative: boolean; }[]> {
		return this.partService.joinCreation().then(() => {
			return arrays.coalesce(actionIds.map(id => {
				const binding = this.keybindingService.lookupKeybinding(id);
				if (!binding) {
					return null;
				}

				// first try to resolve a native accelerator
				const electronAccelerator = binding.getElectronAccelerator();
				if (electronAccelerator) {
					return { id, label: electronAccelerator, isNative: true };
				}

				// we need this fallback to support keybindings that cannot show in electron menus (e.g. chords)
				const acceleratorLabel = binding.getLabel();
				if (acceleratorLabel) {
					return { id, label: acceleratorLabel, isNative: false };
				}

				return null;
			}));
		});
	}

	private onOpenFiles(request: IOpenFileRequest): void {
		if (request.filesToOpen.length > 0) {
			// Check to see if the URI for this resource has a mapping a local
			// repo stored. If so, open that file locally.
			const repoMappings: { [key: string]: string } = this.configurationService.getConfiguration('repo')['mappings'] || {};
			for (let f of request.filesToOpen) {
				const fileToOpen = f as IWindowConfiguration;
				const folder = fileToOpen.folderPath;
				const file = fileToOpen.filePath.replace(folder, '');
				const uri = folder.replace('repo://', '');
				if (repoMappings[uri]) {
					const fsPath = repoMappings[uri];
					fileToOpen.filePath = `file://${path.join(fsPath, file)}`;
					fileToOpen.folderPath = `file://${fsPath}`;
				}
			}
		}

		let inputs: IResourceInputType[] = [];
		let diffMode = (request.filesToDiff.length === 2);

		if (!diffMode && request.filesToOpen) {
			inputs.push(...this.toInputs(request.filesToOpen, false));
		}

		if (!diffMode && request.filesToCreate) {
			inputs.push(...this.toInputs(request.filesToCreate, true));
		}

		if (diffMode) {
			inputs.push(...this.toInputs(request.filesToDiff, false));
		}

		if (inputs.length) {
			this.openResources(inputs, diffMode).done(null, errors.onUnexpectedError);
		}
	}

	private openResources(resources: (IResourceInput | IUntitledResourceInput)[], diffMode: boolean): TPromise<IEditor | IEditor[]> {
		return this.partService.joinCreation().then((): TPromise<IEditor | IEditor[]> => {


			// In diffMode we open 2 resources as diff
			if (diffMode && resources.length === 2) {
				return this.editorService.openEditor({ leftResource: resources[0].resource, rightResource: resources[1].resource, options: { pinned: true } });
			}

			// For one file, just put it into the current active editor
			if (resources.length === 1) {
				return this.editorService.openEditor(resources[0]);
			}

			// Otherwise open all
			const activeEditor = this.editorService.getActiveEditor();
			return this.editorService.openEditors(resources.map((r, index) => {
				return {
					input: r,
					position: activeEditor ? activeEditor.position : Position.ONE
				};
			}));
		});
	}

	private toInputs(paths: IPath[], isNew: boolean): IResourceInputType[] {
		return paths.map(p => {
			const resource = URI.parse(p.filePath);
			let input: IResourceInput | IUntitledResourceInput;
			if (isNew) {
				input = { filePath: resource.fsPath, options: { pinned: true } } as IUntitledResourceInput;
			} else {
				input = { resource, options: { pinned: true } } as IResourceInput;
			}

			if (!isNew && p.lineNumber) {
				input.options.selection = {
					startLineNumber: p.lineNumber,
					startColumn: p.columnNumber
				};
			}

			return input;
		});
	}

	private toggleAutoSave(): void {
		const setting = this.configurationService.lookup(ElectronWindow.AUTO_SAVE_SETTING);
		let userAutoSaveConfig = setting.user;
		if (types.isUndefinedOrNull(userAutoSaveConfig)) {
			userAutoSaveConfig = setting.default; // use default if setting not defined
		}

		let newAutoSaveValue: string;
		if ([AutoSaveConfiguration.AFTER_DELAY, AutoSaveConfiguration.ON_FOCUS_CHANGE, AutoSaveConfiguration.ON_WINDOW_CHANGE].some(s => s === userAutoSaveConfig)) {
			newAutoSaveValue = AutoSaveConfiguration.OFF;
		} else {
			newAutoSaveValue = AutoSaveConfiguration.AFTER_DELAY;
		}

		this.configurationEditingService.writeConfiguration(ConfigurationTarget.USER, { key: ElectronWindow.AUTO_SAVE_SETTING, value: newAutoSaveValue });
	}

	private shouldOpenAsWorkspace(resources: URI[]): TPromise<boolean> {
		return TPromise.join(resources.map(resource => {
			if (extname(resource.fsPath) === `.${WORKSPACE_EXTENSION}`) {
				return TPromise.as(true); // Workspace
			}

			// Check for Folder
			return stat(resource.fsPath).then(stats => stats.isDirectory() ? true : false, error => false);
		})).then(res => res.some(res => !!res));
	}
}
