/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { localize } from 'vs/nls';
import { ICodeCommentsService, IBranchComments, IFileComments, IThreadComments, IComment, ICommentAuthor, IDraftThreadComments } from 'vs/editor/common/services/codeCommentsService';
import { Range } from 'vs/editor/common/core/range';
import Event, { Emitter, any } from 'vs/base/common/event';
import { VSDiff as Diff } from 'vs/workbench/services/codeComments/common/vsdiff';
import { Disposable } from 'vs/workbench/services/codeComments/common/disposable';
import { ISCMService, ISCMRepository } from 'vs/workbench/services/scm/common/scm';
import { Git } from 'vs/workbench/services/codeComments/browser/git';
import URI from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';
import { startsWith } from 'vs/base/common/strings';
import { IRemoteService, requestGraphQL, requestGraphQLMutation } from 'vs/platform/remote/node/remote';
import { TPromise } from 'vs/base/common/winjs.base';
import { first, uniqueFilter, coalesce } from 'vs/base/common/arrays';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ICommonCodeEditor, IModel } from 'vs/editor/common/editorCommon';
import { RawTextSource } from 'vs/editor/common/model/textSource';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { StrictResourceMap } from 'vs/base/common/map';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { InterruptibleDelayer, ThrottledDelayer } from 'vs/base/common/async';
import { IAuthService } from 'vs/platform/auth/common/auth';
import { DiffWorkerClient } from 'vs/workbench/services/codeComments/node/diffWorkerClient';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { TextModel } from 'vs/editor/common/model/textModel';
// TODO(nick): fix this
// tslint:disable-next-line:import-patterns
import { IOutputService } from 'vs/workbench/parts/output/common/output';
// TODO(nick): fix this
// tslint:disable-next-line:import-patterns
import { CommentsChannelId } from 'vs/workbench/parts/codeComments/common/constants';

export { Event }

/**
 * A unique identifier for a file.
 */
interface DocumentId {
	/**
	 * The repo identifier (e.g. github.com/sourcegraph/sourcegraph).
	 */
	repo: string;

	/**
	 * The file identifier (e.g. dev/start.sh).
	 * It is relative to the repo.
	 */
	file: string;
}

/**
 * Graphql representation of a comment.
 */
const commentsGraphql = `
comments {
	id
	contents
	createdAt
	updatedAt
	author {
		displayName
		email
	}
}`;

/**
 * Graphql representation of an entire thread and its comments.
 */
const threadGraphql = `
id
title
file
revision
startLine
endLine
startCharacter
endCharacter
createdAt
archivedAt
${commentsGraphql}`;


export class CodeCommentsService implements ICodeCommentsService {
	public _serviceBrand: any;

	/**
	 * Map of file uri -> model.
	 */
	private models = new StrictResourceMap<FileComments>();

	private diffWorkerProvider: DiffWorkerClient;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IOutputService private outputService: IOutputService,
	) {
		this.diffWorkerProvider = new DiffWorkerClient(environmentService.debugDiff);
	}

	/**
	 * See documentation on ICodeCommentsService.
	 */
	public getFileComments(file: URI): FileComments {
		// TODO(nick): prevent memory from growing unbounded.
		// We should tie the lifecycle of our code comments models to the lifecycle of the
		// editor models that they are attached to; however, we woud need to persist certain data
		// like draft threads and draft replies so they could be restored.
		let model = this.models.get(file);
		if (!model) {
			model = this.instantiationService.createInstance(FileComments, this.diffWorkerProvider, file);
			this.models.set(file, model);
		}
		return model;
	}

	public getBranchComments(repo: URI, branch: string): BranchComments {
		return this.instantiationService.createInstance(BranchComments, repo, branch);
	}
}

export class BranchComments extends Disposable implements IBranchComments {

	private _threads: ThreadComments[] = [];
	private didChangeThreads = this.disposable(new Emitter<void>());
	public readonly onDidChangeThreads = this.didChangeThreads.event;
	public get threads(): ThreadComments[] {
		return this._threads;
	}

	private git: Git;

	constructor(
		private repo: URI,
		private branch: string,
		@ISCMService scmService: ISCMService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IRemoteService private remoteService: IRemoteService,
		@IAuthService private authService: IAuthService,
	) {
		super();
		this.git = new Git(repo, scmService);
	}

