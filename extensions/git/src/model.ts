/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { workspace, WorkspaceFoldersChangeEvent, Uri, window, Event, EventEmitter, QuickPickItem, Disposable, SourceControl, SourceControlResourceGroup, TextEditor } from 'vscode';
import { Repository } from './repository';
import { memoize } from './decorators';
import { dispose } from './util';
import { Git, GitErrorCodes } from './git';
import * as path from 'path';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

class RepositoryPick implements QuickPickItem {
	@memoize get label(): string { return path.basename(this.repository.root); }
	@memoize get description(): string { return path.dirname(this.repository.root); }
	constructor(public readonly repository: Repository) { }
}

export interface ModelChangeEvent {
	repository: Repository;
	uri: Uri;
}

interface OpenRepository extends Disposable {
	repository: Repository;
}

export class Model {

	private _onDidChangeRepository = new EventEmitter<ModelChangeEvent>();
	readonly onDidChangeRepository: Event<ModelChangeEvent> = this._onDidChangeRepository.event;

	private openRepositories: OpenRepository[] = [];
	get repositories(): Repository[] { return this.openRepositories.map(r => r.repository); }

	private disposables: Disposable[] = [];

	constructor(private git: Git) {
		workspace.onDidChangeWorkspaceFolders(this.onDidChangeWorkspaceFolders, this, this.disposables);
		this.onDidChangeWorkspaceFolders({ added: workspace.workspaceFolders || [], removed: [] });

		window.onDidChangeVisibleTextEditors(this.onDidChangeVisibleTextEditors, this, this.disposables);
		this.onDidChangeVisibleTextEditors(window.visibleTextEditors);
	}

	private async onDidChangeWorkspaceFolders({ added, removed }: WorkspaceFoldersChangeEvent): Promise<void> {
		const possibleRepositoryFolders = added
			.filter(folder => this.validRepository(folder.uri))
			.filter(folder => !this.getOpenRepository(folder.uri));

		const activeRepositoriesList = window.visibleTextEditors
			.map(editor => this.getRepository(editor.document.uri))
			.filter(repository => !!repository) as Repository[];

		const activeRepositories = new Set<Repository>(activeRepositoriesList);
		const openRepositoriesToDispose = removed
			.map(folder => this.getOpenRepository(folder.uri))
			.filter(r => !!r && !activeRepositories.has(r.repository)) as OpenRepository[];

		console.log('lets dispose', openRepositoriesToDispose);

		possibleRepositoryFolders.forEach(p => this.findRepository(p.uri.fsPath));
		openRepositoriesToDispose.forEach(r => r.dispose());
	}

	private onDidChangeVisibleTextEditors(editors: TextEditor[]): void {
		editors.forEach(editor => {
			const uri = editor.document.uri;

			if (uri.scheme !== 'file') {
				return;
			}

			const repository = this.getRepository(uri);

			if (repository) {
				return;
			}

			if (!this.validRepository(uri)) {
				return;
			}

			this.findRepository(path.dirname(uri.fsPath));
		});
	}

	private validRepository(uri: Uri): boolean {
		// This git extension only works for local git repositories, not for remote git
		// repositories. The 'repo' extension is used for remote repositories.
		return !uri.scheme || uri.scheme === 'file';
	}

	private async findRepository(dirPath: string): Promise<void> {
		try {
			const repositoryRoot = await this.git.getRepositoryRoot(dirPath);
			const repository = new Repository(this.git.open(repositoryRoot));

			this.open(repository);
		} catch (err) {
			if (err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
				return;
			}

			console.error('Failed to find repository:', err);
		}
	}

	private open(repository: Repository): void {
		// const onDidDisappearRepository = filterEvent(repository.onDidChangeState, state => state === State.Disposed);
		// const disappearListener = onDidDisappearRepository(() => disposable.dispose());
		const changeListener = repository.onDidChangeRepository(uri => this._onDidChangeRepository.fire({ repository, uri }));
		const dispose = () => {
			// disappearListener.dispose();
			changeListener.dispose();
			repository.dispose();
			this.openRepositories = this.openRepositories.filter(e => e !== openRepository);
		};

		const openRepository = { repository, dispose };
		this.openRepositories.push(openRepository);
	}

	async pickRepository(): Promise<Repository | undefined> {
		if (this.openRepositories.length === 0) {
			throw new Error(localize('no repositories', "There are no available repositories"));
		}

		const picks = this.openRepositories.map(e => new RepositoryPick(e.repository));
		const placeHolder = localize('pick repo', "Choose a repository");
		const pick = await window.showQuickPick(picks, { placeHolder });

		return pick && pick.repository;
	}

	getRepository(sourceControl: SourceControl): Repository | undefined;
	getRepository(resourceGroup: SourceControlResourceGroup): Repository | undefined;
	getRepository(resource: Uri): Repository | undefined;
	getRepository(hint: any): Repository | undefined {
		const liveRepository = this.getOpenRepository(hint);
		return liveRepository && liveRepository.repository;
	}

	private getOpenRepository(sourceControl: SourceControl): OpenRepository | undefined;
	private getOpenRepository(resourceGroup: SourceControlResourceGroup): OpenRepository | undefined;
	private getOpenRepository(resource: Uri): OpenRepository | undefined;
	private getOpenRepository(hint: any): OpenRepository | undefined {
		if (!hint) {
			return undefined;
		}

		if (hint instanceof Uri) {
			const resourcePath = hint.fsPath;

			for (const liveRepository of this.openRepositories) {
				const relativePath = path.relative(liveRepository.repository.root, resourcePath);

				if (!/^\./.test(relativePath)) {
					return liveRepository;
				}
			}

			return undefined;
		}

		for (const liveRepository of this.openRepositories) {
			const repository = liveRepository.repository;

			if (hint === repository.sourceControl) {
				return liveRepository;
			}

			if (hint === repository.mergeGroup || hint === repository.indexGroup || hint === repository.workingTreeGroup) {
				return liveRepository;
			}
		}

		return undefined;
	}

	dispose(): void {
		[...this.openRepositories].forEach(r => r.dispose());
		this.disposables = dispose(this.disposables);
	}
}