/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { localize } from 'vs/nls';
import { Disposable } from 'vs/workbench/services/codeComments/common/disposable';
import Event, { Emitter, chain } from 'vs/base/common/event';
import { $ } from 'vs/base/browser/builder';
import { InputBox } from 'vs/base/browser/ui/inputbox/inputBox';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { attachInputBoxStyler, attachButtonStyler } from 'vs/platform/theme/common/styler';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { domEvent } from 'vs/base/browser/event';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Button } from 'vs/base/browser/ui/button/button';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { editorBackground, editorActiveLinkForeground } from 'vs/platform/theme/common/colorRegistry';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { OPEN_INVITE_ACTION_ID } from 'vs/workbench/parts/invite/common/constants';

export interface SubmitEvent {
	content: string;
}

/**
 * Input field for a code comment.
 */
export class CommentInput extends Disposable {

	private inputBox: InputBox;

	private didChangeHeight = this.disposable(new Emitter<void>());
	public readonly onDidChangeHeight: Event<void> = this.didChangeHeight.event;

	private submitButton: Button;
	private didClickSubmitButton = this.disposable(new Emitter<SubmitEvent>());
	public readonly onDidClickSubmitButton: Event<SubmitEvent> = this.didClickSubmitButton.event;

	private secondaryButton: Button;
	private didClickSecondaryButton = this.disposable(new Emitter<void>());
	public readonly onDidClickSecondaryButton: Event<void> = this.didClickSecondaryButton.event;

	constructor(
		parent: HTMLElement,
		placeholder: string,
		content: string,
		secondaryButtonLabel: string,
		@IContextViewService private contextViewService: IContextViewService,
		@IThemeService private themeService: IThemeService,
		@IMessageService private messageService: IMessageService,
		@ICommandService private commandService: ICommandService
	) {
		super();

		$(parent).div({ class: 'commentInput' }, div => {
			div.div({ class: 'inputContainer' }, div => {
				this.inputBox = new InputBox(div.getHTMLElement(), this.contextViewService, {
					placeholder,
					flexibleHeight: true
				});
				this.inputBox.value = content || '';
				this.disposable(attachInputBoxStyler(this.inputBox, this.themeService));
				this.disposable(this.inputBox);
				this.disposable(this.inputBox.onDidHeightChange(() => this.didChangeHeight.fire()));

				this.disposable(chain(domEvent(this.inputBox.inputElement, 'keydown'))
					.map(e => new StandardKeyboardEvent(e))
					.filter(e => e.equals(KeyMod.CtrlCmd | KeyCode.Enter) || e.equals(KeyMod.CtrlCmd | KeyCode.KEY_S))
					.on(() => this.handleSubmit()));
			});

			div.div({ class: 'submit' }, div => {
				div.div({ class: 'hint' }, div => {
					const buttonContainer = $('div').addClass('hint');
					const inviteButton = new Button(buttonContainer);
					inviteButton.label = localize('comment.inviteOrgMember', "Invite a member to your organization");
					this.disposables.push(inviteButton.addListener('click', () => {
						this.commandService.executeCommand(OPEN_INVITE_ACTION_ID);
					}));
					attachButtonStyler(inviteButton, this.themeService, {
						buttonBackground: editorBackground,
						buttonHoverBackground: editorBackground,
						buttonForeground: editorActiveLinkForeground
					});
					const inviteEl = inviteButton.getElement();
					inviteEl.style.padding = '0px';
					inviteEl.style.margin = '0px';
					div.text(localize('submitHint', "Markdown supported. ")).append(buttonContainer);
				});

				this.secondaryButton = new Button(div.getContainer());
				this.secondaryButton.label = secondaryButtonLabel;
				attachButtonStyler(this.secondaryButton, this.themeService, {
					buttonBackground: editorBackground,
				});
				this.disposable(this.secondaryButton);
				this.disposable(this.secondaryButton.addListener('click', () => this.didClickSecondaryButton.fire()));

				this.submitButton = new Button(div.getContainer());
				this.submitButton.label = localize('submitComment', "Comment");
				attachButtonStyler(this.submitButton, this.themeService);
				this.disposable(this.submitButton);
				this.disposable(this.submitButton.addListener('click', () => this.handleSubmit()));
			});
		});
	}

	public get onDidChangeContent(): Event<string> {
		return this.inputBox.onDidChange;
	}

	public set value(value: string) {
		this.inputBox.value = value;
	}

	private _secondaryButtonLabel: string;
	public set secondaryButtonLabel(label: string) {
		const oldLabel = this._secondaryButtonLabel;
		this._secondaryButtonLabel = label;
		this.secondaryButton.label = label;
		if (label !== oldLabel) {
			this.didChangeHeight.fire();
		}
	}

	public setEnabled(enabled: boolean) {
		this.submitButton.enabled = enabled;
		this.inputBox.setEnabled(enabled);
	}

	public showError(error: Error): void {
		const err = Array.isArray(error) ? error.filter(e => !!e).join('\n') : error.toString();
		this.inputBox.showMessage({
			content: err,
			formatContent: true,
		});
		this.messageService.show(Severity.Error, err);
	}

	private handleSubmit(): void {
		this.didClickSubmitButton.fire({ content: this.inputBox.value });
	}

	public focus(): void {
		this.inputBox.focus();
	}
}