	private refreshDelayer = new ThrottledDelayer<void>(100);
	public refresh(): TPromise<void> {
		return this.refreshDelayer.trigger(() => this.refreshNow());
	}

	private refreshNow(): TPromise<void> {
		return this.git.getRemoteRepo()
			.then(repo => {
				if (!this.authService.currentUser || !this.authService.currentUser.currentOrgMember) {
					return TPromise.as(undefined);
				}
				return requestGraphQL<{ org: { repo: { threads: GQL.IThread[] } } }>(this.remoteService, `query ThreadsForBranch (
					$file: String!,
				) {
					root {
						org(id: $orgId) {
							repo(remoteURI: $remoteURI) {
								threads(branch: $branch) {
									${threadGraphql}
								}
							}
						}
					}
				}`, {
						orgId: this.authService.currentUser.currentOrgMember.org.id,
						branch: this.branch,
						remoteURI: repo,
					});
			})
			.then(response => {
				const threads = (response && response.org.repo && response.org.repo.threads) || [];

				// Although we are updating this._threads here, we don't fire
				// threadsDidChange until the display ranges have updated.
				this._threads = this.instantiationService.invokeFunction(updatedThreads, this.git, this._threads, threads);
				// TODO(nick): figure out display ranges
				this.didChangeThreads.fire();
				// return this.updateDisplayRanges();
			});
	}
}

/**
 * Model for comments on a file.
 */
export class FileComments extends Disposable implements IFileComments {

	private modelWatcher: ModelWatcher;

	private _threads: ThreadComments[] = [];
	private didChangeThreads = this.disposable(new Emitter<void>());
	public readonly onDidChangeThreads = this.didChangeThreads.event;
	public get threads(): ThreadComments[] {
		return this._threads;
	}
	public getThread(id: number): IThreadComments | undefined {
		return first(this.threads, thread => thread.id === id);
	}

	private _draftThreads: DraftThreadComments[] = [];
	private didChangeDraftThreads = this.disposable(new Emitter<void>());
	public readonly onDidChangeDraftThreads = this.didChangeDraftThreads.event;
	public get draftThreads(): DraftThreadComments[] {
		return this._draftThreads;
	}
	public getDraftThread(id: number): DraftThreadComments | undefined {
		return first(this.draftThreads, thread => thread.id === id);
	}

	private git: Git;
	private scmRepository: ISCMRepository;

	constructor(
		private diffWorker: DiffWorkerClient,
		uri: URI,
		@ISCMService scmService: ISCMService,
		@IModelService private modelService: IModelService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IRemoteService private remoteService: IRemoteService,
		@IAuthService private authService: IAuthService,
		@IOutputService private outputService: IOutputService,
	) {
		super();
		this.git = instantiationService.createInstance(Git, uri);

		this.modelWatcher = this.disposable(instantiationService.createInstance(ModelWatcher, uri));
		this.disposable(this.modelWatcher.onDidChangeContent(() => {
			this.updateDisplayRanges();
		}));

		this.disposable(any(
			scmService.onDidAddRepository,
			scmService.onDidRemoveRepository,
			scmService.onDidChangeRepository
		)(() => {
			const scmRepository = scmService.getRepositoryForResource(this.modelWatcher.uri);
			if (this.scmRepository !== scmRepository) {
				this.scmRepository = scmRepository;
				if (scmRepository) {
					this.refreshThreads();
				}
			}
		}));

		this.disposable(this.authService.onDidChangeCurrentUser(() => this.refreshThreads()));
	}

	public dispose() {
		this._threads = dispose(this._threads);
		this._draftThreads = dispose(this._draftThreads);
		super.dispose();
	}

	/**
	 * See documentation on IFileComments.
	 */
	public createDraftThread(editor: ICommonCodeEditor): DraftThreadComments {
		const draft = this.instantiationService.createInstance(DraftThreadComments, editor, this.git);
		draft.onDidSubmit(thread => {
			draft.dispose();
			// Although we are updating this._threads here, we don't fire
			// threadsDidChange until the display ranges have updated.
			this._threads.unshift(thread);
			this.updateDisplayRanges();
		});
		draft.onWillDispose(() => {
			const idx = this._draftThreads.indexOf(draft);
			if (idx < 0) {
				return;
			}
			this._draftThreads.splice(idx, 1);
			this.didChangeDraftThreads.fire();
		});
		this._draftThreads.push(draft);
		this.didChangeDraftThreads.fire();
		return draft;
	}

