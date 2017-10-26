/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Dimension, Builder } from 'vs/base/browser/builder';
import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import { Part } from 'vs/workbench/browser/part';
import { QuickOpenController } from 'vs/workbench/browser/parts/quickopen/quickOpenController';
import { Sash, ISashEvent, IVerticalSashLayoutProvider, IHorizontalSashLayoutProvider, Orientation } from 'vs/base/browser/ui/sash/sash';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IPartService, Position, Parts } from 'vs/workbench/services/part/common/partService';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { getZoomFactor } from 'vs/base/browser/browser';
import { IThemeService } from 'vs/platform/theme/common/themeService';

const MIN_SIDEBAR_PART_WIDTH = 170;
const MIN_EDITOR_PART_HEIGHT = 70;
const MIN_EDITOR_PART_WIDTH = 220;
const MIN_PANEL_PART_HEIGHT = 77;
const MIN_PANEL_PART_WIDTH = 300;
const DEFAULT_PANEL_SIZE_COEFFICIENT = 0.4;
const HIDE_SIDEBAR_WIDTH_THRESHOLD = 50;
const HIDE_PANEL_HEIGHT_THRESHOLD = 50;
const HIDE_PANEL_WIDTH_THRESHOLD = 100;
const TITLE_BAR_HEIGHT = 22;
const NAV_BAR_HEIGHT = 30;
const STATUS_BAR_HEIGHT = 22;
const CONTEXT_BAR_HEIGHT = 25;
const ACTIVITY_BAR_WIDTH = 50;

interface PartLayoutInfo {
	titlebar: { height: number; };
	navbar: { height: number };
	activitybar: { width: number; };
	sidebar: { minWidth: number; };
	panel: { minHeight: number; minWidth: number; };
	editor: { minWidth: number; minHeight: number; };
	statusbar: { height: number; };
	contextbar: { height: number; };
}

/**
 * The workbench layout is responsible to lay out all parts that make the Workbench.
 */
export class WorkbenchLayout implements IVerticalSashLayoutProvider, IHorizontalSashLayoutProvider {

	private static sashXOneWidthSettingsKey = 'workbench.sidebar.width';
	private static sashXTwoWidthSettingsKey = 'workbench.panel.width';
	private static sashYHeightSettingsKey = 'workbench.panel.height';

	private parent: Builder;
	private workbenchContainer: Builder;
	private titlebar: Part;
	private navbar: Part;
	private activitybar: Part;
	private editor: Part;
	private sidebar: Part;
	private panel: Part;
	private statusbar: Part;
	private contextbar: Part;
	private quickopen: QuickOpenController;
	private toUnbind: IDisposable[];
	private partLayoutInfo: PartLayoutInfo;
	private workbenchSize: Dimension;
	private sashXOne: Sash;
	private sashXTwo: Sash;
	private sashY: Sash;
	private _sidebarWidth: number;
	private sidebarHeight: number;
	private titlebarHeight: number;
	private contextbarHeight: number;
	private navbarHeight: number;
	private statusbarHeight: number;
	private _panelHeight: number;
	private _panelWidth: number;
	private layoutEditorGroupsVertically: boolean;

