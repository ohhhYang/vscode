/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { Registry } from 'vs/platform/registry/common/platform';
import { ParsedArgs, IEnvironmentService } from 'vs/platform/environment/common/environment';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { parseArgs } from 'vs/platform/environment/node/argv';
import extfs = require('vs/base/node/extfs');
import uuid = require('vs/base/common/uuid');
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { WorkspaceService } from 'vs/workbench/services/configuration/node/configurationService';
import { ConfigurationEditingErrorCode } from 'vs/workbench/services/configuration/node/configurationEditingService';
import { FileChangeType, FileChangesEvent, IFileService } from 'vs/platform/files/common/files';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFoldersChangeEvent } from 'vs/platform/workspace/common/workspace';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { workbenchInstantiationService, TestTextResourceConfigurationService, TestTextFileService } from 'vs/workbench/test/workbenchTestServices';
import { FileService } from 'vs/workbench/services/files/node/fileService';
import { TestInstantiationService } from 'vs/platform/instantiation/test/common/instantiationServiceMock';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { TextModelResolverService } from 'vs/workbench/services/textmodelResolver/common/textModelResolverService';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { JSONEditingService } from 'vs/workbench/services/configuration/node/jsonEditingService';

class SettingsTestEnvironmentService extends EnvironmentService {

	constructor(args: ParsedArgs, _execPath: string, private customAppSettingsHome) {
		super(args, _execPath);
	}

	get appSettingsPath(): string { return this.customAppSettingsHome; }
}

function setUpFolderWorkspace(folderName: string): TPromise<{ parentDir: string, folderDir: string }> {
	const id = uuid.generateUuid();
	const parentDir = path.join(os.tmpdir(), 'vsctests', id);
	return setUpFolder(folderName, parentDir).then(folderDir => ({ parentDir, folderDir }));
}

function setUpFolder(folderName: string, parentDir: string): TPromise<string> {
	const folderDir = path.join(parentDir, folderName);
	const workspaceSettingsDir = path.join(folderDir, '.vscode');
	return new TPromise((c, e) => {
		extfs.mkdirp(workspaceSettingsDir, 493, (error) => {
			if (error) {
				e(error);
				return null;
			}
			c(folderDir);
		});
	});
}

function setUpWorkspace(folders: string[]): TPromise<{ parentDir: string, configPath: string }> {

	const id = uuid.generateUuid();
	const parentDir = path.join(os.tmpdir(), 'vsctests', id);

	return createDir(parentDir)
		.then(() => {
			const configPath = path.join(parentDir, 'vsctests.code-workspace');
			const workspace = { folders: folders.map(path => ({ path })) };
			fs.writeFileSync(configPath, JSON.stringify(workspace, null, '\t'));

			return TPromise.join(folders.map(folder => setUpFolder(folder, parentDir)))
				.then(() => ({ parentDir, configPath }));
		});

}

function createDir(dir: string): TPromise<void> {
	return new TPromise((c, e) => {
		extfs.mkdirp(dir, 493, (error) => {
			if (error) {
				e(error);
				return null;
			}
			c(null);
		});
	});
}