	public refreshingThreads = TPromise.wrap<void>(undefined);
	private refreshThreadsDelayer = new ThrottledDelayer<void>(100);
	private didStartRefreshing = this.disposable(new Emitter<void>());
	public onDidStartRefreshingThreads = this.didStartRefreshing.event;

	/**
	 * See documentation on IFileComments.
	 */
	public refreshThreads(): TPromise<void> {
		return this.refreshThreadsDelayer.trigger(() => this.refreshThreadsNow());
	}

	private refreshThreadsNow(): TPromise<void> {
		this.refreshingThreads = this.getDocumentId()
			.then(documentId => {
				if (!documentId || !this.authService.currentUser || !this.authService.currentUser.currentOrgMember) {
					return TPromise.wrap(undefined);
				}
				return requestGraphQL<{ org: { repo: { threads: GQL.IThread[] } } }>(this.remoteService, `query ThreadsForFile (
						$file: String!,
					) {
						root {
							org(id: $orgId) {
								repo(remoteURI: $remoteURI) {
									threads(file: $file) {
										${threadGraphql}
									}
								}
							}
						}
					}`, {
						orgId: this.authService.currentUser.currentOrgMember.org.id,
						file: documentId.file,
						remoteURI: documentId.repo,
					});
			})
			.then(response => {
				const threads = (response && response.org.repo && response.org.repo.threads) || [];
				// Although we are updating this._threads here, we don't fire
				// threadsDidChange until the display ranges have updated.
				this._threads = this.instantiationService.invokeFunction(updatedThreads, this.git, this._threads, threads);
				return this.updateDisplayRanges();
			});

		this.didStartRefreshing.fire();
		return this.refreshingThreads;
	}

	/**
	 * Returns a canonical identifier for the local file path, or undefined for resources
	 * that don't support code comments.
	 *
	 * For example:
	 * file:///Users/nick/dev/src/README.md -> github.com/sourcegraph/src/README.md
	 */
	private getDocumentId(): TPromise<DocumentId | undefined> {
		if (this.modelWatcher.uri.scheme !== Schemas.file) {
			return TPromise.as(void 0);
		}
		return TPromise.join([
			this.instantiationService.invokeFunction(getPathRelativeToRepo, this.modelWatcher.uri),
			this.git.getRemoteRepo(),
		])
			.then(([relativeFile, repo]) => {
				return { repo, file: relativeFile };
			})
			.then(docId => docId, err => {
				// These errors happen a lot on startup because the source control providers
				// arent registered yet. It isn't a problem on startup because we just retry later
				// when the source control providers change.
				const error = Array.isArray(err) ? err[0] : err;
				this.outputService.getChannel(CommentsChannelId).append(error.message);
				return undefined;
			});
	}

	private updateDisplayRangeDelayer = new InterruptibleDelayer<void>(1000);

	private updateDisplayRanges(): TPromise<void> {
		return this.updateDisplayRangeDelayer.trigger(() => {
			return this.updateDisplayRangesNow();
		});
	}

	private updateDisplayRangesNow(): TPromise<void> {
		return this.getDocumentId()
			.then<{ revision: string, content: string }[]>(documentId => {
				if (!documentId) {
					return TPromise.wrap(undefined);
				}
				return TPromise.join(
					this.threads
						// TODO(nick): ideally we don't want to compute display ranges for archived threads
						// unless the user actually clicks on it. For now, we compute them up front because
						// we don't have lazy computation yet.
						// .filter(thread => !thread.archived)
						.filter(uniqueFilter(thread => thread.revision))
						.map(thread => this.instantiationService.invokeFunction(resolveContent, this.git, documentId, thread.revision)
							.then(content => content, err => {
								this.outputService.getChannel(CommentsChannelId).append(err.message);
								return undefined;
							})
						)
				);
			})
			.then(revContents => {
				if (!revContents || !this.modelWatcher.model) {
					return TPromise.as(undefined);
				}
				const revLines = revContents
					// Filter out revisions that failed to resolve
					.filter(revContent => revContent)
					.map(revContent => {
						const lines = RawTextSource.fromString(revContent.content).lines;
						return { revision: revContent.revision, lines };
					});
				const revRanges = this.threads.map(thread => {
					return {
						revision: thread.revision,
						range: thread.range,
					};
				});
				const modifiedLines = this.modelWatcher.model.getLinesContent();
				return this.diffWorker.diff({
					revLines,
					revRanges,
					modifiedLines,
				});
			})
			.then(result => {
				if (!result) {
					return;
				}
				for (const thread of this.threads) {
					const transforms = result[thread.revision];
					if (transforms) {
						thread.displayRange = Range.lift(transforms[thread.range.toString()]);
					}
				}
				this.didChangeThreads.fire();
			});
	}
}

