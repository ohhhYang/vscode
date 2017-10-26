/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import iconv = require('iconv-lite');
import { assign, uniqBy, groupBy, denodeify, IDisposable, toDisposable, dispose, mkdirp } from './util';

const readfile = denodeify<string>(fs.readFile);

export interface IGit {
	path: string;
	version: string;
}

export interface IFileStatus {
	x: string;
	y: string;
	path: string;
	rename?: string;
}

export type DiffStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X';

export interface IFileDiff {
	status: DiffStatus;
	path: string;
	rename?: string;
}

export interface Remote {
	name: string;
	url: string;
}

export interface Stash {
	index: number;
	description: string;
}

export enum RefType {
	Head,
	RemoteHead,
	Tag
}

export interface Ref {
	type: RefType;

	/**
	 * The full name of the reference.
	 * (e.g. "refs/remotes/origin/mybranch")
	 */
	fullName?: string;

	/**
	 * This display name of the branch.
	 * (e.g. "foo" or "origin/bar")
	 */
	name?: string;

	/**
	 * The 40-byte commit SHA1
	 */
	commit?: string;

	/**
	 * The origin of the branch.
	 * (e.g. "origin", "upstream")
	 */
	remote?: string;

	/**
	 * The time when this reference was commited
	 */
	committerDate?: Date;

	/**
	 * The name of who committed this reference
	 */
	committerName?: string;
}

export interface Branch extends Ref {
	upstream?: string;
	ahead?: number;
	behind?: number;
}

function parseVersion(raw: string): string {
	return raw.replace(/^git version /, '');
}

function findSpecificGit(path: string): Promise<IGit> {
	return new Promise<IGit>((c, e) => {
		const buffers: Buffer[] = [];
		const child = cp.spawn(path, ['--version']);
		child.stdout.on('data', (b: Buffer) => buffers.push(b));
		child.on('error', cpErrorHandler(e, path));
		child.on('exit', code => code ? e(new Error('Not found')) : c({ path, version: parseVersion(Buffer.concat(buffers).toString('utf8').trim()) }));
	});
}

function findGitDarwin(): Promise<IGit> {
	return new Promise<IGit>((c, e) => {
		cp.exec('which git', (err, gitPathBuffer) => {
			if (err) {
				return e('git not found');
			}

			const path = gitPathBuffer.toString().replace(/^\s+|\s+$/g, '');

			function getVersion(path: string) {
				// make sure git executes
				cp.exec('git --version', (err, stdout) => {
					if (err) {
						return e('git not found');
					}

					return c({ path, version: parseVersion(stdout.trim()) });
				});
			}

			if (path !== '/usr/bin/git') {
				return getVersion(path);
			}

			// must check if XCode is installed
			cp.exec('xcode-select -p', (err: any) => {
				if (err && err.code === 2) {
					// git is not installed, and launching /usr/bin/git
					// will prompt the user to install it

					return e('git not found');
				}

				getVersion(path);
			});
		});
	});
}

function findSystemGitWin32(base: string): Promise<IGit> {
	if (!base) {
		return Promise.reject<IGit>('Not found');
	}

	return findSpecificGit(path.join(base, 'Git', 'cmd', 'git.exe'));
}

function findGitWin32(): Promise<IGit> {
	return findSystemGitWin32(process.env['ProgramW6432'])
		.then(void 0, () => findSystemGitWin32(process.env['ProgramFiles(x86)']))
		.then(void 0, () => findSystemGitWin32(process.env['ProgramFiles']))
		.then(void 0, () => findSpecificGit('git'));
}

export function findGit(hint: string | undefined): Promise<IGit> {
	var first = hint ? findSpecificGit(hint) : Promise.reject<IGit>(null);

	return first
		.then(void 0, () => {
			switch (process.platform) {
				case 'darwin': return findGitDarwin();
				case 'win32': return findGitWin32();
				default: return findSpecificGit('git');
			}
		})
		.then(null, () => Promise.reject(new Error('Git installation not found.')));
}