suite('WorkspaceContextService - Folder', () => {

	let workspaceName = `testWorkspace${uuid.generateUuid()}`, parentResource: string, workspaceResource: string, workspaceContextService: IWorkspaceContextService;

	setup(() => {
		return setUpFolderWorkspace(workspaceName)
			.then(({ parentDir, folderDir }) => {
				parentResource = parentDir;
				workspaceResource = folderDir;
				const globalSettingsFile = path.join(parentDir, 'settings.json');
				const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, globalSettingsFile);
				workspaceContextService = new WorkspaceService(environmentService, null);
				return (<WorkspaceService>workspaceContextService).initialize(folderDir);
			});
	});

	teardown(done => {
		if (workspaceContextService) {
			(<WorkspaceService>workspaceContextService).dispose();
		}
		if (parentResource) {
			extfs.del(parentResource, os.tmpdir(), () => { }, done);
		}
	});

	test('getWorkspace()', () => {
		const actual = workspaceContextService.getWorkspace();

		assert.equal(actual.folders.length, 1);
		assert.equal(actual.folders[0].uri.fsPath, URI.file(workspaceResource).fsPath);
		assert.equal(actual.folders[0].name, workspaceName);
		assert.equal(actual.folders[0].index, 0);
		assert.ok(!actual.configuration);
	});

	test('getWorkbenchState()', () => {
		const actual = workspaceContextService.getWorkbenchState();

		assert.equal(actual, WorkbenchState.FOLDER);
	});

	test('getWorkspaceFolder()', () => {
		const actual = workspaceContextService.getWorkspaceFolder(URI.file(path.join(workspaceResource, 'a')));

		assert.equal(actual, workspaceContextService.getWorkspace().folders[0]);
	});

	test('isCurrentWorkspace() => true', () => {
		assert.ok(workspaceContextService.isCurrentWorkspace(workspaceResource));
	});

	test('isCurrentWorkspace() => false', () => {
		assert.ok(!workspaceContextService.isCurrentWorkspace(workspaceResource + 'abc'));
	});
});