/**
 * Returns an array of threads that corresponds to newThreads.
 * If a thread already exists in oldThreads, then that thread is reused
 * and updated so that listener relationships are maintained.
 */
function updatedThreads(accessor: ServicesAccessor, git: Git, oldThreads: ThreadComments[], newThreads: GQL.IThread[]): ThreadComments[] {
	const instantiationService = accessor.get(IInstantiationService);
	const oldThreadsById = oldThreads.reduce((threads, thread) => {
		threads.set(thread.id, thread);
		return threads;
	}, new Map<number, ThreadComments>());

	return newThreads
		.map(thread => {
			const oldThread = oldThreadsById.get(thread.id);
			if (oldThread) {
				// Reuse the existing thread so we save client state like draft replies and event listeners.
				oldThread.comments = thread.comments.map(c => new Comment(c));
				return oldThread;
			}
			return instantiationService.createInstance(ThreadComments, thread, git);
		})
		.sort((left: ThreadComments, right: ThreadComments) => {
			// Most recent comment timestamp descending.
			return right.mostRecentComment.createdAt.getTime() - left.mostRecentComment.createdAt.getTime();
		});
}

/**
 * Watches a URI for changes.
 */
class ModelWatcher extends Disposable {
	private _model: IModel;
	public get model(): IModel {
		return this._model;
	}

	private didChangeContent = this.disposable(new Emitter<IModelContentChangedEvent>());
	public readonly onDidChangeContent = this.didChangeContent.event;

	constructor(
		public readonly uri: URI,
		@IModelService private modelService: IModelService,
	) {
		super();

		this.disposable(any(
			modelService.onModelAdded,
			modelService.onModelRemoved,
		)(this.handleModelChange, this));
		this.handleModelChange();
	}

	private disposeOnModelChange: IDisposable[] = [];

	private handleModelChange(): void {
		const model = this.modelService.getModel(this.uri);
		if (this._model === model) {
			return;
		}
		this._model = model;
		this.disposeOnModelChange = dispose(this.disposeOnModelChange);
		if (!model) {
			return;
		}
		this.disposeOnModelChange.push(model.onDidChangeContent(e => {
			this.didChangeContent.fire(e);
		}));
	}

	public dispose() {
		this.disposeOnModelChange = dispose(this.disposeOnModelChange);
		super.dispose();
	}
}

export class ThreadComments extends Disposable implements IThreadComments {
	public readonly id: number;
	public readonly title: string;
	public readonly file: string;
	public readonly revision: string;
	public readonly range: Range;
	public readonly createdAt: Date;

	private _pendingOperation = false;
	private didChangePendingOperation = this.disposable(new Emitter<void>());
	public readonly onDidChangePendingOperation = this.didChangePendingOperation.event;
	public get pendingOperation() { return this._pendingOperation; }
	public set pendingOperation(pendingOperation: boolean) {
		if (this._pendingOperation !== pendingOperation) {
			this._pendingOperation = pendingOperation;
			this.didChangePendingOperation.fire();
		}
	}

	private _archived = false;
	private didChangeArchived = this.disposable(new Emitter<void>());
	public onDidChangeArchived = this.didChangeArchived.event;
	public get archived(): boolean { return this._archived; }
	public set archived(archived: boolean) {
		if (this._archived !== archived) {
			this._archived = archived;
			this.didChangeArchived.fire();
		}
	}

	private _comments: Comment[];
	private didChangeComments = this.disposable(new Emitter<void>());
	public readonly onDidChangeComments = this.didChangeComments.event;
	public get comments(): Comment[] { return this._comments; }
	public set comments(comments: Comment[]) {
		this._comments = comments;
		this.didChangeComments.fire();
	}