export interface IExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function cpErrorHandler(cb: (reason?: any) => void, dir?: string): (reason?: any) => void {
	return err => {
		if (/ENOENT/.test(err.message)) {
			const message = dir
				? `Failed to execute git (ENOENT) in ${dir}`
				: 'Failed to execute git (ENOENT)';
			err = new GitError({
				error: err,
				message,
				gitErrorCode: GitErrorCodes.NotAGitRepository
			});
		}

		cb(err);
	};
}

export interface SpawnOptions extends cp.SpawnOptions {
	input?: string;
	encoding?: string;
	log?: boolean;
}

async function exec(child: cp.ChildProcess, options: SpawnOptions = {}): Promise<IExecutionResult> {
	if (!child.stdout || !child.stderr) {
		throw new GitError({
			message: 'Failed to get stdout or stderr from git process.'
		});
	}

	const disposables: IDisposable[] = [];

	const once = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
		ee.once(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const on = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
		ee.on(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	let encoding = options.encoding || 'utf8';
	encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

	const [exitCode, stdout, stderr] = await Promise.all<any>([
		new Promise<number>((c, e) => {
			once(child, 'error', cpErrorHandler(e, options.cwd));
			once(child, 'exit', c);
		}),
		new Promise<string>(c => {
			const buffers: Buffer[] = [];
			on(child.stdout, 'data', b => buffers.push(b));
			once(child.stdout, 'close', () => c(iconv.decode(Buffer.concat(buffers), encoding)));
		}),
		new Promise<string>(c => {
			const buffers: Buffer[] = [];
			on(child.stderr, 'data', b => buffers.push(b));
			once(child.stderr, 'close', () => c(Buffer.concat(buffers).toString('utf8')));
		})
	]);

	dispose(disposables);

	return { exitCode, stdout, stderr };
}

export interface IGitErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;
}

export class GitError extends Error {

	error?: Error;
	message: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;

	constructor(data: IGitErrorData) {
		super(data.message || 'Git error');
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = void 0;
		}

		this.stdout = data.stdout;
		this.stderr = data.stderr;
		this.exitCode = data.exitCode;
		this.gitErrorCode = data.gitErrorCode;
		this.gitCommand = data.gitCommand;
	}

	toString(): string {
		let result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			gitErrorCode: this.gitErrorCode,
			gitCommand: this.gitCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, null, 2);

		if (this.error) {
			result += (<any>this.error).stack;
		}

		return result;
	}
}

export interface IGitOptions {
	gitPath: string;
	version: string;
	env?: any;
}

export const GitErrorCodes = {
	BadConfigFile: 'BadConfigFile',
	AuthenticationFailed: 'AuthenticationFailed',
	NoUserNameConfigured: 'NoUserNameConfigured',
	NoUserEmailConfigured: 'NoUserEmailConfigured',
	NoRemoteRepositorySpecified: 'NoRemoteRepositorySpecified',
	NotAGitRepository: 'NotAGitRepository',
	NotAtRepositoryRoot: 'NotAtRepositoryRoot',
	Conflict: 'Conflict',
	UnmergedChanges: 'UnmergedChanges',
	PushRejected: 'PushRejected',
	RemoteConnectionError: 'RemoteConnectionError',
	DirtyWorkTree: 'DirtyWorkTree',
	CantOpenResource: 'CantOpenResource',
	GitNotFound: 'GitNotFound',
	CantCreatePipe: 'CantCreatePipe',
	CantAccessRemote: 'CantAccessRemote',
	RepositoryNotFound: 'RepositoryNotFound',
	RepositoryIsLocked: 'RepositoryIsLocked',
	BranchNotFullyMerged: 'BranchNotFullyMerged',
	NoRemoteReference: 'NoRemoteReference',
	NoLocalChanges: 'NoLocalChanges',
	NoStashFound: 'NoStashFound',
	LocalChangesOverwritten: 'LocalChangesOverwritten'
};