	// Take parts as an object bag since instatation service does not have typings for constructors with 9+ arguments
	constructor(
		parent: Builder,
		workbenchContainer: Builder,
		parts: {
			titlebar: Part,
			navbar: Part,
			activitybar: Part,
			editor: Part,
			sidebar: Part,
			panel: Part,
			statusbar: Part,
			contextbar: Part,
		},
		quickopen: QuickOpenController,
		@IStorageService private storageService: IStorageService,
		@IContextViewService private contextViewService: IContextViewService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IPartService private partService: IPartService,
		@IViewletService private viewletService: IViewletService,
		@IThemeService themeService: IThemeService
	) {
		this.parent = parent;
		this.workbenchContainer = workbenchContainer;
		this.titlebar = parts.titlebar;
		this.navbar = parts.navbar;
		this.activitybar = parts.activitybar;
		this.editor = parts.editor;
		this.sidebar = parts.sidebar;
		this.panel = parts.panel;
		this.statusbar = parts.statusbar;
		this.contextbar = parts.contextbar;
		this.quickopen = quickopen;
		this.toUnbind = [];
		this.partLayoutInfo = this.getPartLayoutInfo();

		this.sashXOne = new Sash(this.workbenchContainer.getHTMLElement(), this, {
			baseSize: 5
		});

		this.sashXTwo = new Sash(this.workbenchContainer.getHTMLElement(), this, {
			baseSize: 5
		});

		this.sashY = new Sash(this.workbenchContainer.getHTMLElement(), this, {
			baseSize: 4,
			orientation: Orientation.HORIZONTAL
		});

		this._sidebarWidth = this.storageService.getInteger(WorkbenchLayout.sashXOneWidthSettingsKey, StorageScope.GLOBAL, -1);
		this._panelHeight = this.storageService.getInteger(WorkbenchLayout.sashYHeightSettingsKey, StorageScope.GLOBAL, 0);
		this._panelWidth = this.storageService.getInteger(WorkbenchLayout.sashXTwoWidthSettingsKey, StorageScope.GLOBAL, 0);

		this.layoutEditorGroupsVertically = (this.editorGroupService.getGroupOrientation() !== 'horizontal');

		this.toUnbind.push(themeService.onThemeChange(_ => this.layout()));
		this.toUnbind.push(editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
		this.toUnbind.push(editorGroupService.onGroupOrientationChanged(e => this.onGroupOrientationChanged()));

		this.registerSashListeners();
	}

	private get activitybarWidth(): number {
		if (this.partService.isVisible(Parts.ACTIVITYBAR_PART)) {
			return this.partLayoutInfo.activitybar.width;
		}

		return 0;
	}

	private get panelHeight(): number {
		const panelPosition = this.partService.getPanelPosition();
		if (panelPosition === Position.RIGHT) {
			return this.sidebarHeight;
		}

		return this._panelHeight;
	}

	private set panelHeight(value: number) {
		const editorCountForHeight = this.editorGroupService.getGroupOrientation() === 'horizontal' ? this.editorGroupService.getStacksModel().groups.length : 1;
		const maxPanelHeight = this.sidebarHeight - editorCountForHeight * MIN_EDITOR_PART_HEIGHT;
		this._panelHeight = Math.min(maxPanelHeight, Math.max(this.partLayoutInfo.panel.minHeight, value));
	}

	private get panelWidth(): number {
		const panelPosition = this.partService.getPanelPosition();
		if (panelPosition === Position.BOTTOM) {
			return this.workbenchSize.width - this.activitybarWidth - this.sidebarWidth;
		}

		return this._panelWidth;
	}

	private set panelWidth(value: number) {
		const editorCountForWidth = this.editorGroupService.getGroupOrientation() === 'vertical' ? this.editorGroupService.getStacksModel().groups.length : 1;
		const maxPanelWidth = this.workbenchSize.width - editorCountForWidth * MIN_EDITOR_PART_WIDTH - this.sidebarWidth - this.activitybarWidth;
		this._panelWidth = Math.min(maxPanelWidth, Math.max(this.partLayoutInfo.panel.minWidth, value));
	}

	private get sidebarWidth(): number {
		if (this.partService.isVisible(Parts.SIDEBAR_PART)) {
			return this._sidebarWidth;
		}

		return 0;
	}

	private set sidebarWidth(value: number) {
		const editorCountForWidth = this.editorGroupService.getGroupOrientation() === 'vertical' ? this.editorGroupService.getStacksModel().groups.length : 1;
		const panelMinWidth = this.partService.getPanelPosition() === Position.RIGHT && this.partService.isVisible(Parts.PANEL_PART) ? MIN_PANEL_PART_WIDTH : 0;
		const maxSidebarWidth = this.workbenchSize.width - this.activitybarWidth - editorCountForWidth * MIN_EDITOR_PART_WIDTH - panelMinWidth;
		this._sidebarWidth = Math.min(maxSidebarWidth, Math.max(this.partLayoutInfo.sidebar.minWidth, value));
	}

	private getPartLayoutInfo(): PartLayoutInfo {
		return {
			titlebar: {
				height: TITLE_BAR_HEIGHT
			},
			navbar: {
				height: NAV_BAR_HEIGHT,
			},
			activitybar: {
				width: ACTIVITY_BAR_WIDTH
			},
			sidebar: {
				minWidth: MIN_SIDEBAR_PART_WIDTH
			},
			panel: {
				minHeight: MIN_PANEL_PART_HEIGHT,
				minWidth: MIN_PANEL_PART_WIDTH
			},
			editor: {
				minWidth: MIN_EDITOR_PART_WIDTH,
				minHeight: MIN_EDITOR_PART_HEIGHT
			},
			statusbar: {
				height: STATUS_BAR_HEIGHT
			},
			contextbar: {
				height: CONTEXT_BAR_HEIGHT
			},
		};
	}

	private registerSashListeners(): void {
		let startX: number = 0;
		let startY: number = 0;
		let startXTwo: number = 0;
		let startSidebarWidth: number;
		let startPanelHeight: number;
		let startPanelWidth: number;

		this.toUnbind.push(this.sashXOne.addListener('start', (e: ISashEvent) => {
			startSidebarWidth = this.sidebarWidth;
			startX = e.startX;
		}));

		this.toUnbind.push(this.sashY.addListener('start', (e: ISashEvent) => {
			startPanelHeight = this.panelHeight;
			startY = e.startY;
		}));

		this.toUnbind.push(this.sashXTwo.addListener('start', (e: ISashEvent) => {
			startPanelWidth = this.panelWidth;
			startXTwo = e.startX;
		}));

		this.toUnbind.push(this.sashXOne.addListener('change', (e: ISashEvent) => {
			let doLayout = false;
			let sidebarPosition = this.partService.getSideBarPosition();
			let isSidebarVisible = this.partService.isVisible(Parts.SIDEBAR_PART);
			let newSashWidth = (sidebarPosition === Position.LEFT) ? startSidebarWidth + e.currentX - startX : startSidebarWidth - e.currentX + startX;
			let promise = TPromise.as<void>(null);

			// Sidebar visible
			if (isSidebarVisible) {

				// Automatically hide side bar when a certain threshold is met
				if (newSashWidth + HIDE_SIDEBAR_WIDTH_THRESHOLD < this.partLayoutInfo.sidebar.minWidth) {
					let dragCompensation = MIN_SIDEBAR_PART_WIDTH - HIDE_SIDEBAR_WIDTH_THRESHOLD;
					promise = this.partService.setSideBarHidden(true);
					startX = (sidebarPosition === Position.LEFT) ? Math.max(this.activitybarWidth, e.currentX - dragCompensation) : Math.min(e.currentX + dragCompensation, this.workbenchSize.width - this.activitybarWidth);
					this.sidebarWidth = startSidebarWidth; // when restoring sidebar, restore to the sidebar width we started from
				}

				// Otherwise size the sidebar accordingly
				else {
					this.sidebarWidth = Math.max(this.partLayoutInfo.sidebar.minWidth, newSashWidth); // Sidebar can not become smaller than MIN_PART_WIDTH
					doLayout = newSashWidth >= this.partLayoutInfo.sidebar.minWidth;
				}
			}

			// Sidebar hidden
			else {
				if ((sidebarPosition === Position.LEFT && e.currentX - startX >= this.partLayoutInfo.sidebar.minWidth) ||
					(sidebarPosition === Position.RIGHT && startX - e.currentX >= this.partLayoutInfo.sidebar.minWidth)) {
					startSidebarWidth = this.partLayoutInfo.sidebar.minWidth - (sidebarPosition === Position.LEFT ? e.currentX - startX : startX - e.currentX);
					this.sidebarWidth = this.partLayoutInfo.sidebar.minWidth;
					promise = this.partService.setSideBarHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout(), errors.onUnexpectedError);
			}
		}));

		this.toUnbind.push(this.sashY.addListener('change', (e: ISashEvent) => {
			let doLayout = false;
			let isPanelVisible = this.partService.isVisible(Parts.PANEL_PART);
			let newSashHeight = startPanelHeight - (e.currentY - startY);
			let promise = TPromise.as<void>(null);

			// Panel visible
			if (isPanelVisible) {

				// Automatically hide panel when a certain threshold is met
				if (newSashHeight + HIDE_PANEL_HEIGHT_THRESHOLD < this.partLayoutInfo.panel.minHeight) {
					let dragCompensation = MIN_PANEL_PART_HEIGHT - HIDE_PANEL_HEIGHT_THRESHOLD;
					promise = this.partService.setPanelHidden(true);
					const sourcegraphHeight = this.contextbarHeight + this.navbarHeight; // Sourcegraph additions
					startY = Math.min(this.sidebarHeight - this.statusbarHeight - this.titlebarHeight - sourcegraphHeight, e.currentY + dragCompensation);
					this.panelHeight = startPanelHeight; // when restoring panel, restore to the panel height we started from
				}

				// Otherwise size the panel accordingly
				else {
					this.panelHeight = Math.max(this.partLayoutInfo.panel.minHeight, newSashHeight); // Panel can not become smaller than MIN_PART_HEIGHT
					doLayout = newSashHeight >= this.partLayoutInfo.panel.minHeight;
				}
			}

			// Panel hidden
			else {
				if (startY - e.currentY >= this.partLayoutInfo.panel.minHeight) {
					startPanelHeight = 0;
					this.panelHeight = this.partLayoutInfo.panel.minHeight;
					promise = this.partService.setPanelHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout(), errors.onUnexpectedError);
			}
		}));

		this.toUnbind.push(this.sashXTwo.addListener('change', (e: ISashEvent) => {
			let doLayout = false;
			let isPanelVisible = this.partService.isVisible(Parts.PANEL_PART);
			let newSashWidth = startPanelWidth - (e.currentX - startXTwo);
			let promise = TPromise.as<void>(null);

			// Panel visible
			if (isPanelVisible) {

				// Automatically hide panel when a certain threshold is met
				if (newSashWidth + HIDE_PANEL_WIDTH_THRESHOLD < this.partLayoutInfo.panel.minWidth) {
					let dragCompensation = MIN_PANEL_PART_WIDTH - HIDE_PANEL_WIDTH_THRESHOLD;
					promise = this.partService.setPanelHidden(true);
					startXTwo = Math.min(this.workbenchSize.width - this.activitybarWidth, e.currentX + dragCompensation);
					this.panelWidth = startPanelWidth; // when restoring panel, restore to the panel height we started from
				}

				// Otherwise size the panel accordingly
				else {
					this.panelWidth = newSashWidth;
					doLayout = newSashWidth >= this.partLayoutInfo.panel.minWidth;
				}
			}

			// Panel hidden
			else {
				if (startXTwo - e.currentX >= this.partLayoutInfo.panel.minWidth) {
					startPanelWidth = 0;
					this.panelWidth = this.partLayoutInfo.panel.minWidth;
					promise = this.partService.setPanelHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout(), errors.onUnexpectedError);
			}
		}));

		this.toUnbind.push(this.sashXOne.addListener('end', () => {
			this.storageService.store(WorkbenchLayout.sashXOneWidthSettingsKey, this.sidebarWidth, StorageScope.GLOBAL);
		}));

		this.toUnbind.push(this.sashY.addListener('end', () => {
			this.storageService.store(WorkbenchLayout.sashYHeightSettingsKey, this.panelHeight, StorageScope.GLOBAL);
		}));

		this.toUnbind.push(this.sashXTwo.addListener('end', () => {
			this.storageService.store(WorkbenchLayout.sashXTwoWidthSettingsKey, this.panelWidth, StorageScope.GLOBAL);
		}));

		this.toUnbind.push(this.sashY.addListener('reset', () => {
			this.panelHeight = this.sidebarHeight * DEFAULT_PANEL_SIZE_COEFFICIENT;
			this.storageService.store(WorkbenchLayout.sashYHeightSettingsKey, this.panelHeight, StorageScope.GLOBAL);
			this.layout();
		}));

		this.toUnbind.push(this.sashXOne.addListener('reset', () => {
			let activeViewlet = this.viewletService.getActiveViewlet();
			let optimalWidth = activeViewlet && activeViewlet.getOptimalWidth();
			this.sidebarWidth = optimalWidth || 0;
			this.storageService.store(WorkbenchLayout.sashXOneWidthSettingsKey, this.sidebarWidth, StorageScope.GLOBAL);
			this.partService.setSideBarHidden(false).done(() => this.layout(), errors.onUnexpectedError);
		}));

		this.toUnbind.push(this.sashXTwo.addListener('reset', () => {
			this.panelWidth = (this.workbenchSize.width - this.sidebarWidth - this.activitybarWidth) * DEFAULT_PANEL_SIZE_COEFFICIENT;
			this.storageService.store(WorkbenchLayout.sashXTwoWidthSettingsKey, this.panelWidth, StorageScope.GLOBAL);
			this.layout();
		}));
	}

	private onEditorsChanged(): void {

		// Make sure that we layout properly in case we detect that the sidebar or panel is large enought to cause
		// multiple opened editors to go below minimal size. The fix is to trigger a layout for any editor
		// input change that falls into this category.
		if (this.workbenchSize && (this.sidebarWidth || this.panelHeight)) {
			let visibleEditors = this.editorService.getVisibleEditors().length;
			if (visibleEditors > 1) {
				const sidebarOverflow = this.layoutEditorGroupsVertically && (this.workbenchSize.width - this.sidebarWidth < visibleEditors * MIN_EDITOR_PART_WIDTH);
				const panelOverflow = !this.layoutEditorGroupsVertically && (this.workbenchSize.height - this.panelHeight < visibleEditors * MIN_EDITOR_PART_HEIGHT);

				if (sidebarOverflow || panelOverflow) {
					this.layout();
				}
			}
		}
	}

	private onGroupOrientationChanged(): void {
		const newLayoutEditorGroupsVertically = (this.editorGroupService.getGroupOrientation() !== 'horizontal');

		const doLayout = this.layoutEditorGroupsVertically !== newLayoutEditorGroupsVertically;
		this.layoutEditorGroupsVertically = newLayoutEditorGroupsVertically;

		if (doLayout) {
			this.layout();
		}
	}

	public layout(): void {
		this.workbenchSize = this.parent.getClientArea();

		const isActivityBarHidden = !this.partService.isVisible(Parts.ACTIVITYBAR_PART);
		const isTitlebarHidden = !this.partService.isVisible(Parts.TITLEBAR_PART);
		const isNavbarHidden = !this.partService.isVisible(Parts.NAVBAR_PART);
		const isPanelHidden = !this.partService.isVisible(Parts.PANEL_PART);
		const isContextbarHidden = !this.partService.isVisible(Parts.CONTEXTBAR_PART);
		const isStatusbarHidden = !this.partService.isVisible(Parts.STATUSBAR_PART);
		const isSidebarHidden = !this.partService.isVisible(Parts.SIDEBAR_PART);
		const sidebarPosition = this.partService.getSideBarPosition();
		const panelPosition = this.partService.getPanelPosition();

		// Sidebar
		if (this.sidebarWidth !== -1) {
			this.sidebarWidth = Math.max(this.partLayoutInfo.sidebar.minWidth, this.sidebarWidth);
		} else {
			this.sidebarWidth = this.workbenchSize.width / 5;
		}

		this.statusbarHeight = isStatusbarHidden ? 0 : this.partLayoutInfo.statusbar.height;
		this.contextbarHeight = isContextbarHidden ? 0 : this.partLayoutInfo.contextbar.height;
		this.titlebarHeight = isTitlebarHidden ? 0 : this.partLayoutInfo.titlebar.height / getZoomFactor(); // adjust for zoom prevention
		this.navbarHeight = isNavbarHidden ? 0 : this.partLayoutInfo.navbar.height;

		const previousMaxPanelHeight = this.sidebarHeight - MIN_EDITOR_PART_HEIGHT;
		const sourcegraphHeight = this.contextbarHeight + this.navbarHeight; // Sourcegraph additions
		this.sidebarHeight = this.workbenchSize.height - this.statusbarHeight - this.titlebarHeight - sourcegraphHeight;
		let sidebarSize = new Dimension(this.sidebarWidth, this.sidebarHeight);

		// Activity Bar
		let activityBarSize = new Dimension(this.activitybarWidth, sidebarSize.height);

		// Panel part
		let panelHeight: number;
		let panelWidth: number;
		const editorCountForHeight = this.editorGroupService.getGroupOrientation() === 'horizontal' ? this.editorGroupService.getStacksModel().groups.length : 1;
		const maxPanelHeight = sidebarSize.height - editorCountForHeight * MIN_EDITOR_PART_HEIGHT;
		const maxPanelWidth = this.workbenchSize.width - activityBarSize.width - sidebarSize.width - editorCountForHeight * MIN_EDITOR_PART_WIDTH;

		if (isPanelHidden) {
			panelHeight = 0;
			panelWidth = 0;
		} else if (panelPosition === Position.BOTTOM) {
			if (this.panelHeight === previousMaxPanelHeight) {
				panelHeight = maxPanelHeight;
			} else if (this.panelHeight > 0) {
				panelHeight = Math.min(maxPanelHeight, Math.max(this.partLayoutInfo.panel.minHeight, this.panelHeight));
			} else {
				panelHeight = sidebarSize.height * DEFAULT_PANEL_SIZE_COEFFICIENT;
			}

			panelWidth = this.workbenchSize.width - sidebarSize.width - activityBarSize.width;
		} else {
			panelHeight = sidebarSize.height;
			if (this.panelWidth > 0) {
				panelWidth = Math.min(maxPanelWidth, Math.max(this.partLayoutInfo.panel.minWidth, this.panelWidth));
			} else {
				panelWidth = (this.workbenchSize.width - activityBarSize.width - sidebarSize.width) * DEFAULT_PANEL_SIZE_COEFFICIENT;
			}
		}
		const panelDimension = new Dimension(panelWidth, panelHeight);

		// Editor
		let editorSize = {
			width: 0,
			height: 0
		};

		editorSize.width = this.workbenchSize.width - sidebarSize.width - activityBarSize.width - (panelPosition === Position.RIGHT ? panelDimension.width : 0);
		editorSize.height = sidebarSize.height - (panelPosition === Position.BOTTOM ? panelDimension.height : 0);

		// Assert Sidebar and Editor Size to not overflow
		let editorMinWidth = this.partLayoutInfo.editor.minWidth;
		let editorMinHeight = this.partLayoutInfo.editor.minHeight;
		let visibleEditorCount = this.editorService.getVisibleEditors().length;
		if (visibleEditorCount > 1) {
			if (this.layoutEditorGroupsVertically) {
				editorMinWidth *= visibleEditorCount; // when editors layout vertically, multiply the min editor width by number of visible editors
			} else {
				editorMinHeight *= visibleEditorCount; // when editors layout horizontally, multiply the min editor height by number of visible editors
			}
		}

		if (editorSize.width < editorMinWidth) {
			let diff = editorMinWidth - editorSize.width;
			editorSize.width = editorMinWidth;
			if (panelPosition === Position.BOTTOM) {
				panelDimension.width = editorMinWidth;
			}

			sidebarSize.width -= diff;
			sidebarSize.width = Math.max(MIN_SIDEBAR_PART_WIDTH, sidebarSize.width);
		}

		if (editorSize.height < editorMinHeight && panelPosition === Position.BOTTOM) {
			let diff = editorMinHeight - editorSize.height;
			editorSize.height = editorMinHeight;

			panelDimension.height -= diff;
			panelDimension.height = Math.max(MIN_PANEL_PART_HEIGHT, panelDimension.height);
		}

		if (!isSidebarHidden) {
			this.sidebarWidth = sidebarSize.width;
			this.storageService.store(WorkbenchLayout.sashXOneWidthSettingsKey, this.sidebarWidth, StorageScope.GLOBAL);
		}

		if (!isPanelHidden) {
			if (panelPosition === Position.BOTTOM) {
				this.panelHeight = panelDimension.height;
				this.storageService.store(WorkbenchLayout.sashYHeightSettingsKey, this.panelHeight, StorageScope.GLOBAL);
			} else {
				this.panelWidth = panelDimension.width;
				this.storageService.store(WorkbenchLayout.sashXTwoWidthSettingsKey, this.panelWidth, StorageScope.GLOBAL);
			}
		}

		// Workbench
		this.workbenchContainer
			.position(0, 0, 0, 0, 'relative')
			.size(this.workbenchSize.width, this.workbenchSize.height);

		// Bug on Chrome: Sometimes Chrome wants to scroll the workbench container on layout changes. The fix is to reset scrolling in this case.
		const workbenchContainer = this.workbenchContainer.getHTMLElement();
		if (workbenchContainer.scrollTop > 0) {
			workbenchContainer.scrollTop = 0;
		}
		if (workbenchContainer.scrollLeft > 0) {
			workbenchContainer.scrollLeft = 0;
		}

		// Title Part
		if (isTitlebarHidden) {
			this.titlebar.getContainer().hide();
		} else {
			this.titlebar.getContainer().show();
		}

		// Nav Bar Part
		this.navbar.getContainer().size(null, this.navbarHeight);
		this.navbar.getContainer().position(this.titlebarHeight, 0, null, 0);
		if (isNavbarHidden) {
			this.navbar.getContainer().hide();
		} else {
			this.navbar.getContainer().show();
		}

		// Editor Part and Panel part
		this.editor.getContainer().size(editorSize.width, editorSize.height);
		this.panel.getContainer().size(panelDimension.width, panelDimension.height);

		if (panelPosition === Position.BOTTOM) {
			if (sidebarPosition === Position.LEFT) {
				this.editor.getContainer().position(this.titlebarHeight + this.navbarHeight, 0, this.contextbarHeight + this.statusbarHeight + panelDimension.height, sidebarSize.width + activityBarSize.width);
				this.panel.getContainer().position(editorSize.height + this.titlebarHeight + this.navbarHeight, 0, this.contextbarHeight + this.statusbarHeight, sidebarSize.width + activityBarSize.width);
			} else {
				this.editor.getContainer().position(this.titlebarHeight + this.navbarHeight, sidebarSize.width, this.contextbarHeight + this.statusbarHeight + panelDimension.height, 0);
				this.panel.getContainer().position(editorSize.height + this.titlebarHeight + this.navbarHeight, sidebarSize.width, this.contextbarHeight + this.statusbarHeight, 0);
			}
		} else {
			if (sidebarPosition === Position.LEFT) {
				this.editor.getContainer().position(this.titlebarHeight + this.navbarHeight, panelDimension.width, this.statusbarHeight, sidebarSize.width + activityBarSize.width);
				this.panel.getContainer().position(this.titlebarHeight + this.navbarHeight, 0, this.statusbarHeight, sidebarSize.width + activityBarSize.width + editorSize.width);
			} else {
				this.editor.getContainer().position(this.titlebarHeight + this.navbarHeight, sidebarSize.width + activityBarSize.width + panelWidth, this.statusbarHeight, 0);
				this.panel.getContainer().position(this.titlebarHeight + this.navbarHeight, sidebarSize.width + activityBarSize.width, this.statusbarHeight, editorSize.width);
			}
		}

		// Activity Bar Part
		this.activitybar.getContainer().size(null, activityBarSize.height);
		if (sidebarPosition === Position.LEFT) {
			this.activitybar.getContainer().getHTMLElement().style.right = '';
			this.activitybar.getContainer().position(this.titlebarHeight + this.navbarHeight, null, 0, 0);
		} else {
			this.activitybar.getContainer().getHTMLElement().style.left = '';
			this.activitybar.getContainer().position(this.titlebarHeight + this.navbarHeight, 0, 0, null);
		}
		if (isActivityBarHidden) {
			this.activitybar.getContainer().hide();
		} else {
			this.activitybar.getContainer().show();
		}

		// Sidebar Part
		this.sidebar.getContainer().size(sidebarSize.width, sidebarSize.height);
		const editorAndPanelWidth = editorSize.width + (panelPosition === Position.RIGHT ? panelWidth : 0);
		if (sidebarPosition === Position.LEFT) {
			this.sidebar.getContainer().position(this.titlebarHeight + this.navbarHeight, editorAndPanelWidth, this.statusbarHeight, activityBarSize.width);
		} else {
			this.sidebar.getContainer().position(this.titlebarHeight + this.navbarHeight, activityBarSize.width, this.statusbarHeight, editorAndPanelWidth);
		}

		// Statusbar Part
		this.statusbar.getContainer().position(this.workbenchSize.height - this.statusbarHeight - this.contextbarHeight);
		if (isStatusbarHidden) {
			this.statusbar.getContainer().hide();
		} else {
			this.statusbar.getContainer().show();
		}

		// Contextbar Part
		this.contextbar.getContainer().position(this.workbenchSize.height - this.contextbarHeight);
		if (isContextbarHidden) {
			this.contextbar.getContainer().hide();
		} else {
			this.contextbar.getContainer().show();
		}

		// Quick open
		this.quickopen.layout(this.workbenchSize);

		// Sashes
		this.sashXOne.layout();
		if (panelPosition === Position.BOTTOM) {
			this.sashXTwo.hide();
			this.sashY.layout();
			this.sashY.show();
		} else {
			this.sashY.hide();
			this.sashXTwo.layout();
			this.sashXTwo.show();
		}

		// Propagate to Part Layouts
		this.titlebar.layout(new Dimension(this.workbenchSize.width, this.titlebarHeight));
		this.navbar.layout(new Dimension(this.workbenchSize.width, this.navbarHeight));
		this.editor.layout(new Dimension(editorSize.width, editorSize.height));
		this.sidebar.layout(sidebarSize);
		this.panel.layout(panelDimension);
		this.activitybar.layout(activityBarSize);
		this.contextbar.layout(new Dimension(this.workbenchSize.width, this.contextbarHeight));

		// Propagate to Context View
		this.contextViewService.layout();
	}

	public getVerticalSashTop(sash: Sash): number {
		return this.titlebarHeight + this.navbarHeight;
	}

	public getVerticalSashLeft(sash: Sash): number {
		let sidebarPosition = this.partService.getSideBarPosition();
		if (sash === this.sashXOne) {

			if (sidebarPosition === Position.LEFT) {
				return this.sidebarWidth + this.activitybarWidth;
			}

			return this.workbenchSize.width - this.sidebarWidth - this.activitybarWidth;
		}

		return this.workbenchSize.width - this.panelWidth - (sidebarPosition === Position.RIGHT ? this.sidebarWidth + this.activitybarWidth : 0);
	}

	public getVerticalSashHeight(sash: Sash): number {
		return this.sidebarHeight;
	}

	public getHorizontalSashTop(sash: Sash): number {
		// Horizontal sash should be a bit lower than the editor area, thus add 2px #5524
		return 2 + (this.partService.isVisible(Parts.PANEL_PART) ? this.sidebarHeight - this.panelHeight + this.titlebarHeight + this.navbarHeight : this.sidebarHeight + this.titlebarHeight + this.navbarHeight);
	}

	public getHorizontalSashLeft(sash: Sash): number {
		if (this.partService.getSideBarPosition() === Position.RIGHT) {
			return 0;
		}

		return this.sidebarWidth + this.activitybarWidth;
	}

	public getHorizontalSashWidth(sash: Sash): number {
		return this.panelWidth;
	}

	// change part size along the main axis
	public resizePart(part: Parts, sizeChange: number): void {
		const visibleEditors = this.editorService.getVisibleEditors().length;
		const sizeChangePxWidth = this.workbenchSize.width * (sizeChange / 100);
		const sizeChangePxHeight = this.workbenchSize.height * (sizeChange / 100);

		let doLayout = false;

		switch (part) {
			case Parts.SIDEBAR_PART:
				this.sidebarWidth = this.sidebarWidth + sizeChangePxWidth; // Sidebar can not become smaller than MIN_PART_WIDTH

				if (this.layoutEditorGroupsVertically && (this.workbenchSize.width - this.sidebarWidth < visibleEditors * MIN_EDITOR_PART_WIDTH)) {
					this.sidebarWidth = (this.workbenchSize.width - visibleEditors * MIN_EDITOR_PART_WIDTH);
				}

				doLayout = true;
				break;
			case Parts.PANEL_PART:
				this.panelHeight = this.panelHeight + sizeChangePxHeight;
				this.panelWidth = this.panelWidth + sizeChangePxWidth;
				doLayout = true;
				break;
			case Parts.EDITOR_PART:
				// If we have one editor we can cheat and resize sidebar with the negative delta
				const visibleEditorCount = this.editorService.getVisibleEditors().length;

				if (visibleEditorCount === 1) {
					this.sidebarWidth = this.sidebarWidth - sizeChangePxWidth;
					doLayout = true;
				} else {
					const stacks = this.editorGroupService.getStacksModel();
					const activeGroup = stacks.positionOfGroup(stacks.activeGroup);

					this.editorGroupService.resizeGroup(activeGroup, sizeChangePxWidth);
					doLayout = false;
				}
		}

		if (doLayout) {
			this.layout();
		}
	}

	public dispose(): void {
		if (this.toUnbind) {
			dispose(this.toUnbind);
			this.toUnbind = null;
		}
	}
}