	private _draftReply = '';
	private didChangeDraftReply = this.disposable(new Emitter<void>());
	public readonly onDidChangeDraftReply = this.didChangeDraftReply.event;
	public get draftReply(): string { return this._draftReply; }
	public set draftReply(draftReply: string) {
		if (this._draftReply !== draftReply) {
			this._draftReply = draftReply;
			this.didChangeDraftReply.fire();
		}
	}

	private _displayRange?: Range;
	private didChangeDisplayRange = this.disposable(new Emitter<void>());
	public readonly onDidChangeDisplayRange = this.didChangeDisplayRange.event;
	public get displayRange(): Range | undefined { return this._displayRange; }
	public set displayRange(displayRange: Range | undefined) {
		if (this._displayRange !== displayRange) {
			this._displayRange = displayRange;
			this.didChangeDisplayRange.fire();
		}
	}

	public get mostRecentComment(): Comment {
		return this.comments[this.comments.length - 1];
	}

	constructor(
		thread: GQL.IThread,
		private git: Git,
		@IRemoteService private remoteService: IRemoteService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IAuthService private authService: IAuthService,
	) {
		super();
		const comments = thread.comments.map(comment => new Comment(comment));
		if (!comments.length) {
			throw new Error(`expected thread ${thread.id} to have at least one comment`);
		}
		this.id = thread.id;
		this.title = thread.title;
		this.file = thread.file;
		this.revision = thread.revision;
		this.range = new Range(thread.startLine, thread.startCharacter, thread.endLine, thread.endCharacter);
		this.createdAt = new Date(thread.createdAt);
		this.archived = !!thread.archivedAt;
		this._comments = comments;
	}

	public setArchived(archived: boolean): TPromise<void> {
		return this.operation(() => {
			return requestGraphQLMutation<{ updateThread: GQL.IThread }>(this.remoteService, `mutation ThreadSetArchived {
				updateThread(
					threadID: $threadID,
					archived: $archived,
				) {
					archivedAt
				}
			}`, {
					threadID: this.id,
					archived,
				})
				.then(response => {
					this.archived = !!response.updateThread.archivedAt;
				});
		});
	}

	public submitDraftReply(): TPromise<void> {
		if (!this.draftReply.length) {
			return TPromise.wrapError(new Error(localize('emptyCommentError', "Comment can not be empty.")));
		}
		return this.operation(() => {
			return requestGraphQLMutation<{ addCommentToThread: GQL.IThread }>(this.remoteService, `mutation SubmitDraftReply {
				addCommentToThread(
					threadID: $threadID,
					contents: $contents,
				) {
					${commentsGraphql}
				}
			}`, {
					threadID: this.id,
					contents: this.draftReply,
				})
				.then(response => {
					this.draftReply = '';
					this.comments = response.addCommentToThread.comments.map(c => new Comment(c));
				});
		});
	}

	private operation(operation: () => TPromise<void>): TPromise<void> {
		if (this.pendingOperation) {
			return TPromise.wrapError(new Error('pending operation'));
		}
		this.pendingOperation = true;
		const result = operation();
		const clearPendingOperation = () => { this.pendingOperation = false; };
		result.done(clearPendingOperation, clearPendingOperation);
		return result;
	}

}

export class DraftThreadComments extends Disposable implements IDraftThreadComments {
	private static NEXT_ID = 1;

	public readonly id = DraftThreadComments.NEXT_ID++;

	private _content: string = '';
	private didChangeContent = this.disposable(new Emitter<void>());
	public readonly onDidChangeContent = this.didChangeContent.event;
	public get content(): string { return this._content; }
	public set content(content: string) {
		if (this._content !== content) {
			this._content = content;
			this.didChangeContent.fire();
			let title = content;
			const match = content.match(/[.!?]\s/);
			if (match) {
				title = content.substr(match.index + 1);
			}
			const newline = title.indexOf('\n');
			if (newline !== -1) {
				title = content.substr(0, newline);
			}
			title = title.trim();
			if (title.length > 140) {
				title = title.substr(0, 137) + '...';
			}
			this.title = title.trim();
		}
	}

	private _title: string = '';
	private didChangeTitle = this.disposable(new Emitter<void>());
	public readonly onDidChangeTitle = this.didChangeTitle.event;
	public get title(): string { return this._title; }
	public set title(title: string) {
		if (this._title !== title) {
			this._title = title;
			this.didChangeTitle.fire();
		}
	}

