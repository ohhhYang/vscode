/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Uri, Command, EventEmitter, Event, scm, SourceControl, SourceControlInputBox, SourceControlResourceGroup, SourceControlResourceState, SourceControlResourceDecorations, Disposable, ProgressLocation, window, workspace, WorkspaceEdit, ThemeColor, CommandOptions, DecorationData } from 'vscode';
import { Repository as BaseRepository, Ref, Branch, Remote, Commit, GitErrorCodes, Stash, RefType, GitError, Worktree, IFileDiff } from './git';
import { anyEvent, filterEvent, eventToPromise, dispose, find } from './util';
import { memoize, throttle, debounce } from './decorators';
import { toGitUri } from './uri';
import { AutoFetcher } from './autofetch';
import * as path from 'path';
import * as nls from 'vscode-nls';
import * as fs from 'fs';
import { StatusBarCommands } from './statusbar';

const timeout = (millis: number) => new Promise(c => setTimeout(c, millis));

const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(path.dirname(__dirname), 'resources', 'icons');

function getIconUri(iconName: string, theme: string): Uri {
	return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export enum RepositoryState {
	Idle,
	Disposed
}

export enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	ADDED,
	COPIED,
	MODIFIED,
	RENAMED,
	DELETED,
	UNTRACKED,
	IGNORED,

	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED
}

export enum ResourceGroupType {
	Committed,
	Merge,
	Index,
	WorkingTree
}

export class Resource implements SourceControlResourceState {

	@memoize
	get resourceUri(): Uri {
		if (this.renameResourceUri && (this._type === Status.MODIFIED || this._type === Status.DELETED || this._type === Status.RENAMED || this._type === Status.INDEX_RENAMED || this._type === Status.COPIED || this._type === Status.INDEX_COPIED)) {
			return this.renameResourceUri;
		}

		return this._resourceUri;
	}

	@memoize
	get command(): Command {
		return {
			command: 'git.openResource',
			title: localize('open', "Open"),
			arguments: [this]
		};
	}

	get resourceGroupType(): ResourceGroupType { return this._resourceGroupType; }
	get type(): Status { return this._type; }
	get original(): Uri { return this._resourceUri; }
	get renameResourceUri(): Uri | undefined { return this._renameResourceUri; }

	private static Icons = {
		light: {
			Modified: getIconUri('status-modified', 'light'),
			Added: getIconUri('status-added', 'light'),
			Deleted: getIconUri('status-deleted', 'light'),
			Renamed: getIconUri('status-renamed', 'light'),
			Copied: getIconUri('status-copied', 'light'),
			Untracked: getIconUri('status-untracked', 'light'),
			Ignored: getIconUri('status-ignored', 'light'),
			Conflict: getIconUri('status-conflict', 'light'),
		},
		dark: {
			Modified: getIconUri('status-modified', 'dark'),
			Added: getIconUri('status-added', 'dark'),
			Deleted: getIconUri('status-deleted', 'dark'),
			Renamed: getIconUri('status-renamed', 'dark'),
			Copied: getIconUri('status-copied', 'dark'),
			Untracked: getIconUri('status-untracked', 'dark'),
			Ignored: getIconUri('status-ignored', 'dark'),
			Conflict: getIconUri('status-conflict', 'dark')
		}
	};

	private getIconPath(theme: string): Uri | undefined {
		switch (this.type) {
			case Status.INDEX_MODIFIED: return Resource.Icons[theme].Modified;
			case Status.MODIFIED: return Resource.Icons[theme].Modified;
			case Status.ADDED: return Resource.Icons[theme].Added;
			case Status.INDEX_ADDED: return Resource.Icons[theme].Added;
			case Status.INDEX_DELETED: return Resource.Icons[theme].Deleted;
			case Status.DELETED: return Resource.Icons[theme].Deleted;
			case Status.RENAMED: return Resource.Icons[theme].Renamed;
			case Status.INDEX_RENAMED: return Resource.Icons[theme].Renamed;
			case Status.COPIED: return Resource.Icons[theme].Copied;
			case Status.INDEX_COPIED: return Resource.Icons[theme].Copied;
			case Status.UNTRACKED: return Resource.Icons[theme].Untracked;
			case Status.IGNORED: return Resource.Icons[theme].Ignored;
			case Status.BOTH_DELETED: return Resource.Icons[theme].Conflict;
			case Status.ADDED_BY_US: return Resource.Icons[theme].Conflict;
			case Status.DELETED_BY_THEM: return Resource.Icons[theme].Conflict;
			case Status.ADDED_BY_THEM: return Resource.Icons[theme].Conflict;
			case Status.DELETED_BY_US: return Resource.Icons[theme].Conflict;
			case Status.BOTH_ADDED: return Resource.Icons[theme].Conflict;
			case Status.BOTH_MODIFIED: return Resource.Icons[theme].Conflict;
			default: return void 0;
		}
	}