suite('WorkspaceContextService - Workspace', () => {

	let parentResource: string, testObject: WorkspaceService;

	setup(() => {
		return setUpWorkspace(['a', 'b'])
			.then(({ parentDir, configPath }) => {

				parentResource = parentDir;

				const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, path.join(parentDir, 'settings.json'));
				const workspaceService = new WorkspaceService(environmentService, null);

				const instantiationService = <TestInstantiationService>workbenchInstantiationService();
				instantiationService.stub(IWorkspaceContextService, workspaceService);
				instantiationService.stub(IConfigurationService, workspaceService);
				instantiationService.stub(IEnvironmentService, environmentService);

				return workspaceService.initialize({ id: configPath, configPath }).then(() => {

					instantiationService.stub(IFileService, new FileService(<IWorkspaceContextService>workspaceService, new TestTextResourceConfigurationService(), workspaceService, { disableWatcher: true }));
					instantiationService.stub(ITextFileService, instantiationService.createInstance(TestTextFileService));
					instantiationService.stub(ITextModelService, <ITextModelService>instantiationService.createInstance(TextModelResolverService));
					workspaceService.setInstantiationService(instantiationService);

					testObject = workspaceService;
				});
			});
	});

	teardown(done => {
		if (testObject) {
			(<WorkspaceService>testObject).dispose();
		}
		if (parentResource) {
			extfs.del(parentResource, os.tmpdir(), () => { }, done);
		}
	});

	test('workspace folders', () => {
		const actual = testObject.getWorkspace().folders;

		assert.equal(actual.length, 2);
		assert.equal(path.basename(actual[0].uri.fsPath), 'a');
		assert.equal(path.basename(actual[1].uri.fsPath), 'b');
	});

	test('add folders', () => {
		const workspaceDir = path.dirname(testObject.getWorkspace().folders[0].uri.fsPath);
		return testObject.addFolders([{ uri: URI.file(path.join(workspaceDir, 'd')) }, { uri: URI.file(path.join(workspaceDir, 'c')) }])
			.then(() => {
				const actual = testObject.getWorkspace().folders;

				assert.equal(actual.length, 4);
				assert.equal(path.basename(actual[0].uri.fsPath), 'a');
				assert.equal(path.basename(actual[1].uri.fsPath), 'b');
				assert.equal(path.basename(actual[2].uri.fsPath), 'd');
				assert.equal(path.basename(actual[3].uri.fsPath), 'c');
			});
	});

	test('add folders (with name)', () => {
		const workspaceDir = path.dirname(testObject.getWorkspace().folders[0].uri.fsPath);
		return testObject.addFolders([{ uri: URI.file(path.join(workspaceDir, 'd')), name: 'DDD' }, { uri: URI.file(path.join(workspaceDir, 'c')), name: 'CCC' }])
			.then(() => {
				const actual = testObject.getWorkspace().folders;

				assert.equal(actual.length, 4);
				assert.equal(path.basename(actual[0].uri.fsPath), 'a');
				assert.equal(path.basename(actual[1].uri.fsPath), 'b');
				assert.equal(path.basename(actual[2].uri.fsPath), 'd');
				assert.equal(path.basename(actual[3].uri.fsPath), 'c');
				assert.equal(actual[2].name, 'DDD');
				assert.equal(actual[3].name, 'CCC');
			});
	});

	test('add folders triggers change event', () => {
		const target = sinon.spy();
		testObject.onDidChangeWorkspaceFolders(target);
		const workspaceDir = path.dirname(testObject.getWorkspace().folders[0].uri.fsPath);
		const addedFolders = [{ uri: URI.file(path.join(workspaceDir, 'd')) }, { uri: URI.file(path.join(workspaceDir, 'c')) }];
		return testObject.addFolders(addedFolders)
			.then(() => {
				assert.ok(target.calledOnce);
				const actual = <IWorkspaceFoldersChangeEvent>target.args[0][0];
				assert.deepEqual(actual.added.map(r => r.uri.toString()), addedFolders.map(a => a.uri.toString()));
				assert.deepEqual(actual.removed, []);
				assert.deepEqual(actual.changed, []);
			});
	});

	test('remove folders', () => {
		return testObject.removeFolders([testObject.getWorkspace().folders[0].uri])
			.then(() => {
				const actual = testObject.getWorkspace().folders;
				assert.equal(actual.length, 1);
				assert.equal(path.basename(actual[0].uri.fsPath), 'b');
			});
	});

	test('remove folders triggers change event', () => {
		const target = sinon.spy();
		testObject.onDidChangeWorkspaceFolders(target);
		const removedFolder = testObject.getWorkspace().folders[0];
		return testObject.removeFolders([removedFolder.uri])
			.then(() => {
				assert.ok(target.calledOnce);
				const actual = <IWorkspaceFoldersChangeEvent>target.args[0][0];
				assert.deepEqual(actual.added, []);
				assert.deepEqual(actual.removed.map(r => r.uri.toString()), [removedFolder.uri.toString()]);
				assert.deepEqual(actual.changed.map(c => c.uri.toString()), [testObject.getWorkspace().folders[0].uri.toString()]);
			});
	});

	test('reorder folders trigger change event', () => {
		const target = sinon.spy();
		testObject.onDidChangeWorkspaceFolders(target);
		const workspace = { folders: [{ path: testObject.getWorkspace().folders[1].uri.fsPath }, { path: testObject.getWorkspace().folders[0].uri.fsPath }] };
		fs.writeFileSync(testObject.getWorkspace().configuration.fsPath, JSON.stringify(workspace, null, '\t'));
		return testObject.reloadConfiguration()
			.then(() => {
				assert.ok(target.calledOnce);
				const actual = <IWorkspaceFoldersChangeEvent>target.args[0][0];
				assert.deepEqual(actual.added, []);
				assert.deepEqual(actual.removed, []);
				assert.deepEqual(actual.changed.map(c => c.uri.toString()), testObject.getWorkspace().folders.map(f => f.uri.toString()).reverse());
			});
	});

	test('rename folders trigger change event', () => {
		const target = sinon.spy();
		testObject.onDidChangeWorkspaceFolders(target);
		const workspace = { folders: [{ path: testObject.getWorkspace().folders[0].uri.fsPath, name: '1' }, { path: testObject.getWorkspace().folders[1].uri.fsPath }] };
		fs.writeFileSync(testObject.getWorkspace().configuration.fsPath, JSON.stringify(workspace, null, '\t'));
		return testObject.reloadConfiguration()
			.then(() => {
				assert.ok(target.calledOnce);
				const actual = <IWorkspaceFoldersChangeEvent>target.args[0][0];
				assert.deepEqual(actual.added, []);
				assert.deepEqual(actual.removed, []);
				assert.deepEqual(actual.changed.map(c => c.uri.toString()), [testObject.getWorkspace().folders[0].uri.toString()]);
			});
	});

});

