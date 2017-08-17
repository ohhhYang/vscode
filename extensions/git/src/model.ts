/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Uri, window, Event, EventEmitter, QuickPickItem, Disposable, SourceControl, SourceControlResourceGroup } from 'vscode';
import { Repository, State } from './repository';
import { memoize } from './decorators';
import { toDisposable, filterEvent, once } from './util';
import * as path from 'path';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

class RepositoryPick implements QuickPickItem {
	@memoize get label(): string { return path.basename(this.repositoryRoot); }
	@memoize get description(): string { return path.dirname(this.repositoryRoot); }
	constructor(protected repositoryRoot: string, public readonly repository: Repository) { }
}

export interface ModelChangeEvent {
	repository: Repository;
	uri: Uri;
}

export class Model {

	private _onDidChangeRepository = new EventEmitter<ModelChangeEvent>();
	readonly onDidChangeRepository: Event<ModelChangeEvent> = this._onDidChangeRepository.event;

	private repositories: Map<string, Repository> = new Map<string, Repository>();

	register(repository: Repository): Disposable {
		const root = repository.root;

		if (this.repositories.has(root)) {
			// TODO@Joao: what should happen?
			throw new Error('Cant register repository with the same URI');
		}

		this.repositories.set(root, repository);

		const onDidDisappearRepository = filterEvent(repository.onDidChangeState, state => state === State.Disposed);
		const disappearListener = onDidDisappearRepository(() => disposable.dispose());
		const changeListener = repository.onDidChangeRepository(uri => this._onDidChangeRepository.fire({ repository, uri }));

		const disposable = toDisposable(once(() => {
			disappearListener.dispose();
			changeListener.dispose();
			this.repositories.delete(root);
		}));

		return disposable;
	}

	async pickRepository(): Promise<Repository | undefined> {
		if (this.repositories.size === 0) {
			throw new Error(localize('no repositories', "There are no available repositories"));
		}

		// TODO@joao enable this code
		// if (this.repositories.size === 1) {
		//	return this.repositories.values().next().value;
		// }

		const picks = Array.from(this.repositories.entries(), ([uri, model]) => new RepositoryPick(uri, model));
		const placeHolder = localize('pick repo', "Choose a repository");
		const pick = await window.showQuickPick(picks, { placeHolder });

		return pick && pick.repository;
	}

	getRepository(sourceControl: SourceControl): Repository | undefined;
	getRepository(resourceGroup: SourceControlResourceGroup): Repository | undefined;
	getRepository(resource: Uri): Repository | undefined;
	getRepository(hint: any): Repository | undefined {
		if (!hint) {
			return undefined;
		}

		if (hint instanceof Uri) {
			const resourcePath = hint.fsPath;

			for (let [root, repository] of this.repositories) {
				const relativePath = path.relative(root, resourcePath);

				if (!/^\./.test(relativePath)) {
					return repository;
				}
			}

			return undefined;
		}

		for (let [, repository] of this.repositories) {
			if (hint === repository.sourceControl) {
				return repository;
			}

			if (hint === repository.mergeGroup || hint === repository.indexGroup || hint === repository.workingTreeGroup) {
				return repository;
			}
		}

		return undefined;
	}

	dispose(): void {
		for (let [, repository] of this.repositories) {
			repository.dispose();
		}

		this.repositories.clear();
	}
}