function getGitErrorCode(stderr: string): string | undefined {
	if (/Another git process seems to be running in this repository|If no other git process is currently running/.test(stderr)) {
		return GitErrorCodes.RepositoryIsLocked;
	} else if (/Authentication failed/.test(stderr)) {
		return GitErrorCodes.AuthenticationFailed;
	} else if (/Not a git repository/.test(stderr)) {
		return GitErrorCodes.NotAGitRepository;
	} else if (/bad config file/.test(stderr)) {
		return GitErrorCodes.BadConfigFile;
	} else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
		return GitErrorCodes.CantCreatePipe;
	} else if (/Repository not found/.test(stderr)) {
		return GitErrorCodes.RepositoryNotFound;
	} else if (/unable to access/.test(stderr)) {
		return GitErrorCodes.CantAccessRemote;
	} else if (/branch '.+' is not fully merged/.test(stderr)) {
		return GitErrorCodes.BranchNotFullyMerged;
	} else if (/Couldn\'t find remote ref/.test(stderr)) {
		return GitErrorCodes.NoRemoteReference;
	}

	return void 0;
}

export class Git {

	private gitPath: string;
	private version: string;
	private env: any;

	private _onOutput = new EventEmitter();
	get onOutput(): EventEmitter { return this._onOutput; }

	constructor(options: IGitOptions) {
		this.gitPath = options.gitPath;
		this.version = options.version;
		this.env = options.env || {};
	}

	open(repository: string): Repository {
		return new Repository(this, repository);
	}

	async init(repository: string): Promise<void> {
		await this.exec(repository, ['init']);
		return;
	}

	async clone(url: string, parentPath: string): Promise<string> {
		const folderName = decodeURI(url).replace(/^.*\//, '').replace(/\.git$/, '') || 'repository';
		const folderPath = path.join(parentPath, folderName);

		await mkdirp(parentPath);
		await this.exec(parentPath, ['clone', url, folderPath]);
		return folderPath;
	}

	async getRepositoryRoot(repositoryPath: string): Promise<string> {
		const result = await this.exec(repositoryPath, ['rev-parse', '--show-toplevel']);
		return path.normalize(result.stdout.trim());
	}

	async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult> {
		options = assign({ cwd }, options || {});
		return await this._exec(args, options);
	}

	stream(cwd: string, args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		options = assign({ cwd }, options || {});
		return this.spawn(args, options);
	}

	private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult> {
		const child = this.spawn(args, options);

		if (options.input) {
			child.stdin.end(options.input, 'utf8');
		}

		const result = await exec(child, options);

		if (options.log !== false && result.stderr.length > 0) {
			this.log(`${result.stderr}\n`);
		}

		if (result.exitCode) {
			return Promise.reject<IExecutionResult>(new GitError({
				message: 'Failed to execute git',
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				gitErrorCode: getGitErrorCode(result.stderr),
				gitCommand: args[0]
			}));
		}

		return result;
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		if (!this.gitPath) {
			throw new Error('git could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		options.env = assign({}, process.env, this.env, options.env || {}, {
			VSCODE_GIT_COMMAND: args[0],
			LC_ALL: 'en_US.UTF-8',
			LANG: 'en_US.UTF-8'
		});

		if (options.log !== false) {
			this.log(`git ${args.join(' ')}\n`);
		}

		return cp.spawn(this.gitPath, args, options);
	}

	log(output: string): void {
		this._onOutput.emit('log', output);
	}
}

export interface Commit {
	hash: string;
	message: string;
}

export interface Worktree {
	path: string;
	head?: string;
	detached?: boolean;
	bare?: boolean;
	branch?: string;
}

export class GitStatusParser {

	private lastRaw = '';
	private result: IFileStatus[] = [];

	get status(): IFileStatus[] {
		return this.result;
	}

	update(raw: string): void {
		let i = 0;
		let nextI: number | undefined;

		raw = this.lastRaw + raw;

		while ((nextI = this.parseEntry(raw, i)) !== undefined) {
			i = nextI;
		}

		this.lastRaw = raw.substr(i);
	}

