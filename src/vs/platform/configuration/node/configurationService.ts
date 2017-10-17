/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ConfigWatcher } from 'vs/base/node/config';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { IConfigurationService, IConfigurationChangeEvent, IConfigurationOverrides, ConfigurationTarget, compare, isConfigurationOverrides, IConfigurationData } from 'vs/platform/configuration/common/configuration';
import { CustomConfigurationModel, DefaultConfigurationModel, ConfigurationModel, Configuration, ConfigurationChangeEvent } from 'vs/platform/configuration/common/configurationModels';
import Event, { Emitter } from 'vs/base/common/event';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { onUnexpectedError } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { equals } from 'vs/base/common/objects';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';

export class ConfigurationService extends Disposable implements IConfigurationService, IDisposable {

	_serviceBrand: any;

	private _configuration: Configuration;
	private userConfigModelWatcher: ConfigWatcher<ConfigurationModel>;

	private _onDidUpdateConfiguration: Emitter<IConfigurationChangeEvent> = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidUpdateConfiguration: Event<IConfigurationChangeEvent> = this._onDidUpdateConfiguration.event;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService
	) {
		super();

		this.userConfigModelWatcher = new ConfigWatcher(environmentService.appSettingsPath, {
			changeBufferDelay: 300, onError: error => onUnexpectedError(error), defaultConfig: new CustomConfigurationModel(null, environmentService.appSettingsPath), parse: (content: string, parseErrors: any[]) => {
				const userConfigModel = new CustomConfigurationModel(content, environmentService.appSettingsPath);
				parseErrors = [...userConfigModel.errors];
				return userConfigModel;
			}
		});
		this._register(this.userConfigModelWatcher);

		this.reset();

		// Listeners
		this._register(this.userConfigModelWatcher.onDidUpdateConfiguration(() => this.onDidUpdateConfigModel()));
		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidRegisterConfiguration(configurationProperties => this.onDidRegisterConfiguration(configurationProperties)));
	}

	get configuration(): Configuration {
		return this._configuration;
	}

	getConfigurationData(): IConfigurationData {
		return this.configuration.toData();
	}

	getConfiguration<T>(): T
	getConfiguration<T>(section: string): T
	getConfiguration<T>(overrides: IConfigurationOverrides): T
	getConfiguration<T>(section: string, overrides: IConfigurationOverrides): T
	getConfiguration(arg1?: any, arg2?: any): any {
		const section = typeof arg1 === 'string' ? arg1 : void 0;
		const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : void 0;
		return this.configuration.getSection(section, overrides);
	}

	getValue(key: string, overrides: IConfigurationOverrides): any {
		return this.configuration.getValue(key, overrides);
	}

	updateValue(key: string, value: any): TPromise<void>
	updateValue(key: string, value: any, overrides: IConfigurationOverrides): TPromise<void>
	updateValue(key: string, value: any, target: ConfigurationTarget): TPromise<void>
	updateValue(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget): TPromise<void>
	updateValue(key: string, value: any, arg3?: any, arg4?: any): TPromise<void> {
		return TPromise.wrapError(new Error('not supported'));
	}

	inspect<T>(key: string): {
		default: T,
		user: T,
		workspace: T,
		workspaceFolder: T
		value: T
	} {
		return this.configuration.lookup<T>(key);
	}

	keys(): {
		default: string[];
		user: string[];
		workspace: string[];
		workspaceFolder: string[];
	} {
		return this.configuration.keys();
	}

	reloadConfiguration(folder?: IWorkspaceFolder): TPromise<void> {
		return folder ? TPromise.as(null) :
			new TPromise((c, e) => this.userConfigModelWatcher.reload(() => c(this.onDidUpdateConfigModel())));
	}

	private onDidUpdateConfigModel(): void {
		let changedKeys = [];
		const { added, updated, removed } = compare(this._configuration.user, this.userConfigModelWatcher.getConfig());
		changedKeys = [...added, ...updated, ...removed];
		if (changedKeys.length) {
			const oldConfiguartion = this._configuration;
			this.reset();
			changedKeys = changedKeys.filter(key => !equals(oldConfiguartion.getValue(key), this._configuration.getValue(key)));
			if (changedKeys.length) {
				this.trigger(changedKeys, ConfigurationTarget.USER);
			}
		}
	}

	private onDidRegisterConfiguration(keys: string[]): void {
		this.reset(); // reset our caches
		this.trigger(keys, ConfigurationTarget.DEFAULT);
	}

	private reset(): void {
		const defaults = new DefaultConfigurationModel();
		const user = this.userConfigModelWatcher.getConfig();
		this._configuration = new Configuration(defaults, user);
	}

	private trigger(keys: string[], source: ConfigurationTarget): void {
		this._onDidUpdateConfiguration.fire(new ConfigurationChangeEvent().change(keys).telemetryData(source, this.getTargetConfiguration(source)));
	}

	private getTargetConfiguration(target: ConfigurationTarget): any {
		switch (target) {
			case ConfigurationTarget.DEFAULT:
				return this._configuration.defaults.contents;
			case ConfigurationTarget.USER:
				return this._configuration.user.contents;
		}
		return {};
	}
}