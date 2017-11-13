/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as path from 'path';
import { dispose } from './util';
import { Model } from './model';
import distanceInWordsToNow = require('date-fns/distance_in_words_to_now');
const locale = require('date-fns/locale/' + vscode.env.language);

const localize = nls.loadMessageBundle();

const ICONS_ROOT_PATH = path.resolve(__dirname, '../resources/icons');

const getIcon = (icon: string) => vscode.Uri.file(path.join(ICONS_ROOT_PATH, icon));

const getIconForStatusState = (state: GitHubGQL.IStatusStateEnum): vscode.Uri => getIcon(`gh-status-icon--${state.toLowerCase()}.svg`);

// TODO custom icons
const getIconForPullRequestReviewState = (state: GitHubGQL.IPullRequestReviewStateEnum): vscode.Uri | undefined => {
	switch (state) {
		case 'APPROVED': return getIcon(`gh-status-icon--success.svg`);
		case 'CHANGES_REQUESTED': return getIcon(`gh-status-icon--failure.svg`);
		case 'PENDING': return getIcon(`gh-status-icon--pending.svg`);
		case 'COMMENTED': return getIcon(`gh-comment-icon.svg`);
		default: return undefined;
	}
};

const createWebBrowserCommandReference = (targetUrl: vscode.Uri | undefined): vscode.Command | undefined => {
	if (!targetUrl) {
		return undefined;
	}
	return {
		title: localize('viewInWebBrowser', "View in Web Browser..."),
		command: 'vscode.openWebBrowser',
		arguments: [targetUrl],
	};
};

/**
 * Manages the checklist providers for all active GitHub repositories.
 */
export class ChecklistController implements vscode.Disposable {

	private provider: vscode.ChecklistProvider;

	/**
	 * Single group that has one checklist item per status check per repository on the latest commit
	 */
	private statusGroup: vscode.ChecklistItemGroup;

	/**
	 * Map from GitHub PR URL to ChecklistItemGroup.
	 * We have one ChecklistItemGroup per PR
	 */
	private prChecklistItemGroups = new Map<string, vscode.ChecklistItemGroup>();

	private disposables: vscode.Disposable[] = [];

	constructor(
		private model: Model,
	) {
		this.provider = vscode.checklist.createChecklistProvider('github', localize('githubProvider', "GitHub"));
		this.disposables.push(this.provider);

		this.statusGroup = this.provider.createItemGroup('githubCommitStatus', localize('commitStatusGroup', "GitHub Commit Status"));
		this.statusGroup.hideWhenEmpty = true;
		this.disposables.push(this.statusGroup);

		this.model.onDidChangeRepositories(this.update, this, this.disposables);
		this.update();
	}