	private parseEntry(raw: string, i: number): number | undefined {
		if (i + 4 >= raw.length) {
			return;
		}

		let lastIndex: number;
		const entry: IFileStatus = {
			x: raw.charAt(i++),
			y: raw.charAt(i++),
			rename: undefined,
			path: ''
		};

		// space
		i++;

		if (entry.x === 'R' || entry.x === 'C') {
			lastIndex = raw.indexOf('\0', i);

			if (lastIndex === -1) {
				return;
			}

			entry.rename = raw.substring(i, lastIndex);
			i = lastIndex + 1;
		}

		lastIndex = raw.indexOf('\0', i);

		if (lastIndex === -1) {
			return;
		}

		entry.path = raw.substring(i, lastIndex);

		// If path ends with slash, it must be a nested git repo
		if (entry.path[entry.path.length - 1] !== '/') {
			this.result.push(entry);
		}

		return lastIndex + 1;
	}
}

export class GitDiffParser {

	private static PREFIX_LENGTH = ':000000 000000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 '.length;

	private lastRaw = '';
	private result: IFileDiff[] = [];

	get diff(): IFileDiff[] {
		return this.result;
	}

	update(raw: string): void {
		let i = 0;
		let nextI: number | undefined;

		raw = this.lastRaw + raw;

		while ((nextI = this.parseEntry(raw, i)) !== undefined) {
			i = nextI;
		}

		this.lastRaw = raw.substr(i);
	}

	private parseEntry(raw: string, i: number): number | undefined {
		if (i + GitDiffParser.PREFIX_LENGTH + 3 >= raw.length) {
			return;
		}

		i += GitDiffParser.PREFIX_LENGTH;

		let lastIndex: number;
		const entry: IFileDiff = {
			status: raw.charAt(i++) as DiffStatus,
			path: '',
			rename: undefined,
		};

		lastIndex = raw.indexOf('\0', i);
		if (lastIndex === -1) {
			return;
		}
		i = lastIndex + 1;

		if (entry.status === 'R' || entry.status === 'C') {
			lastIndex = raw.indexOf('\0', i);

			if (lastIndex === -1) {
				return;
			}

			entry.rename = raw.substring(i, lastIndex);
			i = lastIndex + 1;
		}

		lastIndex = raw.indexOf('\0', i);

		if (lastIndex === -1) {
			return;
		}

		entry.path = raw.substring(i, lastIndex);

		// If path ends with slash, it must be a nested git repo
		if (entry.path[entry.path.length - 1] !== '/') {
			this.result.push(entry);
		}

		return lastIndex + 1;
	}
}

export class Repository {

	constructor(
		private _git: Git,
		private repositoryRoot: string
	) { }

	get git(): Git {
		return this._git;
	}

	get root(): string {
		return this.repositoryRoot;
	}

	// TODO@Joao: rename to exec
	async run(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult> {
		return await this.git.exec(this.repositoryRoot, args, options);
	}

	stream(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.git.stream(this.repositoryRoot, args, options);
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.git.spawn(args, options);
	}

	async config(scope: string, key: string, value: any, options: SpawnOptions): Promise<string> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push(key);

		if (value) {
			args.push(value);
		}

		const result = await this.run(args, options);
		return result.stdout;
	}

	async buffer(object: string, encoding: string = 'utf8'): Promise<string> {
		const child = this.stream(['show', object]);

		if (!child.stdout) {
			return Promise.reject<string>('Can\'t open file from git');
		}

		const { exitCode, stdout } = await exec(child, { encoding });

		if (exitCode) {
			return Promise.reject<string>(new GitError({
				message: 'Could not show object.',
				exitCode
			}));
		}

		return stdout;

		// TODO@joao
		// return new Promise((c, e) => {
		// detectMimesFromStream(child.stdout, null, (err, result) => {
		// 	if (err) {
		// 		e(err);
		// 	} else if (isBinaryMime(result.mimes)) {
		// 		e(<IFileOperationResult>{
		// 			message: localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
		// 			fileOperationResult: FileOperationResult.FILE_IS_BINARY
		// 		});
		// 	} else {
		// c(this.doBuffer(object));
		// 	}
		// });
		// });
	}

