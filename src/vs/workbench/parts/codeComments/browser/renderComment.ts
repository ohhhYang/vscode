/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { renderMarkdown } from 'vs/base/browser/htmlContentRenderer';
import { Comment } from 'vs/editor/common/services/codeCommentsService';
import { onUnexpectedError } from 'vs/base/common/errors';
import URI from 'vs/base/common/uri';
import { tokenizeToString } from 'vs/editor/common/modes/textToHtmlTokenizer';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IModeService } from 'vs/editor/common/services/modeService';

/**
 * Returns the rendered version of a comment.
 */
export function renderComment(accessor: ServicesAccessor, comment: Comment): Node {
	const openerService = accessor.get(IOpenerService);
	const modeService = accessor.get(IModeService);
	return renderMarkdown(comment.contents, {
		actionCallback: (content) => {
			openerService.open(URI.parse(content)).then(void 0, onUnexpectedError);
		},
		codeBlockRenderer: (languageAlias, value): string | TPromise<string> => {
			if (!languageAlias) {
				return value;
			}
			const modeId = modeService.getModeIdForLanguageName(languageAlias);
			return modeService.getOrCreateMode(modeId).then(() => {
				return tokenizeToString(value, modeId);
			});
		}
	});
}