	private update(): void {

		const statusItems: vscode.ChecklistItem[] = [];
		const nextPrUrls = new Set<string>();

		for (const repo of this.model.repositories) {

			// Update the checklist item group for commit statuses
			if (repo.state.status) {
				for (const context of repo.state.status.contexts) {
					// Shorten name, only keep the last two segments
					// 'continuous-integration/travis-ci/push' -> 'travis-ci/push'
					let name = context.context.split('/').slice(-2).join('/');

					// Add folder name
					if (this.model.repositories.length > 1) {
						name = `${name} (${repo.currentGitHubRemote!.name})`;
					}

					statusItems.push({
						name,
						detail: context.description || undefined,
						decorations: decorationsForStatusState(context.state),
						command: createWebBrowserCommandReference(vscode.Uri.parse(context.targetUrl)),
					});
				}
			}

			// Update the checklist item groups for pull requests
			for (const pr of repo.state.pullRequests || []) {

				// Don't show closed or merged PRs
				if (pr.closed) {
					continue;
				}

				nextPrUrls.add(pr.url);
				let prChecklistItemGroup = this.prChecklistItemGroups.get(pr.url);
				if (!prChecklistItemGroup) {
					prChecklistItemGroup = this.provider.createItemGroup('githubPR', `GitHub PR #${pr.number} ${pr.title}`);
					this.disposables.push(prChecklistItemGroup);
					this.prChecklistItemGroups.set(pr.url, prChecklistItemGroup);
				}

				const reviewItems: vscode.ChecklistItem[] = [];
				const commentItems: vscode.ChecklistItem[] = [];

				for (const comment of pr.comments.nodes || []) {
					// Comments don't have a url field, but the ID contains the reference needed to construct the URL
					// Example ID (decoded): 012:IssueComment342274114
					let url: vscode.Uri | undefined;
					try {
						const match = new Buffer(comment.id, 'base64').toString().match(/(\d+)$/);
						url = match && vscode.Uri.parse(pr.url).with({ fragment: 'issuecomment-' + match[1] }) || undefined;
					} catch (err) {
						console.error('Failed to construct PR comment URL: ', err);
					}
					commentItems.push({
						name: comment.author && comment.author.login || '',
						description: localize('commented', "commented {0}", distanceInWordsToNow(new Date(comment.createdAt), { addSuffix: true, locale })),
						detail: comment.body,
						decorations: {},
						command: createWebBrowserCommandReference(url),
					});
				}

				for (const review of pr.reviews && pr.reviews.nodes || []) {
					// Add each review as a checklist item
					// Neutral reviews without a body are not worth showing as a checklist item
					// TODO only use latest review of each author
					const time = distanceInWordsToNow(new Date(review.createdAt), { addSuffix: true, locale });
					let description: string;
					switch (review.state) {
						case 'APPROVED': description = localize('approved', "approved {0}", time); break;
						case 'CHANGES_REQUESTED': description = localize('requestedChanges', "requested changes {0}", time); break;
						case 'COMMENTED': description = localize('reviewed', "reviewed {0}", time); break;
						default: continue;
					}
					if (review.body || review.state !== 'COMMENTED') {
						reviewItems.push({
							name: review.author && review.author.login || '',
							description,
							detail: review.body,
							decorations: {
								iconPath: getIconForPullRequestReviewState(review.state),
							},
							command: createWebBrowserCommandReference(vscode.Uri.parse(review.url)),
						});
					}
					// Add each top-level comment that is not outdated as a checklist item
					for (const comment of review.comments.nodes || []) {
						if (!comment.position || comment.replyTo) {
							continue;
						}
						commentItems.push({
							name: comment.author && comment.author.login || '',
							detail: comment.body,
							description: localize('commented', "commented {0}", distanceInWordsToNow(new Date(comment.createdAt), { addSuffix: true, locale })),
							decorations: {},
							command: createWebBrowserCommandReference(vscode.Uri.parse(comment.url)),
						});
					}
				}

				for (const request of pr.reviewRequests.nodes || []) {
					reviewItems.push({
						name: request.reviewer && request.reviewer.login || '',
						description: localize('requestedForReview', "was requested for review"),
						detail: '',
						decorations: {
							iconPath: getIconForPullRequestReviewState('PENDING'),
						},
					});
				}

				prChecklistItemGroup.itemStates = [
					{
						name: `${pr.author && pr.author.login}`,
						detail: pr.body,
						description: localize('opened', "opened {0}", distanceInWordsToNow(new Date(pr.createdAt), { addSuffix: true, locale })),
						decorations: {
							iconPath: getIcon('gh-pr.svg'),
						},
						command: createWebBrowserCommandReference(vscode.Uri.parse(pr.url)),
					},
					...reviewItems,
					...commentItems
				];
			}
		}

		// Remove check list item groups for PRs that are not in the new set of PRs to display
		// (because the branch changed, the PR was closed etc.)
		for (const [prUrl, group] of this.prChecklistItemGroups) {
			if (!nextPrUrls.has(prUrl)) {
				group.dispose();
				this.prChecklistItemGroups.delete(prUrl);
			}
		}

		this.statusGroup.itemStates = statusItems;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

function decorationsForStatusState(state: GitHubGQL.IStatusStateEnum): vscode.ChecklistItemDecorations {
	const iconPath = getIconForStatusState(state);
	return {
		faded: state === 'SUCCESS',
		light: {
			iconPath,
		},
		dark: {
			iconPath,
		},
	};
}