	async add(paths: string[]): Promise<void> {
		const args = ['add', '-A', '--'];

		if (paths && paths.length) {
			args.push.apply(args, paths);
		} else {
			args.push('.');
		}

		await this.run(args);
	}

	async stage(path: string, data: string): Promise<void> {
		const child = this.stream(['hash-object', '--stdin', '-w', '--path', path], { stdio: [null, null, null] });
		child.stdin.end(data, 'utf8');

		const { exitCode, stdout } = await exec(child);

		if (exitCode) {
			throw new GitError({
				message: 'Could not hash object.',
				exitCode: exitCode
			});
		}

		await this.run(['update-index', '--cacheinfo', '100644', stdout, path]);
	}

	async checkout(treeish: string, paths: string[]): Promise<void> {
		const args = ['checkout', '-q'];

		if (treeish) {
			args.push(treeish);
		}

		if (paths && paths.length) {
			args.push('--');
			args.push.apply(args, paths);
		}

		try {
			await this.run(args);
		} catch (err) {
			if (/Please, commit your changes or stash them/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
			}

			throw err;
		}
	}

	async addWorktree(worktreeDir: string, ref: string): Promise<void> {
		const args = ['worktree', 'add', worktreeDir];

		if (ref) {
			args.push(ref.replace(/^refs\/heads\//, ''));
		}

		await this.run(args);
	}

	async worktreePrune(): Promise<void> {
		await this.run(['worktree', 'prune']);
	}

	async worktreeList(): Promise<Worktree[]> {
		const execResult = await this.run(['worktree', 'list', '--porcelain']);
		const worktreeChunks = execResult.stdout.split(/(?:\r?\n){2,}/);
		const worktrees: (Worktree | null)[] = worktreeChunks.map(chunk => {
			const lines = chunk.trim().split(/\r?\n/);
			if (!lines[0].startsWith('worktree ')) {
				return null;
			}
			const path = lines[0].slice('worktree '.length);
			const props = new Map<String, any>();
			for (const propLine of lines.slice(1)) {
				const f = propLine.trim().indexOf(' ');
				if (f === -1) {
					props.set(propLine, true);
				} else {
					props.set(propLine.slice(0, f), propLine.slice(f + 1));
				}
			}
			return {
				path: path,
				head: props.get('HEAD'),
				bare: props.get('bare'),
				branch: props.get('branch'),
				detached: props.get('detached'),
			};
		});
		return worktrees.filter(worktree => worktree) as Worktree[];
	}

	async commit(message: string, opts: { all?: boolean, amend?: boolean, signoff?: boolean, signCommit?: boolean } = Object.create(null)): Promise<void> {
		const args = ['commit', '--quiet', '--allow-empty-message', '--file', '-'];

		if (opts.all) {
			args.push('--all');
		}

		if (opts.amend) {
			args.push('--amend');
		}

		if (opts.signoff) {
			args.push('--signoff');
		}

		if (opts.signCommit) {
			args.push('-S');
		}

		try {
			await this.run(args, { input: message || '' });
		} catch (commitErr) {
			if (/not possible because you have unmerged files/.test(commitErr.stderr || '')) {
				commitErr.gitErrorCode = GitErrorCodes.UnmergedChanges;
				throw commitErr;
			}

			try {
				await this.run(['config', '--get-all', 'user.name']);
			} catch (err) {
				err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
				throw err;
			}

			try {
				await this.run(['config', '--get-all', 'user.email']);
			} catch (err) {
				err.gitErrorCode = GitErrorCodes.NoUserEmailConfigured;
				throw err;
			}

			throw commitErr;
		}
	}

	async branch(name: string, checkout: boolean): Promise<void> {
		const args = checkout ? ['checkout', '-q', '-b', name] : ['branch', '-q', name];
		await this.run(args);
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		const args = ['branch', force ? '-D' : '-d', name];
		await this.run(args);
	}

	async merge(ref: string, op?: { ffOnly?: boolean }): Promise<void> {
		const args = ['merge'];
		if (op && op.ffOnly) {
			args.push('--ff-only');
		}
		args.push(ref);

		try {
			await this.run(args);
		} catch (err) {
			if (/^CONFLICT /m.test(err.stdout || '')) {
				err.gitErrorCode = GitErrorCodes.Conflict;
			}

			throw err;
		}
	}

	async tag(name: string, message?: string): Promise<void> {
		let args = ['tag'];

		if (message) {
			args = [...args, '-a', name, '-m', message];
		} else {
			args = [...args, name];
		}

		await this.run(args);
	}

	async clean(paths: string[]): Promise<void> {
		const pathsByGroup = groupBy(paths, p => path.dirname(p));
		const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);
		const tasks = groups.map(paths => () => this.run(['clean', '-f', '-q', '--'].concat(paths)));

		for (let task of tasks) {
			await task();
		}
	}

	async undo(): Promise<void> {
		await this.run(['clean', '-fd']);

		try {
			await this.run(['checkout', '--', '.']);
		} catch (err) {
			if (/did not match any file\(s\) known to git\./.test(err.stderr || '')) {
				return;
			}

			throw err;
		}
	}

	async reset(treeish: string, hard: boolean = false): Promise<void> {
		const args = ['reset'];

		if (hard) {
			args.push('--hard');
		}

		args.push(treeish);

		await this.run(args);
	}

	async revert(treeish: string, paths: string[]): Promise<void> {
		const result = await this.run(['branch']);
		let args: string[];

		// In case there are no branches, we must use rm --cached
		if (!result.stdout) {
			args = ['rm', '--cached', '-r', '--'];
		} else {
			args = ['reset', '-q', treeish, '--'];
		}

		if (paths && paths.length) {
			args.push.apply(args, paths);
		} else {
			args.push('.');
		}

		try {
			await this.run(args);
		} catch (err) {
			// In case there are merge conflicts to be resolved, git reset will output
			// some "needs merge" data. We try to get around that.
			if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
				return;
			}

			throw err;
		}
	}

