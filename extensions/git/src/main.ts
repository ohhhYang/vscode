/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();
import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel } from 'vscode';
import { findGit, Git, IGit } from './git';
import { Repository } from './repository';
import { Model } from './model';
import { CommandCenter } from './commands';
import { GitContentProvider } from './contentProvider';
// import { AutoFetcher } from './autofetch';
import { Askpass } from './askpass';
import { toDisposable } from './util';
import TelemetryReporter from 'vscode-extension-telemetry';

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> {
	const { name, version, aiKey } = require(context.asAbsolutePath('./package.json')) as { name: string, version: string, aiKey: string };
	const telemetryReporter: TelemetryReporter = new TelemetryReporter(name, version, aiKey);
	disposables.push(telemetryReporter);

	const outputChannel = window.createOutputChannel('Git');
	disposables.push(outputChannel);

	const config = workspace.getConfiguration('git');
	const enabled = config.get<boolean>('enabled') === true;
	const pathHint = workspace.getConfiguration('git').get<string>('path');
	const info = await findGit(pathHint);
	const askpass = new Askpass();
	const env = await askpass.getEnv();
	const git = new Git({ gitPath: info.path, version: info.version, env });
	const model = new Model();
	disposables.push(model);

	if (!enabled) {
		const commandCenter = new CommandCenter(git, model, outputChannel, telemetryReporter);
		disposables.push(commandCenter);
		return;
	}

	for (const folder of workspace.workspaceFolders || []) {
		if (folder.uri.scheme && folder.uri.scheme !== 'file') {
			// This git extension only works for local git repositories, not for remote git
			// repositories. The 'repo' extension is used for remote repositories.
			continue;
		}

		const repositoryRoot = await git.getRepositoryRoot(folder.uri.fsPath);
		const repository = new Repository(git.open(repositoryRoot));

		model.register(repository);
	}

	outputChannel.appendLine(localize('using git', "Using git {0} from {1}", info.version, info.path));

	const onOutput = str => outputChannel.append(str);
	git.onOutput.addListener('log', onOutput);
	disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

	const commandCenter = new CommandCenter(git, model, outputChannel, telemetryReporter);
	const contentProvider = new GitContentProvider(model);
	// const autoFetcher = new AutoFetcher(repository);

	disposables.push(
		commandCenter,
		contentProvider,
		// autoFetcher,
		// repository
	);

	await checkGitVersion(info);
}

export function activate(context: ExtensionContext): any {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	workspace.onDidChangeWorkspaceFolders(e => {
		disposables.forEach(d => d.dispose());
		disposables.length = 0;
		init(context, disposables).catch(err => console.error(err));
	});

	init(context, disposables)
		.catch(err => console.error(err));
}

async function checkGitVersion(info: IGit): Promise<void> {
	const config = workspace.getConfiguration('git');
	const shouldIgnore = config.get<boolean>('ignoreLegacyWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!/^[01]/.test(info.version)) {
		return;
	}

	const update = localize('updateGit', "Update Git");
	const neverShowAgain = localize('neverShowAgain', "Don't show again");

	const choice = await window.showWarningMessage(
		localize('git20', "You seem to have git {0} installed. Code works best with git >= 2", info.version),
		update,
		neverShowAgain
	);

	if (choice === update) {
		commands.executeCommand('vscode.open', Uri.parse('https://git-scm.com/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreLegacyWarning', true, true);
	}
}