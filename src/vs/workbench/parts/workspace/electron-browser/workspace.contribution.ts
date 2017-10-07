/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/workspace';
import { ViewletRegistry, Extensions as ViewletExtensions, ViewletDescriptor } from 'vs/workbench/browser/viewlet';
import nls = require('vs/nls');
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actions';
import { VIEWLET_ID } from 'vs/workbench/parts/workspace/common/workspace';
import { OpenWorkspaceViewletAction, AddRootFolderResourceAction } from 'vs/workbench/parts/workspace/browser/folderActions';
import { IKeybindings } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { WorkspaceViewlet } from 'vs/workbench/parts/workspace/electron-browser/workspaceViewlet';

// Register Viewlet
Registry.as<ViewletRegistry>(ViewletExtensions.Viewlets).registerViewlet(new ViewletDescriptor(
	WorkspaceViewlet,
	VIEWLET_ID,
	nls.localize('workspace', "Workspace"),
	'workspace',
	80,
));

const openViewletKb: IKeybindings = {
	primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_F
};

// Global actions
const actionRegistry = Registry.as<IWorkbenchActionRegistry>(ActionExtensions.WorkbenchActions);

actionRegistry.registerWorkbenchAction(
	new SyncActionDescriptor(OpenWorkspaceViewletAction, OpenWorkspaceViewletAction.ID, OpenWorkspaceViewletAction.LABEL, openViewletKb),
	'View: Show Workspace',
	nls.localize('view', "View")
);

const workspacesCategory = nls.localize('workspaces', "Workspaces");
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(AddRootFolderResourceAction, AddRootFolderResourceAction.ID, AddRootFolderResourceAction.LABEL), 'Workspaces: Add Folder to Workspace by URI...', workspacesCategory);

// Configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	'id': 'workspace',
	'order': 11,
	'title': nls.localize('workspaceConfigurationTitle', "Workspace"),
	'type': 'object',
	'properties': {}
});