	async fetch(op?: { all?: boolean, prune?: boolean, repository?: string, refspec?: string }): Promise<void> {
		const args = ['fetch'];
		if (op) {
			if (op.all) {
				args.push('--all');
			}
			if (op.prune) {
				args.push('--prune');
			}
			if (op.repository) {
				args.push('--', op.repository);
			}
			if (op.refspec) {
				if (!op.repository) {
					throw new GitError({
						message: 'Failed to execute git, repository is required if specify refspec for git fetch',
						stdout: '',
						stderr: '',
						exitCode: -1,
						gitErrorCode: GitErrorCodes.NoRemoteRepositorySpecified,
						gitCommand: 'git',
					});
				}
				args.push(op.refspec);
			}
		}
		try {
			await this.run(args);
		} catch (err) {
			if (/No remote repository specified\./.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.NoRemoteRepositorySpecified;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			}

			throw err;
		}
	}

	async pull(rebase?: boolean, remote?: string, branch?: string): Promise<void> {
		const args = ['pull'];

		if (rebase) {
			args.push('-r');
		}

		if (remote && branch) {
			args.push(remote);
			args.push(branch);
		}

		try {
			await this.run(args);
		} catch (err) {
			if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
				err.gitErrorCode = GitErrorCodes.Conflict;
			} else if (/Please tell me who you are\./.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			} else if (/Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
			}

			throw err;
		}
	}

	async push(remote?: string, name?: string, setUpstream: boolean = false, tags = false): Promise<void> {
		const args = ['push'];

		if (setUpstream) {
			args.push('-u');
		}

		if (tags) {
			args.push('--tags');
		}

		if (remote) {
			args.push(remote);
		}

		if (name) {
			args.push(name);
		}

		try {
			await this.run(args);
		} catch (err) {
			if (/^error: failed to push some refs to\b/m.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.PushRejected;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			}

			throw err;
		}
	}

	async createStash(message?: string): Promise<void> {
		try {
			const args = ['stash', 'save'];

			if (message) {
				args.push('--', message);
			}

			await this.run(args);
		} catch (err) {
			if (/No local changes to save/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.NoLocalChanges;
			}

			throw err;
		}
	}