	private _displayRange: Range;
	private didChangeDisplayRange = this.disposable(new Emitter<void>());
	public readonly onDidChangeDisplayRange = this.didChangeDisplayRange.event;
	public get displayRange(): Range { return this._displayRange; }
	public set displayRange(displayRange: Range) {
		if (this._displayRange !== displayRange) {
			this._displayRange = displayRange;
			this.didChangeDisplayRange.fire();
		}
	}

	private didSubmit = this.disposable(new Emitter<ThreadComments>());
	public readonly onDidSubmit = this.didSubmit.event;

	private didChangeSubmitting = this.disposable(new Emitter<void>());
	public readonly onDidChangeSubmitting = this.didChangeSubmitting.event;

	private submitData: TPromise<{
		remoteURI: string,
		file: string,
		revision: string,
		startLine: number,
		endLine: number,
		startCharacter: number,
		endCharacter: number,
		rangeLength: number,
	}>;

	constructor(
		editor: ICommonCodeEditor,
		private git: Git,
		@IMessageService messageService: IMessageService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IRemoteService private remoteService: IRemoteService,
		@IAuthService private authService: IAuthService,
	) {
		super();
		this.displayRange = this.getNonEmptySelection(editor);
		const model = editor.getModel();

		// Save a decoration for the range so if content changes
		// while we are waiting for promises to resolve, we will have an updated range.
		const rangeDecorationId = model.changeDecorations(change => {
			return change.addDecoration(this.displayRange, {});
		});
		this.disposable(model.onDidChangeContent(() => {
			this.displayRange = model.getDecorationRange(rangeDecorationId);
		}));

		const remoteURI = git.getRemoteRepo();
		const file = instantiationService.invokeFunction(getPathRelativeToRepo, model.uri);
		const revision = git.getLastPushedRevision();
		const codeSnippet = TPromise.join<any>([
			remoteURI,
			file,
			revision,
		])
			.then(([repo, file, revision]) => instantiationService.invokeFunction(resolveContent, git, { repo, file }, revision))
			.then(content => {
				if (model.isDisposed()) {
					throw new Error(localize('modelDisposedError', "Unable to create comment on editor that no longer exists."));
				}
				const originalModel = TextModel.createFromString(content.content);
				const originalLines = originalModel.getLinesContent();
				const modifiedLines = model.getLinesContent();
				// Compute reverse diff.
				const diff = new Diff(modifiedLines, originalLines);
				const range = diff.transformRange(this.displayRange);
				if (!range) {
					return undefined;
				}
				const rangeLength = originalModel.getValueLengthInRange(range);
				// TODO(nick): this is where we would compute and pass through the actual text (plus some context) being commented on.
				return { range, rangeLength };
			});

		this.submitData = this.join([remoteURI, file, revision, codeSnippet])
			.then(([remoteURI, file, revision, codeSnippet]) => {
				if (!codeSnippet) {
					throw new Error(localize('emptyCommentRange', "Can not comment on code that has not been pushed."));
				}
				return {
					remoteURI,
					file,
					revision,
					startLine: codeSnippet.range.startLineNumber,
					endLine: codeSnippet.range.endLineNumber,
					startCharacter: codeSnippet.range.startColumn,
					endCharacter: codeSnippet.range.endColumn,
					rangeLength: codeSnippet.rangeLength,
				};
			})
			.then(undefined, err => {
				const errors = coalesce(Array.isArray(err) ? err : [err]);
				const error = errors[0];
				messageService.show(Severity.Error, error.message);
				this.dispose();
				throw error;
			});
	}

	private join<T1, T2, T3, T4>(promises: [PromiseLike<T1>, PromiseLike<T2>, PromiseLike<T3>, PromiseLike<T4>]): TPromise<[T1, T2, T3, T4]> {
		return TPromise.join<any>(promises) as TPromise<[T1, T2, T3, T4]>;
	}

	private submittingPromise: TPromise<IThreadComments> | undefined;

	public get submitting(): boolean {
		return !!this.submittingPromise;
	}

