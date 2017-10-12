/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import { IConfigurationService, getConfigurationValue, IConfigurationValue, IConfigurationOverrides } from 'vs/platform/configuration/common/configuration';
import { Platform } from 'vs/base/common/platform';
import { TPromise } from 'vs/base/common/winjs.base';
import { TerminalConfigHelper } from 'vs/workbench/parts/terminal/electron-browser/terminalConfigHelper';
import { EDITOR_FONT_DEFAULTS } from 'vs/editor/common/config/editorOptions';
import { isFedora } from 'vs/workbench/parts/terminal/electron-browser/terminal';

class MockConfigurationService implements IConfigurationService {
	public _serviceBrand: any;
	public serviceId = IConfigurationService;
	public constructor(private configuration: any = {}) { }
	public reloadConfiguration<T>(section?: string): TPromise<T> { return TPromise.as(this.getConfiguration()); }
	public lookup<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> { return { value: getConfigurationValue<T>(this.getConfiguration(), key), default: getConfigurationValue<T>(this.getConfiguration(), key), organization: getConfigurationValue<T>(this.getConfiguration(), key), user: getConfigurationValue<T>(this.getConfiguration(), key), workspace: void 0, folder: void 0 }; }
	public keys() { return { default: [], organization: [], user: [], workspace: [], folder: [] }; }
	public values() { return {}; }
	public getConfiguration(): any { return this.configuration; }
	public getConfigurationData(): any { return null; }
	public onDidUpdateConfiguration() { return { dispose() { } }; }
}

suite('Workbench - TerminalConfigHelper', () => {
	let fixture: HTMLElement;

	setup(() => {
		fixture = document.body;
	});

	test('TerminalConfigHelper - getFont fontFamily', function () {
		let configurationService: IConfigurationService;
		let configHelper: TerminalConfigHelper;

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo'
			},
			terminal: {
				integrated: {
					fontFamily: 'bar'
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().fontFamily, 'bar', 'terminal.integrated.fontFamily should be selected over editor.fontFamily');

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo'
			},
			terminal: {
				integrated: {
					fontFamily: 0
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		if (isFedora) {
			assert.equal(configHelper.getFont().fontFamily, '\'DejaVu Sans Mono\'', 'Fedora should have its font overridden when terminal.integrated.fontFamily not set');
		} else {
			assert.equal(configHelper.getFont().fontFamily, 'foo', 'editor.fontFamily should be the fallback when terminal.integrated.fontFamily not set');
		}
	});

	test('TerminalConfigHelper - getFont fontSize', function () {
		let configurationService: IConfigurationService;
		let configHelper: TerminalConfigHelper;

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo',
				fontSize: 1
			},
			terminal: {
				integrated: {
					fontFamily: 'bar',
					fontSize: 2
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().fontSize, 2, 'terminal.integrated.fontSize should be selected over editor.fontSize');

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo',
				fontSize: 0
			},
			terminal: {
				integrated: {
					fontFamily: 0,
					fontSize: 0
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().fontSize, EDITOR_FONT_DEFAULTS.fontSize, 'The default editor font size should be used when editor.fontSize is 0 and terminal.integrated.fontSize not set');

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo',
				fontSize: 0
			},
			terminal: {
				integrated: {
					fontFamily: 0,
					fontSize: -10
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().fontSize, EDITOR_FONT_DEFAULTS.fontSize, 'The default editor font size should be used when editor.fontSize is < 0 and terminal.integrated.fontSize not set');
	});

	test('TerminalConfigHelper - getFont lineHeight', function () {
		let configurationService: IConfigurationService;
		let configHelper: TerminalConfigHelper;

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo',
				lineHeight: 1
			},
			terminal: {
				integrated: {
					fontFamily: 0,
					lineHeight: 2
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().lineHeight, 2, 'terminal.integrated.lineHeight should be selected over editor.lineHeight');

		configurationService = new MockConfigurationService({
			editor: {
				fontFamily: 'foo',
				lineHeight: 1
			},
			terminal: {
				integrated: {
					fontFamily: 0,
					lineHeight: 0
				}
			}
		});
		configHelper = new TerminalConfigHelper(Platform.Linux, configurationService, null, null, null);
		configHelper.panelContainer = fixture;
		assert.equal(configHelper.getFont().lineHeight, 1, 'editor.lineHeight should be 1 when terminal.integrated.lineHeight not set');
	});
});