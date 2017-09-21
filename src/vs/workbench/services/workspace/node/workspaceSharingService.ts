/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import { IWorkspaceSharingService } from 'vs/workbench/services/workspace/common/workspaceSharing';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IFileService, isParent } from 'vs/platform/files/common/files';
import { IStoredWorkspace } from 'vs/platform/workspaces/common/workspaces';
import { nfcall } from 'vs/base/common/async';
import * as cp from 'child_process';
import { Schemas } from 'vs/base/common/network';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { isLinux } from 'vs/base/common/platform';
import * as json from 'vs/base/common/json';
import * as arrays from 'vs/base/common/arrays';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { localize } from 'vs/nls';
import { IFoldersWorkbenchService } from 'vs/workbench/services/folders/common/folders';
import { IFolderCatalogService } from 'vs/platform/folders/common/folderCatalog';
import { ITelemetryData, ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

export class WorkspaceSharingService implements IWorkspaceSharingService {

	public _serviceBrand: any;

	constructor(
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IFileService private fileService: IFileService,
		@IWorkspaceEditingService private workspaceEditingService: IWorkspaceEditingService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IJSONEditingService private jsonEditingService: IJSONEditingService,
		@IExtensionService private extensionService: IExtensionService,
		@IFoldersWorkbenchService private foldersWorkbenchService: IFoldersWorkbenchService,
		@IFolderCatalogService private folderCatalogService: IFolderCatalogService,
		@ITelemetryService private telemetryService: ITelemetryService,
	) {
		// Import after activation of extensions that supply resource resolvers.
		this.extensionService.onReady().then(() =>
			this.extensionService.activateByEvent(`*`).then(() => this.import())
		);
	}

	public export(target: URI): TPromise<void> {
		const folders = this.contextService.getWorkspace().folders;

		return TPromise.join(folders.map(folder => {
			// For each root try and resolve it via the FolderCatalogService, since they will provide
			// the most useful links for cloning. If that fails, we use resolveShareableFallback which
			// just returns the git clone URL.
			if (folder.uri.scheme !== Schemas.file) {
				return TPromise.as(folder.uri);
			}
			return this.folderCatalogService.resolveLocalFolderResources(folder.uri.fsPath).then(uris => {
				return uris.length > 0 ? TPromise.as(uris[0]) : resolveCloneURI(folder.uri);
			});
		})).then(uris => {
			const storedWorkspace: IStoredWorkspace = {
				folders: [],
				roots: uris.map(u => u.toString()),
			};
			this.telemetryService.publicLog('workspace.export', getTelemetryData(storedWorkspace));

			const header = localize('srcWorkspaceHeader', `// This is a Sourcegraph workspace that defines a set of related repositories
// and associated configuration.
//
// To open it, you must first download Sourcegraph at https://about.sourcegraph.com/beta/201708.`);
			const content = header + '\n' + JSON.stringify(storedWorkspace, null, '\t') + '\n';
			return this.fileService.updateContent(target, content, { encoding: 'utf8' }).then(() => { });
		});
	}

	private import(): void {
		// Opening a src-workspace is like opening a code-workspace, except for two things:
		// * The workspace will stay Untitled
		// * roots in the configuration will be non-empty
		const workspace = this.contextService.getWorkspace();
		if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE || !this.isUntitledWorkspace(workspace.configuration.fsPath)) {
			return;
		}
		this.fileService.resolveContent(workspace.configuration).then(content => {
			const config = json.parse(content.value);
			if (!config || arrays.isFalsyOrEmpty(config.roots)) {
				return;
			}
			const roots: URI[] = config.roots.map(URI.parse);
			this.telemetryService.publicLog('workspace.import', getTelemetryData(config as IStoredWorkspace));
			this.foldersWorkbenchService.addFoldersAsWorkspaceRootFolders(roots);
			// Now that the roots have been added as folders, remove them from the config so we don't add them again.
			this.jsonEditingService.write(workspace.configuration, { key: 'roots', value: [] }, true);
		});
	}

	private isUntitledWorkspace(path: string): boolean {
		return isParent(path, this.environmentService.workspacesHome, !isLinux /* ignore case */);
	}
}

/**
 * Tries to find a cloneable URI for resource. If it fails, it will return URI.
 * This is a fallback for finding a shareable URI for a path.
 */
function resolveCloneURI(resource: URI): TPromise<URI> {
	if (resource.scheme !== Schemas.file) {
		return TPromise.as(resource);
	}
	return nfcall(cp.exec, 'git ls-remote --get-url', { cwd: resource.fsPath }).then(
		(stdout: string) => {
			const remoteResource = parseGitURL(stdout.trim());
			return remoteResource === null ? resource : remoteResource;
		},
		() => {
			return resource;
		}
	);
}

/**
 * Parses the URLs that git can return.
 *
 * Git doesn't always return well-formed URLs. For example it is common for
 * git to return SCP strings instead of ssh URLs.
 */
export function parseGitURL(gitURL: string): URI | null {
	gitURL = decodeURIComponent(gitURL);
	// Parse ssh procotol (e.g. user@company.com:foo/bar)
	const sshMatch = gitURL.match(/^([^/@:]+@)?([^:/]+):([^/].*)$/);
	if (sshMatch) {
		gitURL = 'ssh://' + (sshMatch[1] || '') + sshMatch[2] + '/' + sshMatch[3];
	}
	const uri = URI.parse(gitURL);
	if (uri.scheme === '') {
		return null; // Not a valid git clone url.
	}
	return uri.with({ scheme: 'git+' + uri.scheme });
}

function getTelemetryData(workspace: IStoredWorkspace): ITelemetryData {
	// Count up what we are storing by URL scheme
	const schemes = new Map<string, number>();
	let count = 0;
	if (!arrays.isFalsyOrEmpty(workspace.folders)) {
		schemes.set('folders', workspace.folders.length);
		count += workspace.folders.length;
	}
	(workspace.roots || []).map(root => {
		const u = URI.parse(root);
		schemes.set(u.scheme, (schemes.get(u.scheme) || 0) + 1);
		count++;
	});
	const schemesList: { name: string; count: number; }[] = [];
	schemes.forEach((count, name) => {
		schemesList.push({ name, count });
	});
	return {
		storedWorkspace: {
			count,
			schemes: schemesList,
		},
	};
}