	private get tooltip(): string {
		switch (this.type) {
			case Status.INDEX_MODIFIED: return localize('index modified', "Index Modified");
			case Status.MODIFIED: return localize('modified', "Modified");
			case Status.ADDED: return localize('added', "Added");
			case Status.INDEX_ADDED: return localize('index added', "Index Added");
			case Status.INDEX_DELETED: return localize('index deleted', "Index Deleted");
			case Status.DELETED: return localize('deleted', "Deleted");
			case Status.RENAMED: return localize('renamed', "Renamed");
			case Status.INDEX_RENAMED: return localize('index renamed', "Index Renamed");
			case Status.COPIED: return localize('copied', "Copied");
			case Status.INDEX_COPIED: return localize('index copied', "Index Copied");
			case Status.UNTRACKED: return localize('untracked', "Untracked");
			case Status.IGNORED: return localize('ignored', "Ignored");
			case Status.BOTH_DELETED: return localize('both deleted', "Both Deleted");
			case Status.ADDED_BY_US: return localize('added by us', "Added By Us");
			case Status.DELETED_BY_THEM: return localize('deleted by them', "Deleted By Them");
			case Status.ADDED_BY_THEM: return localize('added by them', "Added By Them");
			case Status.DELETED_BY_US: return localize('deleted by us', "Deleted By Us");
			case Status.BOTH_ADDED: return localize('both added', "Both Added");
			case Status.BOTH_MODIFIED: return localize('both modified', "Both Modified");
			default: return '';
		}
	}

	private get strikeThrough(): boolean {
		switch (this.type) {
			case Status.DELETED:
			case Status.BOTH_DELETED:
			case Status.DELETED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.INDEX_DELETED:
				return true;
			default:
				return false;
		}
	}

	@memoize
	private get faded(): boolean {
		// TODO@joao
		return false;
		// const workspaceRootPath = this.workspaceRoot.fsPath;
		// return this.resourceUri.fsPath.substr(0, workspaceRootPath.length) !== workspaceRootPath;
	}

	get decorations(): SourceControlResourceDecorations {
		// TODO@joh
		const light = { iconPath: this.getIconPath('light') } && undefined;
		const dark = { iconPath: this.getIconPath('dark') } && undefined;
		const tooltip = this.tooltip;
		const strikeThrough = this.strikeThrough;
		const faded = this.faded;

		return { strikeThrough, faded, tooltip, light, dark };
	}

	get letter(): string | undefined {
		switch (this.type) {
			case Status.INDEX_MODIFIED:
			case Status.MODIFIED:
				return 'M';
			case Status.INDEX_ADDED:
				return 'A';
			case Status.INDEX_DELETED:
			case Status.DELETED:
				return 'D';
			case Status.INDEX_RENAMED:
				return 'R';
			case Status.UNTRACKED:
				return 'U';
			case Status.IGNORED:
				return 'I';
			case Status.INDEX_COPIED:
			case Status.BOTH_DELETED:
			case Status.ADDED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.ADDED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return 'C';
			default:
				return undefined;
		}
	}

	get color(): ThemeColor | undefined {
		switch (this.type) {
			case Status.INDEX_MODIFIED:
			case Status.MODIFIED:
				return new ThemeColor('git.color.modified');
			case Status.INDEX_DELETED:
			case Status.DELETED:
				return new ThemeColor('git.color.deleted');
			case Status.INDEX_ADDED: // todo@joh - special color?
			case Status.INDEX_RENAMED: // todo@joh - special color?
			case Status.UNTRACKED:
				return new ThemeColor('git.color.untracked');
			case Status.IGNORED:
				return new ThemeColor('git.color.ignored');
			case Status.INDEX_COPIED:
			case Status.BOTH_DELETED:
			case Status.ADDED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.ADDED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return new ThemeColor('git.color.conflict');
			default:
				return undefined;
		}
	}

	get resourceDecoration(): DecorationData | undefined {
		const title = this.tooltip;
		const abbreviation = this.letter;
		const color = this.color;
		return { bubble: true, title, abbreviation, color };
	}

