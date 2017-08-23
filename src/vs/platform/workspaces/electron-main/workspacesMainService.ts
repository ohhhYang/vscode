/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IWorkspacesMainService, IWorkspaceIdentifier, IStoredWorkspace, WORKSPACE_EXTENSION, IWorkspaceSavedEvent, UNTITLED_WORKSPACE_NAME } from 'vs/platform/workspaces/common/workspaces';
import { TPromise } from 'vs/base/common/winjs.base';
import { isParent } from 'vs/platform/files/common/files';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { extname, join, dirname } from 'path';
import { mkdirp, writeFile } from 'vs/base/node/pfs';
import { readFileSync, writeFileSync } from 'fs';
import { isLinux } from 'vs/base/common/platform';
import { copy, delSync, readdirSync, mkdirpSync } from 'vs/base/node/extfs';
import { nfcall } from 'vs/base/common/async';
import Event, { Emitter } from 'vs/base/common/event';
import { ILogService } from 'vs/platform/log/common/log';
import { isEqual } from 'vs/base/common/paths';
import { coalesce } from 'vs/base/common/arrays';

export class WorkspacesMainService implements IWorkspacesMainService {

	public _serviceBrand: any;

	protected workspacesHome: string;

	private _onWorkspaceSaved: Emitter<IWorkspaceSavedEvent>;
	private _onWorkspaceDeleted: Emitter<IWorkspaceIdentifier>;

	constructor(
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ILogService private logService: ILogService
	) {
		this.workspacesHome = environmentService.workspacesHome;

		this._onWorkspaceSaved = new Emitter<IWorkspaceSavedEvent>();
		this._onWorkspaceDeleted = new Emitter<IWorkspaceIdentifier>();
	}

	public get onWorkspaceSaved(): Event<IWorkspaceSavedEvent> {
		return this._onWorkspaceSaved.event;
	}

	public get onWorkspaceDeleted(): Event<IWorkspaceIdentifier> {
		return this._onWorkspaceDeleted.event;
	}

	public createUntitledWorkspaceSync(): IWorkspaceIdentifier {
		const workspaceId = this.nextWorkspaceId();
		const workspaceConfigFolder = join(this.workspacesHome, workspaceId);
		const workspaceConfigPath = join(workspaceConfigFolder, UNTITLED_WORKSPACE_NAME);

		mkdirpSync(workspaceConfigFolder);
		const storedWorkspace: IStoredWorkspace = {
			id: workspaceId,
			folders: [],
		};

		writeFileSync(workspaceConfigPath, JSON.stringify(storedWorkspace, null, '\t'));
		return {
			id: workspaceId,
			configPath: workspaceConfigPath
		};
	}

	public resolveWorkspaceSync(path: string): IStoredWorkspace {
		const isWorkspace = this.isInsideWorkspacesHome(path) || extname(path) === `.${WORKSPACE_EXTENSION}`;
		if (!isWorkspace) {
			return null; // does not look like a valid workspace config file
		}

		try {
			const workspace = JSON.parse(readFileSync(path, 'utf8')) as IStoredWorkspace;
			if (typeof workspace.id !== 'string' || !Array.isArray(workspace.folders) || workspace.folders.length === 0) {
				this.logService.log(`${path} looks like an invalid workspace file.`);

				return null; // looks like an invalid workspace file
			}

			return workspace;
		} catch (error) {
			this.logService.log(`${path} cannot be parsed as JSON file (${error}).`);

			return null; // unable to read or parse as workspace file
		}
	}

	private isInsideWorkspacesHome(path: string): boolean {
		return isParent(path, this.environmentService.workspacesHome, !isLinux /* ignore case */);
	}

	public createWorkspace(folders: string[]): TPromise<IWorkspaceIdentifier> {
		const workspaceId = this.nextWorkspaceId();
		const workspaceConfigFolder = join(this.workspacesHome, workspaceId);
		const workspaceConfigPath = join(workspaceConfigFolder, UNTITLED_WORKSPACE_NAME);

		return mkdirp(workspaceConfigFolder).then(() => {
			const storedWorkspace: IStoredWorkspace = {
				id: workspaceId,
				folders
			};

			return writeFile(workspaceConfigPath, JSON.stringify(storedWorkspace, null, '\t')).then(() => ({
				id: workspaceId,
				configPath: workspaceConfigPath
			}));
		});
	}

	private nextWorkspaceId(): string {
		return (Date.now() + Math.round(Math.random() * 1000)).toString();
	}

	public isUntitledWorkspace(workspace: IWorkspaceIdentifier): boolean {
		return this.isInsideWorkspacesHome(workspace.configPath);
	}

	public saveWorkspace(workspace: IWorkspaceIdentifier, target: string): TPromise<IWorkspaceIdentifier> {

		// Return early if target is same as source
		if (isEqual(workspace.configPath, target, !isLinux)) {
			return TPromise.as(workspace);
		}

		// Copy to new target
		return nfcall(copy, workspace.configPath, target).then(() => {
			const savedWorkspace = this.resolveWorkspaceSync(target);
			const savedWorkspaceIdentifier = { id: savedWorkspace.id, configPath: target };

			// Event
			this._onWorkspaceSaved.fire({ workspace: savedWorkspaceIdentifier, oldConfigPath: workspace.configPath });

			// Delete untitled workspace
			this.deleteUntitledWorkspaceSync(workspace);

			return savedWorkspaceIdentifier;
		});
	}

	public deleteUntitledWorkspaceSync(workspace: IWorkspaceIdentifier): void {
		if (!this.isUntitledWorkspace(workspace)) {
			return; // only supported for untitled workspaces
		}

		// Delete from disk
		this.doDeleteUntitledWorkspaceSync(workspace.configPath);

		// Event
		this._onWorkspaceDeleted.fire(workspace);
	}

	private doDeleteUntitledWorkspaceSync(configPath: string): void {
		try {
			delSync(dirname(configPath));
		} catch (error) {
			this.logService.log(`Unable to delete untitled workspace ${configPath} (${error}).`);
		}
	}

	public getUntitledWorkspacesSync(): IWorkspaceIdentifier[] {
		let untitledWorkspacePaths: string[] = [];
		try {
			untitledWorkspacePaths = readdirSync(this.workspacesHome).map(folder => join(this.workspacesHome, folder, UNTITLED_WORKSPACE_NAME));
		} catch (error) {
			this.logService.log(`Unable to read folders in ${this.workspacesHome} (${error}).`);
		}

		const untitledWorkspaces: IWorkspaceIdentifier[] = coalesce(untitledWorkspacePaths.map(untitledWorkspacePath => {
			const workspace = this.resolveWorkspaceSync(untitledWorkspacePath);
			if (!workspace) {
				this.doDeleteUntitledWorkspaceSync(untitledWorkspacePath);

				return null; // invalid workspace
			}

			return { id: workspace.id, configPath: untitledWorkspacePath };
		}));

		return untitledWorkspaces;
	}
}