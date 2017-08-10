/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ISCMService, ISCMProvider } from 'vs/workbench/services/scm/common/scm';
import { TPromise } from 'vs/base/common/winjs.base';
import { Git } from 'vs/workbench/services/codeComments/browser/git';

/**
 * ISCMProvider that allows tests to mock the output of executeCommand.
 */
class FakeSCMProvider implements ISCMProvider {
	readonly label: any;
	readonly id = 'git';
	readonly rootFolder: any;
	readonly resources: any;
	readonly onDidChange: any;
	readonly count?: any;
	readonly commitTemplate?: any;
	readonly revision?: any;
	readonly onDidChangeCommitTemplate?: any;
	readonly acceptInputCommand?: any;
	readonly statusBarCommands?: any;
	readonly setRevisionCommand?: any;

	/**
	 * Test cases can set the output for executeCommand.
	 */
	public executeCommandOutput: string;

	getOriginalResource(uri: any): any { }
	dispose() { }

	executeCommand(args: string[]): TPromise<string> {
		return TPromise.as(this.executeCommandOutput);
	}
}

/**
 * ISCMService that always uses a FakeSCMProvider.
 */
class FakeSCMService implements ISCMService {
	public _serviceBrand: any;
	readonly onDidChangeProvider: any;
	readonly onDidRegisterProvider: any;
	readonly providers: any;
	readonly input: any;
	activeProvider: any;

	public readonly fakeProvider = new FakeSCMProvider();

	registerSCMProvider(provider: ISCMProvider): any { }

	getProviderForResource(resource: any): ISCMProvider {
		return this.fakeProvider;
	}
}


suite('git', function () {
	let scmService = new FakeSCMService();
	let git = new Git(scmService);

	suite('getRemoteRepo', function () {
		interface Test {
			in: string;
			out: string;
		}
		var accepts = [
			{ in: 'http://github.com/Microsoft/vscode.git', out: 'github.com/Microsoft/vscode' },
			{ in: 'https://github.com/Microsoft/vscode.git', out: 'github.com/Microsoft/vscode' },
			{ in: 'git://github.com/Microsoft/vscode.git', out: 'github.com/Microsoft/vscode' },
			{ in: 'git@github.com:sourcegraph/sourcegraph.git', out: 'github.com/sourcegraph/sourcegraph' },
			{ in: 'user@company.internal:foo/Bar.git', out: 'company.internal/foo/Bar' },
			{ in: 'user@subdomain.company.internal:Bar.git', out: 'subdomain.company.internal/Bar' },
			{ in: 'user@subdomain.company.internal:foo/Bar.git', out: 'subdomain.company.internal/foo/Bar' },
			{ in: 'ssh://user@subdomain.company.com/Bar.git', out: 'subdomain.company.com/Bar' },
			{ in: 'ssh://user@subdomain.company.com/foo/Bar.git', out: 'subdomain.company.com/foo/Bar' },
			{ in: 'https://user@github.com/sourcegraph/sourcegraph/', out: 'github.com/sourcegraph/sourcegraph' },
		];
		accepts.forEach(function (accept) {
			test(`accepts ${accept.in}`, function () {
				scmService.fakeProvider.executeCommandOutput = accept.in;
				return git.getRemoteRepo(null).then(actual => {
					if (actual !== accept.out) {
						throw new Error(`${accept.in} expected ${accept.out} got ${actual}`);
					}
				});
			});
		});

		var rejects = [
			'reject',
			'foo/bar.git',
			'company.com/bar.git',

			// These are technically valid remote urls, but
			// we don't support them because they don't guarantee
			// another user has access to the repo.
			'file:///foo/bar.git',
			'/foo/bar.git',
		];
		rejects.forEach(function (invalid) {
			test(`rejects ${invalid}`, function () {
				scmService.fakeProvider.executeCommandOutput = invalid;
				return new Promise((resolve, reject) => {
					git.getRemoteRepo(null).then(repo => reject(new Error(`expected ${invalid} to be rejected; got ${repo}`)), resolve);
				});
			});
		});
	});
});