	constructor(
		protected _resourceGroupType: ResourceGroupType,
		protected _resourceUri: Uri,
		protected _type: Status,
		protected _renameResourceUri?: Uri
	) { }
}

export enum Operation {
	Status = 1 << 0,
	Add = 1 << 1,
	RevertFiles = 1 << 2,
	Commit = 1 << 3,
	Clean = 1 << 4,
	Branch = 1 << 5,
	Checkout = 1 << 6,
	Reset = 1 << 7,
	Fetch = 1 << 8,
	Pull = 1 << 9,
	Push = 1 << 10,
	Sync = 1 << 11,
	Show = 1 << 12,
	Stage = 1 << 13,
	GetCommitTemplate = 1 << 14,
	DeleteBranch = 1 << 15,
	Merge = 1 << 16,
	Ignore = 1 << 17,
	Tag = 1 << 18,
	Stash = 1 << 19,
	CheckIgnore = 1 << 20,
	AddWorktree = 1 << 21,
	WorktreePrune = 1 << 23,
	Diff = 1 << 24,
	MergeBase = 1 << 25,
	RevParse = 1 << 26,
	WorktreeList = 1 << 27,
	ExecuteCommand = 1 << 28,
}

// function getOperationName(operation: Operation): string {
//	switch (operation) {
//		case Operation.Status: return 'Status';
//		case Operation.Add: return 'Add';
//		case Operation.RevertFiles: return 'RevertFiles';
//		case Operation.Commit: return 'Commit';
//		case Operation.Clean: return 'Clean';
//		case Operation.Branch: return 'Branch';
//		case Operation.Checkout: return 'Checkout';
//		case Operation.Reset: return 'Reset';
//		case Operation.Fetch: return 'Fetch';
//		case Operation.Pull: return 'Pull';
//		case Operation.Push: return 'Push';
//		case Operation.Sync: return 'Sync';
//		case Operation.Init: return 'Init';
//		case Operation.Show: return 'Show';
//		case Operation.Stage: return 'Stage';
//		case Operation.GetCommitTemplate: return 'GetCommitTemplate';
//		default: return 'unknown';
//	}
// }

function isReadOnly(operation: Operation): boolean {
	switch (operation) {
		case Operation.Show:
		case Operation.GetCommitTemplate:
		case Operation.Diff:
		case Operation.MergeBase:
		case Operation.RevParse:
		case Operation.CheckIgnore:
			return true;
		default:
			return false;
	}
}

function shouldShowProgress(operation: Operation): boolean {
	switch (operation) {
		case Operation.Fetch:
			return false;
		default:
			return true;
	}
}

export interface Operations {
	isIdle(): boolean;
	isRunning(operation: Operation): boolean;
}

class OperationsImpl implements Operations {

	constructor(private readonly operations: number = 0) {
		// noop
	}

	start(operation: Operation): OperationsImpl {
		return new OperationsImpl(this.operations | operation);
	}

	end(operation: Operation): OperationsImpl {
		return new OperationsImpl(this.operations & ~operation);
	}

	isRunning(operation: Operation): boolean {
		return (this.operations & operation) !== 0;
	}

	isIdle(): boolean {
		return this.operations === 0;
	}
}

export interface CommitOptions {
	all?: boolean;
	amend?: boolean;
	signoff?: boolean;
	signCommit?: boolean;
}

export interface GitResourceGroup extends SourceControlResourceGroup {
	resourceStates: Resource[];
}

// This import is down here to avoid a circular dependency.
// A proper restructuring of this code would involve moving
// Resource and its dependencies to its own file but that
// would be a nightmare to maintain when merging from upstream.
import { ReviewManager } from './reviewManager';
import { Comparison } from './comparison';

export class Repository implements Disposable {

	private _onDidChangeRepository = new EventEmitter<Uri>();
	readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository.event;

	private _onDidChangeState = new EventEmitter<RepositoryState>();
	readonly onDidChangeState: Event<RepositoryState> = this._onDidChangeState.event;

	private _onDidChangeStatus = new EventEmitter<void>();
	readonly onDidChangeStatus: Event<void> = this._onDidChangeStatus.event;

	private _onDidChangeOriginalResource = new EventEmitter<Uri>();
	readonly onDidChangeOriginalResource: Event<Uri> = this._onDidChangeOriginalResource.event;

	private _onRunOperation = new EventEmitter<Operation>();
	readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