	async popStash(index?: number): Promise<void> {
		try {
			const args = ['stash', 'pop'];

			if (typeof index === 'string') {
				args.push(`stash@{${index}}`);
			}

			await this.run(args);
		} catch (err) {
			if (/No stash found/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.NoStashFound;
			} else if (/error: Your local changes to the following files would be overwritten/.test(err.stderr || '')) {
				err.gitErrorCode = GitErrorCodes.LocalChangesOverwritten;
			}

			throw err;
		}
	}

	getStatus(limit = 5000): Promise<{ status: IFileStatus[]; didHitLimit: boolean; }> {
		return new Promise<{ status: IFileStatus[]; didHitLimit: boolean; }>((c, e) => {
			const parser = new GitStatusParser();
			const env = { GIT_OPTIONAL_LOCKS: '0' };
			const child = this.stream(['status', '-z', '-u'], { env });

			const onExit = exitCode => {
				if (exitCode !== 0) {
					const stderr = stderrData.join('');
					return e(new GitError({
						message: 'Failed to execute git',
						stderr,
						exitCode,
						gitErrorCode: getGitErrorCode(stderr),
						gitCommand: 'status'
					}));
				}

				c({ status: parser.status, didHitLimit: false });
			};

			const onStdoutData = (raw: string) => {
				parser.update(raw);

				if (parser.status.length > 5000) {
					child.removeListener('exit', onExit);
					child.stdout.removeListener('data', onStdoutData);
					child.kill();

					c({ status: parser.status.slice(0, 5000), didHitLimit: true });
				}
			};

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', onStdoutData);

			const stderrData: string[] = [];
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', raw => stderrData.push(raw as string));

			child.on('error', cpErrorHandler(e, this.repositoryRoot));
			child.on('exit', onExit);
		});
	}

	getDiff(args: string[], limit = 5000): Promise<{ diff: IFileDiff[]; didHitLimit: boolean; }> {
		return new Promise<{ diff: IFileDiff[]; didHitLimit: boolean; }>((c, e) => {
			const parser = new GitDiffParser();
			const child = this.stream(['diff', '-z', '--raw', '--abbrev=40', '-M', '-C', ...args]);

			const onExit = exitCode => {
				if (exitCode !== 0) {
					const stderr = stderrData.join('');
					return e(new GitError({
						message: 'Failed to execute git',
						stderr,
						exitCode,
						gitErrorCode: getGitErrorCode(stderr),
						gitCommand: 'diff-index'
					}));
				}

				c({ diff: parser.diff, didHitLimit: false });
			};

			const onStdoutData = (raw: string) => {
				parser.update(raw);

				if (parser.diff.length > 5000) {
					child.removeListener('exit', onExit);
					child.stdout.removeListener('data', onStdoutData);
					child.kill();

					c({ diff: parser.diff.slice(0, 5000), didHitLimit: true });
				}
			};

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', onStdoutData);

			const stderrData: string[] = [];
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', raw => stderrData.push(raw as string));

			child.on('error', e);
			child.on('exit', onExit);
		});
	}