suite('WorkspaceConfigurationService - Folder', () => {

	let workspaceName = `testWorkspace${uuid.generateUuid()}`, parentResource: string, workspaceDir: string, testObject: IConfigurationService, globalSettingsFile: string;

	suiteSetup(() => {
		const configurationRegistry = <IConfigurationRegistry>Registry.as(ConfigurationExtensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': '_test',
			'type': 'object',
			'properties': {
				'configurationService.folder.testSetting': {
					'type': 'string',
					'default': 'isSet'
				},
			}
		});
	});

	setup(() => {
		return setUpFolderWorkspace(workspaceName)
			.then(({ parentDir, folderDir }) => {

				parentResource = parentDir;
				workspaceDir = folderDir;
				globalSettingsFile = path.join(parentDir, 'settings.json');

				const instantiationService = <TestInstantiationService>workbenchInstantiationService();
				const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, globalSettingsFile);
				const workspaceService = new WorkspaceService(environmentService, null);
				instantiationService.stub(IWorkspaceContextService, workspaceService);
				instantiationService.stub(IConfigurationService, workspaceService);
				instantiationService.stub(IEnvironmentService, environmentService);

				return workspaceService.initialize(folderDir).then(() => {
					instantiationService.stub(IFileService, new FileService(<IWorkspaceContextService>workspaceService, new TestTextResourceConfigurationService(), workspaceService, { disableWatcher: true }));
					instantiationService.stub(ITextFileService, instantiationService.createInstance(TestTextFileService));
					instantiationService.stub(ITextModelService, <ITextModelService>instantiationService.createInstance(TextModelResolverService));
					workspaceService.setInstantiationService(instantiationService);
					testObject = workspaceService;
				});
			});
	});

	teardown(done => {
		if (testObject) {
			(<WorkspaceService>testObject).dispose();
		}
		if (parentResource) {
			extfs.del(parentResource, os.tmpdir(), () => { }, done);
		}
	});

	test('defaults', () => {
		assert.deepEqual(testObject.getValue('configurationService'), { 'folder': { 'testSetting': 'isSet' } });
	});

	test('globals override defaults', () => {
		fs.writeFileSync(globalSettingsFile, '{ "configurationService.folder.testSetting": "userValue" }');
		return testObject.reloadConfiguration()
			.then(() => assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'userValue'));
	});

	test('globals', () => {
		fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": true }');
		return testObject.reloadConfiguration()
			.then(() => assert.equal(testObject.getValue('testworkbench.editor.tabs'), true));
	});

	test('workspace settings', () => {
		fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "testworkbench.editor.icons": true }');
		return testObject.reloadConfiguration()
			.then(() => assert.equal(testObject.getValue('testworkbench.editor.icons'), true));
	});

	test('workspace settings override user settings', () => {
		fs.writeFileSync(globalSettingsFile, '{ "configurationService.folder.testSetting": "userValue" }');
		fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue" }');
		return testObject.reloadConfiguration()
			.then(() => assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'workspaceValue'));
	});

	test('workspace change triggers event', () => {
		const settingsFile = path.join(workspaceDir, '.vscode', 'settings.json');
		fs.writeFileSync(settingsFile, '{ "configurationService.folder.testSetting": "workspaceValue" }');
		const event = new FileChangesEvent([{ resource: URI.file(settingsFile), type: FileChangeType.ADDED }]);
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return (<WorkspaceService>testObject).handleWorkspaceFileEvents(event)
			.then(() => {
				assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'workspaceValue');
				assert.ok(target.called);
			});
	});

	test('reload configuration emits events after global configuraiton changes', () => {
		fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": true }');
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.reloadConfiguration().then(() => assert.ok(target.called));
	});

	test('reload configuration emits events after workspace configuraiton changes', () => {
		fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue" }');
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.reloadConfiguration().then(() => assert.ok(target.called));
	});

	test('reload configuration should not emit event if no changes', () => {
		fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": true }');
		fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue" }');
		return testObject.reloadConfiguration()
			.then(() => {
				const target = sinon.spy();
				testObject.onDidChangeConfiguration(() => { target(); });
				return testObject.reloadConfiguration()
					.then(() => assert.ok(!target.called));
			});
	});

	test('inspect', () => {
		let actual = testObject.inspect('something.missing');
		assert.equal(actual.default, void 0);
		assert.equal(actual.user, void 0);
		assert.equal(actual.workspace, void 0);
		assert.equal(actual.workspaceFolder, void 0);
		assert.equal(actual.value, void 0);

		actual = testObject.inspect('configurationService.folder.testSetting');
		assert.equal(actual.default, 'isSet');
		assert.equal(actual.user, void 0);
		assert.equal(actual.workspace, void 0);
		assert.equal(actual.workspaceFolder, void 0);
		assert.equal(actual.value, 'isSet');

		fs.writeFileSync(globalSettingsFile, '{ "configurationService.folder.testSetting": "userValue" }');
		return testObject.reloadConfiguration()
			.then(() => {
				actual = testObject.inspect('configurationService.folder.testSetting');
				assert.equal(actual.default, 'isSet');
				assert.equal(actual.user, 'userValue');
				assert.equal(actual.workspace, void 0);
				assert.equal(actual.workspaceFolder, void 0);
				assert.equal(actual.value, 'userValue');

				fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue" }');

				return testObject.reloadConfiguration()
					.then(() => {
						actual = testObject.inspect('configurationService.folder.testSetting');
						assert.equal(actual.default, 'isSet');
						assert.equal(actual.user, 'userValue');
						assert.equal(actual.workspace, 'workspaceValue');
						assert.equal(actual.workspaceFolder, void 0);
						assert.equal(actual.value, 'workspaceValue');
					});
			});
	});

	test('keys', () => {
		let actual = testObject.keys();
		assert.ok(actual.default.indexOf('configurationService.folder.testSetting') !== -1);
		assert.deepEqual(actual.user, []);
		assert.deepEqual(actual.workspace, []);
		assert.deepEqual(actual.workspaceFolder, []);

		fs.writeFileSync(globalSettingsFile, '{ "configurationService.folder.testSetting": "userValue" }');
		return testObject.reloadConfiguration()
			.then(() => {
				actual = testObject.keys();
				assert.ok(actual.default.indexOf('configurationService.folder.testSetting') !== -1);
				assert.deepEqual(actual.user, ['configurationService.folder.testSetting']);
				assert.deepEqual(actual.workspace, []);
				assert.deepEqual(actual.workspaceFolder, []);

				fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue" }');

				return testObject.reloadConfiguration()
					.then(() => {
						actual = testObject.keys();
						assert.ok(actual.default.indexOf('configurationService.folder.testSetting') !== -1);
						assert.deepEqual(actual.user, ['configurationService.folder.testSetting']);
						assert.deepEqual(actual.workspace, ['configurationService.folder.testSetting']);
						assert.deepEqual(actual.workspaceFolder, []);
					});
			});
	});

	test('update user configuration', () => {
		return testObject.updateValue('configurationService.folder.testSetting', 'value', ConfigurationTarget.USER)
			.then(() => assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'value'));
	});

	test('update workspace configuration', () => {
		return testObject.updateValue('tasks.service.testSetting', 'value', ConfigurationTarget.WORKSPACE)
			.then(() => assert.equal(testObject.getValue('tasks.service.testSetting'), 'value'));
	});

	test('update tasks configuration', () => {
		return testObject.updateValue('tasks', { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }, ConfigurationTarget.WORKSPACE)
			.then(() => assert.deepEqual(testObject.getValue('tasks'), { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }));
	});

	test('update user configuration should trigger change event before promise is resolve', () => {
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('configurationService.folder.testSetting', 'value', ConfigurationTarget.USER)
			.then(() => assert.ok(target.called));
	});

	test('update workspace configuration should trigger change event before promise is resolve', () => {
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('configurationService.folder.testSetting', 'value', ConfigurationTarget.WORKSPACE)
			.then(() => assert.ok(target.called));
	});

	test('update task configuration should trigger change event before promise is resolve', () => {
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('tasks', { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }, ConfigurationTarget.WORKSPACE)
			.then(() => assert.ok(target.called));
	});

	test('initialize with different folder triggers configuration event if there are changes', () => {
		return setUpFolderWorkspace(`testWorkspace${uuid.generateUuid()}`)
			.then(({ folderDir }) => {
				const target = sinon.spy();
				testObject.onDidChangeConfiguration(target);

				fs.writeFileSync(path.join(folderDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue2" }');
				return (<WorkspaceService>testObject).initialize(folderDir)
					.then(() => {
						assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'workspaceValue2');
						assert.ok(target.called);
					});
			});
	});

	test('initialize with different folder triggers configuration event if there are no changes', () => {
		fs.writeFileSync(globalSettingsFile, '{ "configurationService.folder.testSetting": "workspaceValue2" }');
		return testObject.reloadConfiguration()
			.then(() => setUpFolderWorkspace(`testWorkspace${uuid.generateUuid()}`))
			.then(({ folderDir }) => {
				const target = sinon.spy();
				testObject.onDidChangeConfiguration(() => target());
				fs.writeFileSync(path.join(folderDir, '.vscode', 'settings.json'), '{ "configurationService.folder.testSetting": "workspaceValue2" }');
				return (<WorkspaceService>testObject).initialize(folderDir)
					.then(() => {
						assert.equal(testObject.getValue('configurationService.folder.testSetting'), 'workspaceValue2');
						assert.ok(!target.called);
					});
			});
	});
});