	public submit(): TPromise<IThreadComments> {
		if (this.submittingPromise) {
			return this.submittingPromise;
		}
		const contents = this.content;
		if (!contents.length) {
			return TPromise.wrapError(new Error(localize('emptyCommentError', "Comment can not be empty.")));
		}
		const clearSubmittingPromise = () => {
			this.submittingPromise = undefined;
			this.didChangeSubmitting.fire();
		};
		const promise = this.submitData
			.then(data => {
				return requestGraphQLMutation<{ createThread: GQL.IThread }>(this.remoteService, `mutation CreateThread {
					createThread(
						orgID: $orgId,
						remoteURI: $remoteURI,
						file: $file,
						revision: $revision,
						startLine: $startLine,
						endLine: $endLine,
						startCharacter: $startCharacter,
						endCharacter: $endCharacter,
						rangeLength: $rangeLength,
						contents: $contents,
					) {
						${threadGraphql}
					}
				}`, {
						...data,
						orgId: this.authService.currentUser.currentOrgMember.org.id,
						contents,
					});
			})
			.then(response => {
				const thread = this.instantiationService.createInstance(ThreadComments, response.createThread, this.git);
				this.didSubmit.fire(thread);
				return thread;
			});
		this.submittingPromise = promise;
		this.didChangeSubmitting.fire();
		promise.done(clearSubmittingPromise, clearSubmittingPromise);
		return promise;
	};

	/**
	 * Returns the range that the new comment should be attached to.
	 * It guarantees the returned range is not empty.
	 */
	private getNonEmptySelection(editor: ICommonCodeEditor): Range {
		let selection: Range = editor.getSelection();
		if (selection.isEmpty()) {
			// The user has not selected any text (just a cursor on a line).
			// Select the entire line.
			const line = selection.startLineNumber;
			selection = new Range(line, 1, line + 1, 1);
		}

		if (selection.endColumn === 1) {
			// A range that selects an entire line (either from the logic above, or
			// because the user tripple clicked in a location) will have an end position
			// at the first column of the next line (e.g. [4, 1] => [5, 1]).
			// Convert the range to be a single line (e.g. [4, 1] => [4, 10])
			// because that is more natural and we don't care about including the newline
			// character in the comment range.
			const line = selection.endLineNumber - 1;
			const endColumn = editor.getModel().getLineMaxColumn(line);
			const trimmedSelection = selection.setEndPosition(selection.endLineNumber - 1, endColumn);
			// Only use the trimmedSelection if it isn't empty.
			// If the trimmed selection is empty it means that the user
			// commented on a newline character, which is fine, so we keep
			// their original range.
			if (!trimmedSelection.isEmpty()) {
				selection = trimmedSelection;
			}
		}
		return selection;
	}
}

export class Comment implements IComment {
	public readonly id: number;
	public readonly contents: string;
	public readonly createdAt: Date;
	public readonly updatedAt: Date;
	public readonly author: ICommentAuthor;

	constructor(comment: GQL.IComment) {
		this.id = comment.id;
		this.contents = comment.contents;
		this.createdAt = new Date(comment.createdAt);
		this.updatedAt = new Date(comment.updatedAt);
		this.author = {
			email: comment.author.email,
			displayName: comment.author.displayName,
		};
	}
}

// TODO(nick): this doesn't need to return a promise
function getPathRelativeToRepo(accessor: ServicesAccessor, file: URI): TPromise<string> {
	const repository = accessor.get(ISCMService).getRepositoryForResource(file);
	if (!repository) {
		return TPromise.wrapError(new Error(`no repository in context ${file.toString()}`));
	}
	if (!repository.provider.rootUri) {
		return TPromise.wrapError(new Error(`provider for context ${file.toString()} has no root folder`));
	}
	const root = endsWithSlash(repository.provider.rootUri.path);
	if (!startsWith(file.path, root)) {
		return TPromise.wrapError(new Error(`file ${file.path} not in root ${root}`));
	}
	return TPromise.wrap(file.path.substr(root.length));
}

function endsWithSlash(s: string): string {
	if (s.charAt(s.length - 1) === '/') {
		return s;
	}
	return s + '/';
}

function resolveContent(accessor: ServicesAccessor, git: Git, documentId: DocumentId, revision: string): TPromise<{ revision: string, content: string }> {
	// TODO(nick): better way to resolve content that leverages local workspaces.
	return git.getContentsAtRevision(documentId.file, revision).then(content => ({ revision, content }));
}