	private _onDidRunOperation = new EventEmitter<Operation>();
	readonly onDidRunOperation: Event<Operation> = this._onDidRunOperation.event;

	@memoize
	get onDidChangeOperations(): Event<void> {
		return anyEvent(this.onRunOperation as Event<any>, this.onDidRunOperation as Event<any>);
	}

	private _sourceControl: SourceControl;
	get sourceControl(): SourceControl { return this._sourceControl; }

	public readonly comparison: Comparison;

	get inputBox(): SourceControlInputBox { return this._sourceControl.inputBox; }

	private _mergeGroup: SourceControlResourceGroup;
	get mergeGroup(): GitResourceGroup { return this._mergeGroup as GitResourceGroup; }

	private _indexGroup: SourceControlResourceGroup;
	get indexGroup(): GitResourceGroup { return this._indexGroup as GitResourceGroup; }

	private _workingTreeGroup: SourceControlResourceGroup;
	get workingTreeGroup(): GitResourceGroup { return this._workingTreeGroup as GitResourceGroup; }

	private _HEAD: Branch | undefined;
	get HEAD(): Branch | undefined {
		return this._HEAD;
	}

	private _refs: Ref[] = [];
	get refs(): Ref[] {
		return this._refs;
	}

	private _remotes: Remote[] = [];
	get remotes(): Remote[] {
		return this._remotes;
	}

	private _operations = new OperationsImpl();
	get operations(): Operations { return this._operations; }

	private _state = RepositoryState.Idle;
	get state(): RepositoryState { return this._state; }
	set state(state: RepositoryState) {
		this._state = state;
		this._onDidChangeState.fire(state);

		this._HEAD = undefined;
		this._refs = [];
		this._remotes = [];
		this.mergeGroup.resourceStates = [];
		this.indexGroup.resourceStates = [];
		this.workingTreeGroup.resourceStates = [];
		this._sourceControl.count = 0;
		this._sourceControl.revision = { rawSpecifier: 'HEAD' };
	}

	get root(): string {
		return this.repository.root;
	}

	private isRepositoryHuge = false;
	private didWarnAboutLimit = false;
	private disposables: Disposable[] = [];