	async getHEAD(): Promise<Ref> {
		try {
			const result = await this.run(['symbolic-ref', '--short', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Not in a branch');
			}

			return { name: result.stdout.trim(), commit: void 0, type: RefType.Head };
		} catch (err) {
			const result = await this.run(['rev-parse', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Error parsing HEAD');
			}

			return { name: void 0, commit: result.stdout.trim(), type: RefType.Head };
		}
	}

	async getRefs(): Promise<Ref[]> {
		// %09 is a tab character
		const result = await this.run(['for-each-ref', '--format', '%(refname)%09%(objectname)%09%(committername)%09%(committerdate:unix)']);

		const fn = (line: string): Ref | null => {
			const [fullName, commit, committerName, committerDateTs]: (string | undefined)[] = line.trim().split('\t');
			if (!fullName) {
				return null;
			}
			const [, refTypeStr, ...remoteName] = fullName.split('/');
			let type: RefType;
			let remote: string | undefined;
			switch (refTypeStr) {
				case 'heads': type = RefType.Head; break;
				case 'tags': type = RefType.Tag; break;
				case 'remotes': {
					type = RefType.RemoteHead;
					remote = remoteName[0];
					break;
				}
				default: return null;
			}
			const name: string | undefined = remoteName.join('/') || undefined;
			const committerDate = committerDateTs && new Date(~~committerDateTs * 1000) || undefined;
			return { fullName, name, commit, type, remote, committerName, committerDate };
		};

		return result.stdout.trim().split('\n')
			.filter(line => !!line)
			.map(fn)
			.filter(ref => !!ref) as Ref[];
	}

	async getStashes(): Promise<Stash[]> {
		const result = await this.run(['stash', 'list']);
		const regex = /^stash@{(\d+)}:(.+)$/;
		const rawStashes = result.stdout.trim().split('\n')
			.filter(b => !!b)
			.map(line => regex.exec(line))
			.filter(g => !!g)
			.map(([, index, description]: RegExpExecArray) => ({ index: parseInt(index), description }));

		return rawStashes;
	}

	async getRemotes(): Promise<Remote[]> {
		const result = await this.run(['remote', '--verbose']);
		const regex = /^([^\s]+)\s+([^\s]+)\s/;
		const rawRemotes = result.stdout.trim().split('\n')
			.filter(b => !!b)
			.map(line => regex.exec(line))
			.filter(g => !!g)
			.map((groups: RegExpExecArray) => ({ name: groups[1], url: groups[2] }));

		return uniqBy(rawRemotes, remote => remote.name);
	}

	async getBranch(name: string): Promise<Branch> {
		if (name === 'HEAD') {
			return this.getHEAD();
		}

		const result = await this.run(['rev-parse', name]);

		if (!result.stdout) {
			return Promise.reject<Branch>(new Error('No such branch'));
		}

		const commit = result.stdout.trim();

		try {
			const res2 = await this.run(['rev-parse', '--symbolic-full-name', '--abbrev-ref', name + '@{u}']);
			const upstream = res2.stdout.trim();

			const res3 = await this.run(['rev-list', '--left-right', name + '...' + upstream]);

			let ahead = 0, behind = 0;
			let i = 0;

			while (i < res3.stdout.length) {
				switch (res3.stdout.charAt(i)) {
					case '<': ahead++; break;
					case '>': behind++; break;
					default: i++; break;
				}

				while (res3.stdout.charAt(i++) !== '\n') { /* no-op */ }
			}

			return { name, type: RefType.Head, commit, upstream, ahead, behind };
		} catch (err) {
			return { name, type: RefType.Head, commit };
		}
	}

	async getCommitTemplate(): Promise<string> {
		try {
			const result = await this.run(['config', '--get', 'commit.template']);

			if (!result.stdout) {
				return '';
			}

			// https://github.com/git/git/blob/3a0f269e7c82aa3a87323cb7ae04ac5f129f036b/path.c#L612
			const homedir = os.homedir();
			let templatePath = result.stdout.trim()
				.replace(/^~([^\/]*)\//, (_, user) => `${user ? path.join(path.dirname(homedir), user) : homedir}/`);

			if (!path.isAbsolute(templatePath)) {
				templatePath = path.join(this.repositoryRoot, templatePath);
			}

			const raw = await readfile(templatePath, 'utf8');
			return raw.replace(/^\s*#.*$\n?/gm, '').trim();

		} catch (err) {
			return '';
		}
	}

	async getCommit(ref: string): Promise<Commit> {
		const result = await this.run(['show', '-s', '--format=%H\n%B', ref]);
		const match = /^([0-9a-f]{40})\n([^]*)$/m.exec(result.stdout.trim());

		if (!match) {
			return Promise.reject<Commit>('bad commit format');
		}

		return { hash: match[1], message: match[2] };
	}

	async getMergeBase(args: string[]): Promise<string[]> {
		const result = await this.run(['merge-base', ...args]);
		return result.stdout.trim().split('\n');
	}

	async revParse(args: string[]): Promise<string[]> {
		const result = await this.run(['rev-parse', '--symbolic', ...args]);
		return result.stdout.trim().split('\n');
	}
}
