/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { clone, equals } from 'vs/base/common/objects';
import { compare, toValuesTree, IConfigurationChangeEvent, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { ConfigurationModel, Configuration as BaseConfiguration, CustomConfigurationModel, ConfigurationChangeEvent } from 'vs/platform/configuration/common/configurationModels';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, IConfigurationPropertySchema, Extensions, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { WORKSPACE_STANDALONE_CONFIGURATIONS } from 'vs/workbench/services/configuration/common/configuration';
import { IStoredWorkspaceFolder } from 'vs/platform/workspaces/common/workspaces';
import { Workspace } from 'vs/platform/workspace/common/workspace';
import { StrictResourceMap } from 'vs/base/common/map';
import URI from 'vs/base/common/uri';

export class WorkspaceConfigurationModel extends CustomConfigurationModel {

	private _raw: any;
	private _folders: IStoredWorkspaceFolder[];
	private _worksapaceSettings: ConfigurationModel;
	private _tasksConfiguration: ConfigurationModel;
	private _launchConfiguration: ConfigurationModel;
	private _workspaceConfiguration: ConfigurationModel;

	public update(content: string): void {
		super.update(content);
		this._worksapaceSettings = new ConfigurationModel(this._worksapaceSettings.contents, this._worksapaceSettings.keys, this.overrides);
		this._workspaceConfiguration = this.consolidate();
	}

	get folders(): IStoredWorkspaceFolder[] {
		return this._folders;
	}

	get workspaceConfiguration(): ConfigurationModel {
		return this._workspaceConfiguration;
	}

	protected processRaw(raw: any): void {
		this._raw = raw;

		this._folders = (this._raw['folders'] || []) as IStoredWorkspaceFolder[];
		this._worksapaceSettings = this.parseConfigurationModel('settings');
		this._tasksConfiguration = this.parseConfigurationModel('tasks');
		this._launchConfiguration = this.parseConfigurationModel('launch');

		super.processRaw(raw);
	}

	private parseConfigurationModel(section: string): ConfigurationModel {
		const rawSection = this._raw[section] || {};
		const contents = toValuesTree(rawSection, message => console.error(`Conflict in section '${section}' of workspace configuration file ${message}`));
		return new ConfigurationModel(contents, Object.keys(rawSection));
	}

	private consolidate(): ConfigurationModel {
		const keys: string[] = [...this._worksapaceSettings.keys,
		...this._tasksConfiguration.keys.map(key => `tasks.${key}`),
		...this._launchConfiguration.keys.map(key => `launch.${key}`)];

		const mergedContents = new ConfigurationModel({}, keys)
			.merge(this._worksapaceSettings)
			.merge(this._tasksConfiguration)
			.merge(this._launchConfiguration);

		return new ConfigurationModel(mergedContents.contents, keys, mergedContents.overrides);
	}
}

export class ScopedConfigurationModel extends CustomConfigurationModel {

	constructor(content: string, name: string, public readonly scope: string) {
		super(null, name);
		this.update(content);
	}

	public update(content: string): void {
		super.update(content);
		const contents = Object.create(null);
		contents[this.scope] = this.contents;
		this._contents = contents;
	}

}

export class FolderSettingsModel extends CustomConfigurationModel {

	private _raw: any;
	private _unsupportedKeys: string[];

	protected processRaw(raw: any): void {
		this._raw = raw;
		const processedRaw = {};
		this._unsupportedKeys = [];
		const configurationProperties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		for (let key in raw) {
			if (this.isNotExecutable(key, configurationProperties)) {
				processedRaw[key] = raw[key];
			} else {
				this._unsupportedKeys.push(key);
			}
		}
		return super.processRaw(processedRaw);
	}

	public reprocess(): void {
		this.processRaw(this._raw);
	}

	public get unsupportedKeys(): string[] {
		return this._unsupportedKeys || [];
	}

	private isNotExecutable(key: string, configurationProperties: { [qualifiedKey: string]: IConfigurationPropertySchema }): boolean {
		const propertySchema = configurationProperties[key];
		if (!propertySchema) {
			return true; // Unknown propertis are ignored from checks
		}
		return !propertySchema.isExecutable;
	}

	public createWorkspaceConfigurationModel(): ConfigurationModel {
		return this.createScopedConfigurationModel(ConfigurationScope.WINDOW);
	}

	public createFolderScopedConfigurationModel(): ConfigurationModel {
		return this.createScopedConfigurationModel(ConfigurationScope.RESOURCE);
	}

	private createScopedConfigurationModel(scope: ConfigurationScope): ConfigurationModel {
		const workspaceRaw = {};
		const configurationProperties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		for (let key in this._raw) {
			if (this.getScope(key, configurationProperties) === scope) {
				workspaceRaw[key] = this._raw[key];
			}
		}
		const workspaceContents = toValuesTree(workspaceRaw, message => console.error(`Conflict in workspace settings file: ${message}`));
		const workspaceKeys = Object.keys(workspaceRaw);
		return new ConfigurationModel(workspaceContents, workspaceKeys, clone(this._overrides));
	}

	private getScope(key: string, configurationProperties: { [qualifiedKey: string]: IConfigurationPropertySchema }): ConfigurationScope {
		const propertySchema = configurationProperties[key];
		return propertySchema ? propertySchema.scope : ConfigurationScope.WINDOW;
	}
}

export class FolderConfigurationModel extends CustomConfigurationModel {

	constructor(public readonly workspaceSettingsConfig: FolderSettingsModel, private scopedConfigs: ScopedConfigurationModel[], private scope: ConfigurationScope) {
		super();
		this.consolidate();
	}

	private consolidate(): void {
		this._contents = {};
		this._overrides = [];

		this.doMerge(this, ConfigurationScope.WINDOW === this.scope ? this.workspaceSettingsConfig : this.workspaceSettingsConfig.createFolderScopedConfigurationModel());
		for (const configModel of this.scopedConfigs) {
			this.doMerge(this, configModel);
		}
	}

	public get keys(): string[] {
		const keys: string[] = [...this.workspaceSettingsConfig.keys];
		this.scopedConfigs.forEach(scopedConfigModel => {
			Object.keys(WORKSPACE_STANDALONE_CONFIGURATIONS).forEach(scope => {
				if (scopedConfigModel.scope === scope) {
					keys.push(...scopedConfigModel.keys.map(key => `${scope}.${key}`));
				}
			});
		});
		return keys;
	}

	public update(): void {
		this.workspaceSettingsConfig.reprocess();
		this.consolidate();
	}
}

export class Configuration extends BaseConfiguration {

	constructor(
		defaults: ConfigurationModel,
		user: ConfigurationModel,
		workspaceConfiguration: ConfigurationModel,
		protected folders: StrictResourceMap<FolderConfigurationModel>,
		memoryConfiguration: ConfigurationModel,
		memoryConfigurationByResource: StrictResourceMap<ConfigurationModel>,
		workspace: Workspace) {
		super(defaults, user, workspaceConfiguration, folders, memoryConfiguration, memoryConfigurationByResource, workspace);
	}

	updateDefaultConfiguration(defaults: ConfigurationModel): void {
		this._defaults = defaults;
		this.merge();
	}

	updateUserConfiguration(user: ConfigurationModel): ConfigurationChangeEvent {
		const { added, updated, removed } = compare(this._user, user);
		let changedKeys = [...added, ...updated, ...removed];
		if (changedKeys.length) {
			const oldConfiguartion = new Configuration(this._defaults, this._user, this._workspaceConfiguration, this.folders, this._memoryConfiguration, this._memoryConfigurationByResource, this._workspace);

			this._user = user;
			this.merge();

			changedKeys = changedKeys.filter(key => !equals(oldConfiguartion.getValue(key), this.getValue(key)));
		}
		return new ConfigurationChangeEvent().change(changedKeys);
	}

	updateWorkspaceConfiguration(workspaceConfiguration: ConfigurationModel): ConfigurationChangeEvent {
		const { added, updated, removed } = compare(this._workspaceConfiguration, workspaceConfiguration);
		let changedKeys = [...added, ...updated, ...removed];
		if (changedKeys.length) {
			const oldConfiguartion = new Configuration(this._defaults, this._user, this._workspaceConfiguration, this.folders, this._memoryConfiguration, this._memoryConfigurationByResource, this._workspace);

			this._workspaceConfiguration = workspaceConfiguration;
			this.merge();

			changedKeys = changedKeys.filter(key => !equals(oldConfiguartion.getValue(key), this.getValue(key)));
		}
		return new ConfigurationChangeEvent().change(changedKeys);
	}

	updateFolderConfiguration(resource: URI, configuration: FolderConfigurationModel): ConfigurationChangeEvent {
		const currentFolderConfiguration = this.folders.get(resource);

		if (currentFolderConfiguration) {
			const { added, updated, removed } = compare(currentFolderConfiguration, configuration);
			let changedKeys = [...added, ...updated, ...removed];
			if (changedKeys.length) {
				const oldConfiguartion = new Configuration(this._defaults, this._user, this._workspaceConfiguration, this.folders, this._memoryConfiguration, this._memoryConfigurationByResource, this._workspace);

				this.folders.set(resource, configuration);
				this.mergeFolder(resource);

				changedKeys = changedKeys.filter(key => !equals(oldConfiguartion.getValue(key, { resource }), this.getValue(key, { resource })));
			}
			return new ConfigurationChangeEvent().change(changedKeys, resource);
		}

		this.folders.set(resource, configuration);
		this.mergeFolder(resource);
		return new ConfigurationChangeEvent().change(configuration.keys, resource);
	}

	deleteFolderConfiguration(folder: URI): ConfigurationChangeEvent {
		if (this._workspace && this._workspace.folders.length > 0 && this._workspace.folders[0].uri.toString() === folder.toString()) {
			// Do not remove workspace configuration
			return new ConfigurationChangeEvent();
		}

		const keys = this.folders.get(folder).keys;
		this.folders.delete(folder);
		this._foldersConsolidatedConfigurations.delete(folder);
		return new ConfigurationChangeEvent().change(keys, folder);
	}

	getFolderConfigurationModel(folder: URI): FolderConfigurationModel {
		return <FolderConfigurationModel>this.folders.get(folder);
	}
}

export class WorkspaceConfigurationChangeEvent implements IConfigurationChangeEvent {

	constructor(private configurationChangeEvent: ConfigurationChangeEvent, private workspace: Workspace) {
	}

	get affectedKeys(): string[] {
		return this.configurationChangeEvent.affectedKeys;
	}

	get source(): ConfigurationTarget {
		return this.configurationChangeEvent.source;
	}

	get sourceConfig(): any {
		return this.configurationChangeEvent.sourceConfig;
	}

	affectsConfiguration(config: string, resource?: URI): boolean {
		if (this.configurationChangeEvent.affectsConfiguration(config, resource)) {
			return true;
		}

		if (resource) {
			let workspaceFolder = this.workspace.getFolder(resource);
			if (workspaceFolder) {
				return this.configurationChangeEvent.affectsConfiguration(config, workspaceFolder.uri);
			}
		}

		return false;
	}
}