	constructor(
		private readonly repository: BaseRepository
	) {
		const fsWatcher = workspace.createFileSystemWatcher('**');
		this.disposables.push(fsWatcher);

		const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
		const onRepositoryChange = filterEvent(onWorkspaceChange, uri => !/^\.\./.test(path.relative(repository.root, uri.fsPath)));
		const onRelevantRepositoryChange = filterEvent(onRepositoryChange, uri => !/\/\.git\/index\.lock$/.test(uri.path));
		onRelevantRepositoryChange(this.onFSChange, this, this.disposables);

		const onRelevantGitChange = filterEvent(onRelevantRepositoryChange, uri => /\/\.git\//.test(uri.path));
		onRelevantGitChange(this._onDidChangeRepository.fire, this._onDidChangeRepository, this.disposables);

		this._sourceControl = scm.createSourceControl('git', 'Git', Uri.file(repository.root));
		this._sourceControl.acceptInputCommand = { command: 'git.commitWithInput', title: localize('commit', "Commit"), arguments: [this._sourceControl] };
		this._sourceControl.quickDiffProvider = this;
		this._sourceControl.commandExecutor = this;
		this.disposables.push(this._sourceControl);

		this._sourceControl.setRevisionCommand = {
			command: 'git.checkout',
			title: localize('checkout', "Git Checkout"),
			arguments: [this._sourceControl],
		};

		this._mergeGroup = this._sourceControl.createResourceGroup('merge', localize('merge changes', "Merge Changes"));
		this._indexGroup = this._sourceControl.createResourceGroup('index', localize('staged changes', "Staged Changes"));
		this._workingTreeGroup = this._sourceControl.createResourceGroup('workingTree', localize('changes', "Changes"));

		this.mergeGroup.hideWhenEmpty = true;
		this.indexGroup.hideWhenEmpty = true;

		this.disposables.push(this.mergeGroup);
		this.disposables.push(this.indexGroup);
		this.disposables.push(this.workingTreeGroup);

		this.disposables.push(new AutoFetcher(this));

		const statusBar = new StatusBarCommands(this);
		this.disposables.push(statusBar);
		statusBar.onDidChange(() => this._sourceControl.statusBarCommands = statusBar.commands, null, this.disposables);
		this._sourceControl.statusBarCommands = statusBar.commands;

		this.updateCommitTemplate();
		this.status();

		this.comparison = new Comparison(this);
		this.disposables.push(this.comparison);

		this.disposables.push(new ReviewManager(this));
	}

	provideOriginalResource(uri: Uri): Uri | undefined {
		if (uri.scheme !== 'file') {
			return;
		}

		return toGitUri(uri, '', true);
	}

	private async updateCommitTemplate(): Promise<void> {
		try {
			this._sourceControl.commitTemplate = await this.repository.getCommitTemplate();
		} catch (e) {
			// noop
		}
	}

	// @throttle
	// async init(): Promise<void> {
	//	if (this.state !== State.NotAGitRepository) {
	//		return;
	//	}

	//	await this.git.init(this.workspaceRoot.fsPath);
	//	await this.status();
	// }

	async executeCommand(args: string[], options?: CommandOptions): Promise<string> {
		return await this.run(Operation.ExecuteCommand, () => {
			let runOptions: any;
			if (options) {
				if (typeof options.stdin === 'string') {
					runOptions = { input: options.stdin };
				}
			}

			return this.repository.run(args, runOptions)
				.then(result => {
					return result.stdout;
				}, error => {
					throw Object.assign(new Error(error.stderr), { args, error });
				});
		});
	}

	@throttle
	async status(): Promise<void> {
		await this.run(Operation.Status);
	}

	async add(resources: Uri[]): Promise<void> {
		await this.run(Operation.Add, () => this.repository.add(resources.map(r => r.fsPath)));
	}

	async stage(resource: Uri, contents: string): Promise<void> {
		const relativePath = path.relative(this.repository.root, resource.fsPath).replace(/\\/g, '/');
		await this.run(Operation.Stage, () => this.repository.stage(relativePath, contents));
		this._onDidChangeOriginalResource.fire(resource);
	}

	async revert(resources: Uri[]): Promise<void> {
		await this.run(Operation.RevertFiles, () => this.repository.revert('HEAD', resources.map(r => r.fsPath)));
	}

	async commit(message: string, opts: CommitOptions = Object.create(null)): Promise<void> {
		await this.run(Operation.Commit, async () => {
			if (opts.all) {
				await this.repository.add([]);
			}

			await this.repository.commit(message, opts);
		});
	}

	async clean(resources: Uri[]): Promise<void> {
		await this.run(Operation.Clean, async () => {
			const toClean: string[] = [];
			const toCheckout: string[] = [];

			resources.forEach(r => {
				const raw = r.toString();
				const scmResource = find(this.workingTreeGroup.resourceStates, sr => sr.resourceUri.toString() === raw);

				if (!scmResource) {
					return;
				}

				switch (scmResource.type) {
					case Status.UNTRACKED:
					case Status.IGNORED:
						toClean.push(r.fsPath);
						break;

					default:
						toCheckout.push(r.fsPath);
						break;
				}
			});

			const promises: Promise<void>[] = [];

			if (toClean.length > 0) {
				promises.push(this.repository.clean(toClean));
			}

			if (toCheckout.length > 0) {
				promises.push(this.repository.checkout('', toCheckout));
			}

			await Promise.all(promises);
		});
	}

	async branch(name: string): Promise<void> {
		await this.run(Operation.Branch, () => this.repository.branch(name, true));
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		await this.run(Operation.DeleteBranch, () => this.repository.deleteBranch(name, force));
	}

	async merge(ref: string): Promise<void> {
		await this.run(Operation.Merge, () => this.repository.merge(ref));
	}

	async tag(name: string, message?: string): Promise<void> {
		await this.run(Operation.Tag, () => this.repository.tag(name, message));
	}

	async checkout(treeish: string): Promise<void> {
		await this.run(Operation.Checkout, () => this.repository.checkout(treeish, []));
	}

	async addWorktree(worktreeDir: string, ref: string): Promise<void> {
		await this.run(Operation.AddWorktree, () => this.repository.addWorktree(worktreeDir, ref));
	}

	async worktreePrune(): Promise<void> {
		await this.run(Operation.WorktreePrune, () => this.repository.worktreePrune());
	}

	async worktreeList(): Promise<Worktree[]> {
		return await this.run(Operation.WorktreeList, () => this.repository.worktreeList());
	}

	async getDiff(args: string[]): Promise<{ diff: IFileDiff[], didHitLimit: boolean }> {
		return await this.run(Operation.Diff, () => this.repository.getDiff(args));
	}

	async getMergeBase(args: string[]): Promise<string[]> {
		return await this.run(Operation.MergeBase, () => this.repository.getMergeBase(args));
	}

	async revParse(args: string[]): Promise<string[]> {
		return await this.run(Operation.RevParse, () => this.repository.revParse(args));
	}

	async getCommit(ref: string): Promise<Commit> {
		return await this.repository.getCommit(ref);
	}

	async getHEAD(): Promise<Ref> {
		return await this.repository.getHEAD();
	}

	async getBranch(branch: string): Promise<Branch> {
		return await this.repository.getBranch(branch);
	}

	async reset(treeish: string, hard?: boolean): Promise<void> {
		await this.run(Operation.Reset, () => this.repository.reset(treeish, hard));
	}

	@throttle
	async fetch(op?: { all?: boolean }): Promise<void> {
		try {
			await this.run(Operation.Fetch, () => this.repository.fetch(op));
		} catch (err) {
			// noop
		}
	}

	@throttle
	async pullWithRebase(): Promise<void> {
		await this.run(Operation.Pull, () => this.repository.pull(true));
	}

	@throttle
	async pull(rebase?: boolean, remote?: string, name?: string): Promise<void> {
		await this.run(Operation.Pull, () => this.repository.pull(rebase, remote, name));
	}

	@throttle
	async push(): Promise<void> {
		await this.run(Operation.Push, () => this.repository.push());
	}

	async pullFrom(rebase?: boolean, remote?: string, branch?: string): Promise<void> {
		await this.run(Operation.Pull, () => this.repository.pull(rebase, remote, branch));
	}

	async pushTo(remote?: string, name?: string, setUpstream: boolean = false): Promise<void> {
		await this.run(Operation.Push, () => this.repository.push(remote, name, setUpstream));
	}

	async pushTags(remote?: string): Promise<void> {
		await this.run(Operation.Push, () => this.repository.push(remote, undefined, false, true));
	}

	@throttle
	async sync(): Promise<void> {
		await this.run(Operation.Sync, async () => {
			await this.repository.pull();

			const shouldPush = this.HEAD && typeof this.HEAD.ahead === 'number' ? this.HEAD.ahead > 0 : true;

			if (shouldPush) {
				await this.repository.push();
			}
		});
	}

	async show(ref: string, filePath: string): Promise<string> {
		return await this.run(Operation.Show, async () => {
			const relativePath = path.relative(this.repository.root, filePath).replace(/\\/g, '/');
			const configFiles = workspace.getConfiguration('files');
			const encoding = configFiles.get<string>('encoding');

			return await this.repository.buffer(`${ref}:${relativePath}`, encoding);
		});
	}

	async getStashes(): Promise<Stash[]> {
		return await this.repository.getStashes();
	}

	async createStash(message?: string): Promise<void> {
		return await this.run(Operation.Stash, () => this.repository.createStash(message));
	}

	async popStash(index?: number): Promise<void> {
		return await this.run(Operation.Stash, () => this.repository.popStash(index));
	}

	async getCommitTemplate(): Promise<string> {
		return await this.run(Operation.GetCommitTemplate, async () => this.repository.getCommitTemplate());
	}

	async ignore(files: Uri[]): Promise<void> {
		return await this.run(Operation.Ignore, async () => {
			const ignoreFile = `${this.repository.root}${path.sep}.gitignore`;
			const textToAppend = files
				.map(uri => path.relative(this.repository.root, uri.fsPath).replace(/\\/g, '/'))
				.join('\n');

			const document = await new Promise(c => fs.exists(ignoreFile, c))
				? await workspace.openTextDocument(ignoreFile)
				: await workspace.openTextDocument(Uri.file(ignoreFile).with({ scheme: 'untitled' }));

			await window.showTextDocument(document);

			const edit = new WorkspaceEdit();
			const lastLine = document.lineAt(document.lineCount - 1);
			const text = lastLine.isEmptyOrWhitespace ? `${textToAppend}\n` : `\n${textToAppend}\n`;

			edit.insert(document.uri, lastLine.range.end, text);
			workspace.applyEdit(edit);
		});
	}

	checkIgnore(filePaths: string[]): Promise<Set<string>> {
		return this.run(Operation.CheckIgnore, () => {
			return new Promise<Set<string>>((resolve, reject) => {

				filePaths = filePaths.filter(filePath => !path.relative(this.root, filePath).startsWith('..'));

				if (filePaths.length === 0) {
					// nothing left
					return Promise.resolve(new Set<string>());
				}

				const child = this.repository.stream(['check-ignore', ...filePaths]);

				const onExit = exitCode => {
					if (exitCode === 1) {
						// nothing ignored
						resolve(new Set<string>());
					} else if (exitCode === 0) {
						// each line is something ignored
						resolve(new Set<string>(data.split('\n')));
					} else {
						reject(new GitError({ stdout: data, stderr, exitCode }));
					}
				};

				let data = '';
				const onStdoutData = (raw: string) => {
					data += raw;
				};

				child.stdout.setEncoding('utf8');
				child.stdout.on('data', onStdoutData);

				let stderr: string = '';
				child.stderr.setEncoding('utf8');
				child.stderr.on('data', raw => stderr += raw);

				child.on('error', reject);
				child.on('exit', onExit);
			});
		});
	}

	private async run<T>(operation: Operation, runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		if (this.state !== RepositoryState.Idle) {
			throw new Error('Repository not initialized');
		}

		const run = async () => {
			this._operations = this._operations.start(operation);
			this._onRunOperation.fire(operation);

			try {
				const result = await this.retryRun(runOperation);

				if (!isReadOnly(operation)) {
					await this.updateModelState();
				}

				return result;
			} catch (err) {
				if (err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
					this.state = RepositoryState.Disposed;
				}

				throw err;
			} finally {
				this._operations = this._operations.end(operation);
				this._onDidRunOperation.fire(operation);
			}
		};

		return shouldShowProgress(operation)
			? window.withProgress({ location: ProgressLocation.SourceControl }, run)
			: run();
	}

	private async retryRun<T>(runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		let attempt = 0;

		while (true) {
			try {
				attempt++;
				return await runOperation();
			} catch (err) {
				if (err.gitErrorCode === GitErrorCodes.RepositoryIsLocked && attempt <= 10) {
					// quatratic backoff
					await timeout(Math.pow(attempt, 2) * 50);
				} else {
					throw err;
				}
			}
		}
	}

	@throttle
	private async updateModelState(): Promise<void> {
		const { status, didHitLimit } = await this.repository.getStatus();
		const config = workspace.getConfiguration('git');
		const shouldIgnore = config.get<boolean>('ignoreLimitWarning') === true;

		this.isRepositoryHuge = didHitLimit;

		if (didHitLimit && !shouldIgnore && !this.didWarnAboutLimit) {
			const ok = { title: localize('ok', "OK"), isCloseAffordance: true };
			const neverAgain = { title: localize('neveragain', "Never Show Again") };

			window.showWarningMessage(localize('huge', "The git repository at '{0}' has too many active changes, only a subset of Git features will be enabled.", this.repository.root), ok, neverAgain).then(result => {
				if (result === neverAgain) {
					config.update('ignoreLimitWarning', true, false);
				}
			});

			this.didWarnAboutLimit = true;
		}

		let HEAD: Branch | undefined;

		try {
			HEAD = await this.repository.getHEAD();

			if (HEAD.name) {
				try {
					HEAD = await this.repository.getBranch(HEAD.name);
				} catch (err) {
					// noop
				}
			}
		} catch (err) {
			// noop
		}

		const [refs, remotes] = await Promise.all([this.repository.getRefs(), this.repository.getRemotes()]);

		this._HEAD = HEAD;
		this._refs = refs;
		this._remotes = remotes;

		const index: Resource[] = [];
		const workingTree: Resource[] = [];
		const merge: Resource[] = [];

		status.forEach(raw => {
			const uri = Uri.file(path.join(this.repository.root, raw.path));
			const renameUri = raw.rename ? Uri.file(path.join(this.repository.root, raw.rename)) : undefined;

			switch (raw.x + raw.y) {
				case '??': return workingTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.UNTRACKED));
				case '!!': return workingTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.IGNORED));
				case 'DD': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.BOTH_DELETED));
				case 'AU': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.ADDED_BY_US));
				case 'UD': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.DELETED_BY_THEM));
				case 'UA': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.ADDED_BY_THEM));
				case 'DU': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.DELETED_BY_US));
				case 'AA': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.BOTH_ADDED));
				case 'UU': return merge.push(new Resource(ResourceGroupType.Merge, uri, Status.BOTH_MODIFIED));
			}

			let isModifiedInIndex = false;

			switch (raw.x) {
				case 'M': index.push(new Resource(ResourceGroupType.Index, uri, Status.INDEX_MODIFIED)); isModifiedInIndex = true; break;
				case 'A': index.push(new Resource(ResourceGroupType.Index, uri, Status.INDEX_ADDED)); break;
				case 'D': index.push(new Resource(ResourceGroupType.Index, uri, Status.INDEX_DELETED)); break;
				case 'R': index.push(new Resource(ResourceGroupType.Index, uri, Status.INDEX_RENAMED, renameUri)); break;
				case 'C': index.push(new Resource(ResourceGroupType.Index, uri, Status.INDEX_COPIED, renameUri)); break;
			}

			switch (raw.y) {
				case 'M': workingTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.MODIFIED, renameUri)); break;
				case 'D': workingTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.DELETED, renameUri)); break;
			}
		});

		// set resource groups
		this.mergeGroup.resourceStates = merge;
		this.indexGroup.resourceStates = index;
		this.workingTreeGroup.resourceStates = workingTree;

		// set count badge
		const countBadge = workspace.getConfiguration('git').get<string>('countBadge');
		let count = merge.length + index.length + workingTree.length;

		switch (countBadge) {
			case 'off': count = 0; break;
			case 'tracked': count = count - workingTree.filter(r => r.type === Status.UNTRACKED || r.type === Status.IGNORED).length; break;
		}

		this._sourceControl.revision = HEAD ? { rawSpecifier: 'HEAD', specifier: HEAD.name, id: HEAD.commit } : undefined;

		this._sourceControl.count = count;

		// set context key
		let stateContextKey = '';

		switch (this.state) {
			case RepositoryState.Idle: stateContextKey = 'idle'; break;
			case RepositoryState.Disposed: stateContextKey = 'norepo'; break;
		}

		this._sourceControl.remoteResources = remotes.map(remote => this.parseRemote(remote.url));

		this._onDidChangeStatus.fire();
	}

	private parseRemote(remote: string): Uri {
		// Convert ssh short syntax (e.g. user@company.com:foo/bar) to a valid URI.
		const sshMatch = remote.match(/^([^/@:]+@)?([^:/]+):([^/].*)$/);
		if (sshMatch) {
			const userName = sshMatch[1] || '';
			remote = `ssh://${userName}${sshMatch[2]}/${sshMatch[3]}`;
		}
		return Uri.parse(remote);
	}

	private onFSChange(uri: Uri): void {
		const config = workspace.getConfiguration('git');
		const autorefresh = config.get<boolean>('autorefresh');

		if (!autorefresh) {
			return;
		}

		if (this.isRepositoryHuge) {
			return;
		}

		if (!this.operations.isIdle()) {
			return;
		}

		this.eventuallyUpdateWhenIdleAndWait();
	}

	@debounce(1000)
	private eventuallyUpdateWhenIdleAndWait(): void {
		this.updateWhenIdleAndWait();
	}

	@throttle
	private async updateWhenIdleAndWait(): Promise<void> {
		await this.whenIdleAndFocused();
		await this.status();
		await timeout(5000);
	}

	async whenIdleAndFocused(): Promise<void> {
		while (true) {
			if (!this.operations.isIdle()) {
				await eventToPromise(this.onDidRunOperation);
				continue;
			}

			if (!window.state.focused) {
				const onDidFocusWindow = filterEvent(window.onDidChangeWindowState, e => e.focused);
				await eventToPromise(onDidFocusWindow);
				continue;
			}

			return;
		}
	}

	get headLabel(): string {
		const HEAD = this.HEAD;

		if (!HEAD) {
			return '';
		}

		const tag = this.refs.filter(iref => iref.type === RefType.Tag && iref.commit === HEAD.commit)[0];
		const tagName = tag && tag.name;
		const head = HEAD.name || tagName || (HEAD.commit || '').substr(0, 8);

		return head
			+ (this.workingTreeGroup.resourceStates.length > 0 ? '*' : '')
			+ (this.indexGroup.resourceStates.length > 0 ? '+' : '')
			+ (this.mergeGroup.resourceStates.length > 0 ? '!' : '');
	}

	get syncLabel(): string {
		if (!this.HEAD
			|| !this.HEAD.name
			|| !this.HEAD.commit
			|| !this.HEAD.upstream
			|| !(this.HEAD.ahead || this.HEAD.behind)
		) {
			return '';
		}

		return `${this.HEAD.behind}↓ ${this.HEAD.ahead}↑`;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}