suite('WorkspaceConfigurationService - Update (Multiroot)', () => {

	let parentResource: string, workspaceContextService: IWorkspaceContextService, jsonEditingServce: IJSONEditingService, testObject: IConfigurationService;

	suiteSetup(() => {
		const configurationRegistry = <IConfigurationRegistry>Registry.as(ConfigurationExtensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': '_test',
			'type': 'object',
			'properties': {
				'configurationService.workspace.testSetting': {
					'type': 'string',
					'default': 'isSet'
				},
				'configurationService.workspace.testResourceSetting': {
					'type': 'string',
					'default': 'isSet',
					scope: ConfigurationScope.RESOURCE
				}
			}
		});
	});

	setup(() => {
		return setUpWorkspace(['1', '2'])
			.then(({ parentDir, configPath }) => {

				parentResource = parentDir;

				const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, path.join(parentDir, 'settings.json'));
				const workspaceService = new WorkspaceService(environmentService, null);

				const instantiationService = <TestInstantiationService>workbenchInstantiationService();
				instantiationService.stub(IWorkspaceContextService, workspaceService);
				instantiationService.stub(IConfigurationService, workspaceService);
				instantiationService.stub(IEnvironmentService, environmentService);

				return workspaceService.initialize({ id: configPath, configPath }).then(() => {

					instantiationService.stub(IFileService, new FileService(<IWorkspaceContextService>workspaceService, new TestTextResourceConfigurationService(), workspaceService, { disableWatcher: true }));
					instantiationService.stub(ITextFileService, instantiationService.createInstance(TestTextFileService));
					instantiationService.stub(ITextModelService, <ITextModelService>instantiationService.createInstance(TextModelResolverService));
					workspaceService.setInstantiationService(instantiationService);

					workspaceContextService = workspaceService;
					jsonEditingServce = instantiationService.createInstance(JSONEditingService);
					testObject = workspaceService;
				});
			});
	});

	teardown(done => {
		if (testObject) {
			(<WorkspaceService>testObject).dispose();
		}
		if (parentResource) {
			extfs.del(parentResource, os.tmpdir(), () => { }, done);
		}
	});

	test('update user configuration', () => {
		return testObject.updateValue('configurationService.workspace.testSetting', 'userValue', ConfigurationTarget.USER)
			.then(() => assert.equal(testObject.getValue('configurationService.workspace.testSetting'), 'userValue'));
	});

	test('update user configuration should trigger change event before promise is resolve', () => {
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('configurationService.workspace.testSetting', 'userValue', ConfigurationTarget.USER)
			.then(() => assert.ok(target.called));
	});

	test('update workspace configuration', () => {
		return testObject.updateValue('configurationService.workspace.testSetting', 'workspaceValue', ConfigurationTarget.WORKSPACE)
			.then(() => assert.equal(testObject.getValue('configurationService.workspace.testSetting'), 'workspaceValue'));
	});

	test('update workspace configuration should trigger change event before promise is resolve', () => {
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('configurationService.workspace.testSetting', 'workspaceValue', ConfigurationTarget.WORKSPACE)
			.then(() => assert.ok(target.called));
	});

	test('update workspace folder configuration', () => {
		const workspace = workspaceContextService.getWorkspace();
		return testObject.updateValue('configurationService.workspace.testResourceSetting', 'workspaceFolderValue', { resource: workspace.folders[0].uri }, ConfigurationTarget.WORKSPACE_FOLDER)
			.then(() => assert.equal(testObject.getValue('configurationService.workspace.testResourceSetting', { resource: workspace.folders[0].uri }), 'workspaceFolderValue'));
	});

	test('update workspace folder configuration should trigger change event before promise is resolve', () => {
		const workspace = workspaceContextService.getWorkspace();
		const target = sinon.spy();
		testObject.onDidChangeConfiguration(target);
		return testObject.updateValue('configurationService.workspace.testResourceSetting', 'workspaceFolderValue', { resource: workspace.folders[0].uri }, ConfigurationTarget.WORKSPACE_FOLDER)
			.then(() => assert.ok(target.called));
	});

	test('update tasks configuration in a folder', () => {
		const workspace = workspaceContextService.getWorkspace();
		return testObject.updateValue('tasks', { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }, { resource: workspace.folders[0].uri }, ConfigurationTarget.WORKSPACE_FOLDER)
			.then(() => assert.deepEqual(testObject.getValue('tasks', { resource: workspace.folders[0].uri }), { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }));
	});

	test('update tasks configuration in a workspace is not supported', () => {
		const workspace = workspaceContextService.getWorkspace();
		return testObject.updateValue('tasks', { 'version': '1.0.0', tasks: [{ 'taskName': 'myTask' }] }, { resource: workspace.folders[0].uri }, ConfigurationTarget.WORKSPACE, true)
			.then(() => assert.fail('Should not be supported'), (e) => assert.equal(e.code, ConfigurationEditingErrorCode.ERROR_INVALID_WORKSPACE_TARGET));
	});

	test('update launch configuration in a workspace is not supported', () => {
		const workspace = workspaceContextService.getWorkspace();
		return testObject.updateValue('launch', { 'version': '1.0.0', configurations: [{ 'name': 'myLaunch' }] }, { resource: workspace.folders[0].uri }, ConfigurationTarget.WORKSPACE, true)
			.then(() => assert.fail('Should not be supported'), (e) => assert.equal(e.code, ConfigurationEditingErrorCode.ERROR_INVALID_WORKSPACE_TARGET));
	});

	test('task configurations are not read from workspace', () => {
		return jsonEditingServce.write(workspaceContextService.getWorkspace().configuration, { key: 'tasks', value: { 'version': '1.0' } }, true)
			.then(() => testObject.reloadConfiguration())
			.then(() => {
				const actual = testObject.inspect('tasks.version');
				assert.equal(actual.workspace, void 0);
			});
	});

	test('launch configurations are not read from workspace', () => {
		return jsonEditingServce.write(workspaceContextService.getWorkspace().configuration, { key: 'launch', value: { 'version': '1.0' } }, true)
			.then(() => testObject.reloadConfiguration())
			.then(() => {
				const actual = testObject.inspect('launch.version');
				assert.equal(actual.workspace, void 0);
			});
	});
});
