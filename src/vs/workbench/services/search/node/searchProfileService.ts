/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ISearchProfileService, ISearchProfile, ISearchConfiguration, SearchProfileSource } from 'vs/platform/search/common/search';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import Event, { Emitter } from 'vs/base/common/event';
import { localize } from 'vs/nls';
import * as arrays from 'vs/base/common/arrays';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IRemoteService, requestGraphQL } from 'vs/platform/remote/node/remote';
import { onUnexpectedError } from 'vs/base/common/errors';

/**
 * A service which aggregates all the valid Search Profiles for a workspace.
 */
export class SearchProfileService extends Disposable implements ISearchProfileService {

	_serviceBrand: any;

	private static EMPTY_WORKSPACE_TEXT = localize('searchProfile.emptyWorkspace', "Open Files");
	private static CURRENT_WORKSPACE_TEXT = localize('searchProfile.currentWorkspace', "Current Workspace ({0})");
	private static CUSTOM_TEXT = localize('searchProfile.custom', "Custom");

	private didSearchProfilesChange = this._register(new Emitter<void>());
	public onDidSearchProfilesChange: Event<void> = this.didSearchProfilesChange.event;

	// Search profiles from the server
	private _fromServer: ISearchProfile[] = [];

	// Search profiles from user preferences
	private _fromConfig: ISearchProfile[] = [];

	// An ephemeral config, usually specified via URL parameters. Set via getProfileForWorkspaces
	private _custom: string[] = [];

	constructor(
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IRemoteService private remoteService: IRemoteService,
	) {
		super();

		this.fetchServerProfiles();
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.didSearchProfilesChange.fire()));
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigUpdated()));
		this.onConfigUpdated();
	}

	public getSearchProfiles(): ISearchProfile[] {
		let profiles: ISearchProfile[] = [];

		profiles.push({
			name: this.getCurrentWorkspaceText(),
			workspaces: [],
			source: SearchProfileSource.Workspace,
		});

		if (this._custom.length > 0) {
			profiles.push({
				name: SearchProfileService.CUSTOM_TEXT,
				description: localize('searchProfile.custom.description', "Manually Specified"),
				workspaces: this._custom,
				source: SearchProfileSource.Ephemeral,
			});
		}

		profiles = profiles.concat(this._fromConfig.map(p => {
			return {
				...p,
				source: SearchProfileSource.Config,
			};
		}));

		profiles = profiles.concat(this._fromServer.map(p => {
			return {
				...p,
				source: SearchProfileSource.Server,
			};
		}));

		return profiles;
	}

	private getCurrentWorkspaceText(): string {
		if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return SearchProfileService.EMPTY_WORKSPACE_TEXT;
		}

		const folders = this.contextService.getWorkspace().folders;
		let text = SearchProfileService.CURRENT_WORKSPACE_TEXT;
		if (folders.length === 0 || folders.length > 1) {
			return text.replace('{0}', localize('searchProfile.currentWorkspace.multiple', "{0} Repositories", folders.length));
		}
		return text.replace('{0}', localize('searchProfile.currentWorkspace.single', "1 Repository"));
	}

	public getProfileForWorkspaces(workspaces: string[]): ISearchProfile {
		const workspacesSorted = workspaces.concat().sort();
		const profile = arrays.first(this.getSearchProfiles(), profile => {
			const sorted = profile.workspaces.concat().sort();
			return arrays.equals(sorted, workspacesSorted);
		});
		if (profile !== null) {
			return profile;
		}

		// We don't have a matching profile, so we update Custom.
		this._custom = workspaces;
		this.didSearchProfilesChange.fire();
		return {
			name: SearchProfileService.CUSTOM_TEXT,
			description: localize('searchProfile.custom.description', "Manually Specified"),
			workspaces: workspaces,
		};
	}

	private fetchServerProfiles(): void {
		// Ignore returned promise, just do in background
		requestGraphQL<{ searchProfiles: GQL.ISearchProfile[] }>(this.remoteService, `query SearchProfiles {
			root {
			  searchProfiles {
				name
				description
				repositories {
					uri
				}
			  }
			}
		}
		`, {}).then(({ searchProfiles }) => {
				this._fromServer = searchProfiles.map(p => {
					return {
						name: p.name,
						description: p.description,
						workspaces: p.repositories.map(repo => repo.uri),
					};
				});
				this.didSearchProfilesChange.fire();
				return null;
			}).done(null, onUnexpectedError);
	}

	private onConfigUpdated(): void {
		const fromConfig = (this.configurationService.getConfiguration<ISearchConfiguration>().search.profiles || []);
		if (!arrays.equals(fromConfig, this._fromConfig)) {
			this._fromConfig = fromConfig;
			this.didSearchProfilesChange.fire();
		}
	}
}
