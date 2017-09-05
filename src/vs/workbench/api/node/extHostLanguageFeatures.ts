/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { mixin } from 'vs/base/common/objects';
import * as vscode from 'vscode';
import * as TypeConverters from 'vs/workbench/api/node/extHostTypeConverters';
import { Range, Disposable, CompletionList, CompletionItem, SnippetString } from 'vs/workbench/api/node/extHostTypes';
import { ISingleEditOperation } from 'vs/editor/common/editorCommon';
import * as modes from 'vs/editor/common/modes';
import { ExtHostHeapService } from 'vs/workbench/api/node/extHostHeapService';
import { ExtHostDocuments } from 'vs/workbench/api/node/extHostDocuments';
import { ExtHostCommands, CommandsConverter } from 'vs/workbench/api/node/extHostCommands';
import { ExtHostDiagnostics } from 'vs/workbench/api/node/extHostDiagnostics';
import { IWorkspaceSymbolProvider } from 'vs/workbench/parts/search/common/search';
import { asWinJsPromise } from 'vs/base/common/async';
import { MainContext, MainThreadTelemetryShape, MainThreadLanguageFeaturesShape, ExtHostLanguageFeaturesShape, ObjectIdentifier, IRawColorInfo, IRawColorFormatMap, IMainContext } from './extHost.protocol';
import { regExpLeadsToEndlessLoop } from 'vs/base/common/strings';
import { IPosition } from 'vs/editor/common/core/position';
import { IRange } from 'vs/editor/common/core/range';
import { containsCommandLink } from 'vs/base/common/htmlContent';
import { isFalsyOrEmpty } from 'vs/base/common/arrays';
import { once } from 'vs/base/common/functional';

// --- adapter

class OutlineAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.DocumentSymbolProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.DocumentSymbolProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideDocumentSymbols(resource: URI): TPromise<modes.SymbolInformation[]> {
		let doc = this._documents.getDocumentData(resource).document;
		return asWinJsPromise(token => this._provider.provideDocumentSymbols(doc, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.fromSymbolInformation);
			}
			return undefined;
		});
	}
}

class CodeLensAdapter {

	private static _badCmd: vscode.Command = { command: 'missing', title: '<<MISSING COMMAND>>' };

	private _documents: ExtHostDocuments;
	private _commands: CommandsConverter;
	private _heapService: ExtHostHeapService;
	private _provider: vscode.CodeLensProvider;

	constructor(documents: ExtHostDocuments, commands: CommandsConverter, heapService: ExtHostHeapService, provider: vscode.CodeLensProvider) {
		this._documents = documents;
		this._commands = commands;
		this._heapService = heapService;
		this._provider = provider;
	}

	provideCodeLenses(resource: URI): TPromise<modes.ICodeLensSymbol[]> {
		const doc = this._documents.getDocumentData(resource).document;

		return asWinJsPromise(token => this._provider.provideCodeLenses(doc, token)).then(lenses => {
			if (Array.isArray(lenses)) {
				return lenses.map(lens => {
					const id = this._heapService.keep(lens);
					return ObjectIdentifier.mixin({
						range: TypeConverters.fromRange(lens.range),
						command: this._commands.toInternal(lens.command)
					}, id);
				});
			}
			return undefined;
		});
	}

	resolveCodeLens(resource: URI, symbol: modes.ICodeLensSymbol): TPromise<modes.ICodeLensSymbol> {

		const lens = this._heapService.get<vscode.CodeLens>(ObjectIdentifier.of(symbol));
		if (!lens) {
			return undefined;
		}

		let resolve: TPromise<vscode.CodeLens>;
		if (typeof this._provider.resolveCodeLens !== 'function' || lens.isResolved) {
			resolve = TPromise.as(lens);
		} else {
			resolve = asWinJsPromise(token => this._provider.resolveCodeLens(lens, token));
		}

		return resolve.then(newLens => {
			newLens = newLens || lens;
			symbol.command = this._commands.toInternal(newLens.command || CodeLensAdapter._badCmd);
			return symbol;
		});
	}
}

class DefinitionAdapter {
	private _documents: ExtHostDocuments;
	private _provider: vscode.DefinitionProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.DefinitionProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideDefinition(resource: URI, position: IPosition): TPromise<modes.Definition> {
		let doc = this._documents.getDocumentData(resource).document;
		let pos = TypeConverters.toPosition(position);
		return asWinJsPromise(token => this._provider.provideDefinition(doc, pos, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.location.from);
			} else if (value) {
				return TypeConverters.location.from(value);
			}
			return undefined;
		});
	}
}

class ImplementationAdapter {
	private _documents: ExtHostDocuments;
	private _provider: vscode.ImplementationProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.ImplementationProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideImplementation(resource: URI, position: IPosition): TPromise<modes.Definition> {
		let doc = this._documents.getDocumentData(resource).document;
		let pos = TypeConverters.toPosition(position);
		return asWinJsPromise(token => this._provider.provideImplementation(doc, pos, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.location.from);
			} else if (value) {
				return TypeConverters.location.from(value);
			}
			return undefined;
		});
	}
}

class TypeDefinitionAdapter {
	private _documents: ExtHostDocuments;
	private _provider: vscode.TypeDefinitionProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.TypeDefinitionProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideTypeDefinition(resource: URI, position: IPosition): TPromise<modes.Definition> {
		const doc = this._documents.getDocumentData(resource).document;
		const pos = TypeConverters.toPosition(position);
		return asWinJsPromise(token => this._provider.provideTypeDefinition(doc, pos, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.location.from);
			} else if (value) {
				return TypeConverters.location.from(value);
			}
			return undefined;
		});
	}
}


class HoverAdapter {

	constructor(
		private readonly _documents: ExtHostDocuments,
		private readonly _provider: vscode.HoverProvider,
		private readonly _telemetryLog: (name: string, data: object) => void,
	) {
		//
	}

	public provideHover(resource: URI, position: IPosition): TPromise<modes.Hover> {

		let doc = this._documents.getDocumentData(resource).document;
		let pos = TypeConverters.toPosition(position);

		return asWinJsPromise(token => this._provider.provideHover(doc, pos, token)).then(value => {
			if (!value || isFalsyOrEmpty(value.contents)) {
				return undefined;
			}
			if (!value.range) {
				value.range = doc.getWordRangeAtPosition(pos);
			}
			if (!value.range) {
				value.range = new Range(pos, pos);
			}

			const result = TypeConverters.fromHover(value);

			// we wanna know which extension uses command links
			// because that is a potential trick-attack on users
			if (result.contents.some(h => containsCommandLink(h.value))) {
				this._telemetryLog('usesCommandLink', { from: 'hover' });
			}
			return result;
		});
	}
}

class DocumentHighlightAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.DocumentHighlightProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.DocumentHighlightProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideDocumentHighlights(resource: URI, position: IPosition): TPromise<modes.DocumentHighlight[]> {

		let doc = this._documents.getDocumentData(resource).document;
		let pos = TypeConverters.toPosition(position);

		return asWinJsPromise(token => this._provider.provideDocumentHighlights(doc, pos, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(DocumentHighlightAdapter._convertDocumentHighlight);
			}
			return undefined;
		});
	}

	private static _convertDocumentHighlight(documentHighlight: vscode.DocumentHighlight): modes.DocumentHighlight {
		return {
			range: TypeConverters.fromRange(documentHighlight.range),
			kind: documentHighlight.kind
		};
	}
}

class ReferenceAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.ReferenceProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.ReferenceProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideReferences(resource: URI, position: IPosition, context: modes.ReferenceContext, progress: (locations: modes.Location[]) => void): TPromise<modes.Location[]> {
		const doc = this._documents.getDocumentData(resource).document;
		const pos = TypeConverters.toPosition(position);

		const convertLocations = (locations: vscode.Location[]) => {
			if (Array.isArray(locations)) {
				return locations.map(TypeConverters.location.from);
			}
			return undefined;
		};
		const convertedProgress = (locations: vscode.Location[]) => {
			const convertedLocations = convertLocations(locations);
			if (convertedLocations) {
				progress(convertedLocations);
			}
		};
		return asWinJsPromise(token => this._provider.provideReferences(doc, pos, context, token, convertedProgress)).then(convertLocations);
	}
}

class QuickFixAdapter {

	private _documents: ExtHostDocuments;
	private _commands: CommandsConverter;
	private _diagnostics: ExtHostDiagnostics;
	private _provider: vscode.CodeActionProvider;

	constructor(documents: ExtHostDocuments, commands: CommandsConverter, diagnostics: ExtHostDiagnostics, provider: vscode.CodeActionProvider) {
		this._documents = documents;
		this._commands = commands;
		this._diagnostics = diagnostics;
		this._provider = provider;
	}

	provideCodeActions(resource: URI, range: IRange): TPromise<modes.Command[]> {

		const doc = this._documents.getDocumentData(resource).document;
		const ran = <vscode.Range>TypeConverters.toRange(range);
		const allDiagnostics: vscode.Diagnostic[] = [];

		this._diagnostics.forEach(collection => {
			if (collection.has(resource)) {
				for (let diagnostic of collection.get(resource)) {
					if (ran.contains(diagnostic.range)) {
						allDiagnostics.push(diagnostic);
					}
				}
			}
		});

		return asWinJsPromise(token => this._provider.provideCodeActions(doc, ran, { diagnostics: allDiagnostics }, token)).then(commands => {
			if (!Array.isArray(commands)) {
				return undefined;
			}
			return commands.map(command => this._commands.toInternal(command));
		});
	}
}

class DocumentFormattingAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.DocumentFormattingEditProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.DocumentFormattingEditProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideDocumentFormattingEdits(resource: URI, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {

		const { document } = this._documents.getDocumentData(resource);

		return asWinJsPromise(token => this._provider.provideDocumentFormattingEdits(document, <any>options, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.TextEdit.from);
			}
			return undefined;
		});
	}
}

class RangeFormattingAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.DocumentRangeFormattingEditProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.DocumentRangeFormattingEditProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideDocumentRangeFormattingEdits(resource: URI, range: IRange, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {

		const { document } = this._documents.getDocumentData(resource);
		const ran = TypeConverters.toRange(range);

		return asWinJsPromise(token => this._provider.provideDocumentRangeFormattingEdits(document, ran, <any>options, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.TextEdit.from);
			}
			return undefined;
		});
	}
}

class OnTypeFormattingAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.OnTypeFormattingEditProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.OnTypeFormattingEditProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	autoFormatTriggerCharacters: string[] = []; // not here

	provideOnTypeFormattingEdits(resource: URI, position: IPosition, ch: string, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {

		const { document } = this._documents.getDocumentData(resource);
		const pos = TypeConverters.toPosition(position);

		return asWinJsPromise(token => this._provider.provideOnTypeFormattingEdits(document, pos, ch, <any>options, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(TypeConverters.TextEdit.from);
			}
			return undefined;
		});
	}
}


class NavigateTypeAdapter implements IWorkspaceSymbolProvider {

	private _provider: vscode.WorkspaceSymbolProvider;
	private _heapService: ExtHostHeapService;

	constructor(provider: vscode.WorkspaceSymbolProvider, heapService: ExtHostHeapService) {
		this._provider = provider;
		this._heapService = heapService;
	}

	provideWorkspaceSymbols(search: string): TPromise<modes.SymbolInformation[]> {

		return asWinJsPromise(token => this._provider.provideWorkspaceSymbols(search, token)).then(value => {
			if (Array.isArray(value)) {
				return value.map(item => {
					const id = this._heapService.keep(item);
					const result = TypeConverters.fromSymbolInformation(item);
					return ObjectIdentifier.mixin(result, id);
				});
			}
			return undefined;
		});
	}

	resolveWorkspaceSymbol(item: modes.SymbolInformation): TPromise<modes.SymbolInformation> {

		if (typeof this._provider.resolveWorkspaceSymbol !== 'function') {
			return TPromise.as(item);
		}

		const symbolInfo = this._heapService.get<vscode.SymbolInformation>(ObjectIdentifier.of(item));
		if (symbolInfo) {
			return asWinJsPromise(token => this._provider.resolveWorkspaceSymbol(symbolInfo, token)).then(value => {
				return value && TypeConverters.fromSymbolInformation(value);
			});
		}
		return undefined;
	}
}

class RenameAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.RenameProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.RenameProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideRenameEdits(resource: URI, position: IPosition, newName: string): TPromise<modes.WorkspaceEdit> {

		let doc = this._documents.getDocumentData(resource).document;
		let pos = TypeConverters.toPosition(position);

		return asWinJsPromise(token => this._provider.provideRenameEdits(doc, pos, newName, token)).then(value => {
			if (!value) {
				return undefined;
			}

			let result = <modes.WorkspaceEdit>{
				edits: []
			};

			for (let entry of value.entries()) {
				let [uri, textEdits] = entry;
				for (let textEdit of textEdits) {
					result.edits.push({
						resource: <URI>uri,
						newText: textEdit.newText,
						range: TypeConverters.fromRange(textEdit.range)
					});
				}
			}
			return result;
		}, err => {
			if (typeof err === 'string') {
				return <modes.WorkspaceEdit>{
					edits: undefined,
					rejectReason: err
				};
			}
			return TPromise.wrapError<modes.WorkspaceEdit>(err);
		});
	}
}


class SuggestAdapter {

	private _documents: ExtHostDocuments;
	private _commands: CommandsConverter;
	private _heapService: ExtHostHeapService;
	private _provider: vscode.CompletionItemProvider;

	constructor(documents: ExtHostDocuments, commands: CommandsConverter, heapService: ExtHostHeapService, provider: vscode.CompletionItemProvider) {
		this._documents = documents;
		this._commands = commands;
		this._heapService = heapService;
		this._provider = provider;
	}

	provideCompletionItems(resource: URI, position: IPosition): TPromise<modes.ISuggestResult> {

		const doc = this._documents.getDocumentData(resource).document;
		const pos = TypeConverters.toPosition(position);

		return asWinJsPromise<vscode.CompletionItem[] | vscode.CompletionList>(token => this._provider.provideCompletionItems(doc, pos, token)).then(value => {

			const result: modes.ISuggestResult = {
				suggestions: [],
			};

			let list: CompletionList;
			if (!value) {
				// undefined and null are valid results
				return undefined;

			} else if (Array.isArray(value)) {
				list = new CompletionList(value);

			} else {
				list = value;
				result.incomplete = list.isIncomplete;
			}

			// the default text edit range
			const wordRangeBeforePos = (doc.getWordRangeAtPosition(pos) || new Range(pos, pos))
				.with({ end: pos });

			for (const item of list.items) {

				const suggestion = this._convertCompletionItem(item, pos, wordRangeBeforePos);

				// bad completion item
				if (!suggestion) {
					// converter did warn
					continue;
				}

				ObjectIdentifier.mixin(suggestion, this._heapService.keep(item));
				result.suggestions.push(suggestion);
			}

			return result;
		});
	}

	resolveCompletionItem(resource: URI, position: IPosition, suggestion: modes.ISuggestion): TPromise<modes.ISuggestion> {

		if (typeof this._provider.resolveCompletionItem !== 'function') {
			return TPromise.as(suggestion);
		}

		const id = ObjectIdentifier.of(suggestion);
		const item = this._heapService.get<CompletionItem>(id);
		if (!item) {
			return TPromise.as(suggestion);
		}

		return asWinJsPromise(token => this._provider.resolveCompletionItem(item, token)).then(resolvedItem => {

			if (!resolvedItem) {
				return suggestion;
			}

			const doc = this._documents.getDocumentData(resource).document;
			const pos = TypeConverters.toPosition(position);
			const wordRangeBeforePos = (doc.getWordRangeAtPosition(pos) || new Range(pos, pos)).with({ end: pos });
			const newSuggestion = this._convertCompletionItem(resolvedItem, pos, wordRangeBeforePos);
			if (newSuggestion) {
				mixin(suggestion, newSuggestion, true);
			}

			return suggestion;
		});
	}

	private _convertCompletionItem(item: vscode.CompletionItem, position: vscode.Position, defaultRange: vscode.Range): modes.ISuggestion {
		if (typeof item.label !== 'string' || item.label.length === 0) {
			console.warn('INVALID text edit -> must have at least a label');
			return undefined;
		}

		const result: modes.ISuggestion = {
			//
			label: item.label,
			type: TypeConverters.CompletionItemKind.from(item.kind),
			detail: item.detail,
			documentation: item.documentation,
			filterText: item.filterText,
			sortText: item.sortText,
			//
			insertText: undefined,
			additionalTextEdits: item.additionalTextEdits && item.additionalTextEdits.map(TypeConverters.TextEdit.from),
			command: this._commands.toInternal(item.command),
			commitCharacters: item.commitCharacters
		};

		// 'insertText'-logic
		if (item.textEdit) {
			result.insertText = item.textEdit.newText;
			result.snippetType = 'internal';

		} else if (typeof item.insertText === 'string') {
			result.insertText = item.insertText;
			result.snippetType = 'internal';

		} else if (item.insertText instanceof SnippetString) {
			result.insertText = item.insertText.value;
			result.snippetType = 'textmate';

		} else {
			result.insertText = item.label;
			result.snippetType = 'internal';
		}

		// 'overwrite[Before|After]'-logic
		let range: vscode.Range;
		if (item.textEdit) {
			range = item.textEdit.range;
		} else if (item.range) {
			range = item.range;
		} else {
			range = defaultRange;
		}
		result.overwriteBefore = position.character - range.start.character;
		result.overwriteAfter = range.end.character - position.character;

		if (!range.isSingleLine || range.start.line !== position.line) {
			console.warn('INVALID text edit -> must be single line and on the same line');
			return undefined;
		}

		return result;
	}
}

class SignatureHelpAdapter {

	private _documents: ExtHostDocuments;
	private _provider: vscode.SignatureHelpProvider;

	constructor(documents: ExtHostDocuments, provider: vscode.SignatureHelpProvider) {
		this._documents = documents;
		this._provider = provider;
	}

	provideSignatureHelp(resource: URI, position: IPosition): TPromise<modes.SignatureHelp> {

		const doc = this._documents.getDocumentData(resource).document;
		const pos = TypeConverters.toPosition(position);

		return asWinJsPromise(token => this._provider.provideSignatureHelp(doc, pos, token)).then(value => {
			if (value) {
				return TypeConverters.SignatureHelp.from(value);
			}
			return undefined;
		});
	}
}

class LinkProviderAdapter {

	private _documents: ExtHostDocuments;
	private _heapService: ExtHostHeapService;
	private _provider: vscode.DocumentLinkProvider;

	constructor(documents: ExtHostDocuments, heapService: ExtHostHeapService, provider: vscode.DocumentLinkProvider) {
		this._documents = documents;
		this._heapService = heapService;
		this._provider = provider;
	}

	provideLinks(resource: URI): TPromise<modes.ILink[]> {
		const doc = this._documents.getDocumentData(resource).document;

		return asWinJsPromise(token => this._provider.provideDocumentLinks(doc, token)).then(links => {
			if (!Array.isArray(links)) {
				return undefined;
			}
			const result: modes.ILink[] = [];
			for (const link of links) {
				let data = TypeConverters.DocumentLink.from(link);
				let id = this._heapService.keep(link);
				ObjectIdentifier.mixin(data, id);
				result.push(data);
			}
			return result;
		});
	}

	resolveLink(link: modes.ILink): TPromise<modes.ILink> {
		if (typeof this._provider.resolveDocumentLink !== 'function') {
			return undefined;
		}

		const id = ObjectIdentifier.of(link);
		const item = this._heapService.get<vscode.DocumentLink>(id);
		if (!item) {
			return undefined;
		}

		return asWinJsPromise(token => this._provider.resolveDocumentLink(item, token)).then(value => {
			if (value) {
				return TypeConverters.DocumentLink.from(value);
			}
			return undefined;
		});
	}
}

class ColorProviderAdapter {

	private static _colorFormatHandlePool: number = 0;

	constructor(
		private _proxy: MainThreadLanguageFeaturesShape,
		private _documents: ExtHostDocuments,
		private _colorFormatCache: Map<string, number>,
		private _provider: vscode.DocumentColorProvider
	) { }

	provideColors(resource: URI): TPromise<IRawColorInfo[]> {
		const doc = this._documents.getDocumentData(resource).document;
		return asWinJsPromise(token => this._provider.provideDocumentColors(doc, token)).then(colors => {
			if (!Array.isArray(colors)) {
				return [];
			}

			const newRawColorFormats: IRawColorFormatMap = [];
			const getFormatId = (format: string) => {
				let id = this._colorFormatCache.get(format);

				if (typeof id !== 'number') {
					id = ColorProviderAdapter._colorFormatHandlePool++;
					this._colorFormatCache.set(format, id);
					newRawColorFormats.push([id, format]);
				}

				return id;
			};

			const colorInfos: IRawColorInfo[] = colors.map(ci => {
				const availableFormats = ci.availableFormats.map(format => {
					if (typeof format === 'string') {
						return getFormatId(format);
					} else {
						return [getFormatId(format.opaque), getFormatId(format.transparent)] as [number, number];
					}
				});

				return {
					color: [ci.color.red, ci.color.green, ci.color.blue, ci.color.alpha] as [number, number, number, number],
					availableFormats: availableFormats,
					range: TypeConverters.fromRange(ci.range)
				};
			});

			this._proxy.$registerColorFormats(newRawColorFormats);
			return colorInfos;
		});
	}
}

type Adapter = OutlineAdapter | CodeLensAdapter | DefinitionAdapter | HoverAdapter
	| DocumentHighlightAdapter | ReferenceAdapter | QuickFixAdapter | DocumentFormattingAdapter
	| RangeFormattingAdapter | OnTypeFormattingAdapter | NavigateTypeAdapter | RenameAdapter
	| SuggestAdapter | SignatureHelpAdapter | LinkProviderAdapter | ImplementationAdapter | TypeDefinitionAdapter | ColorProviderAdapter;

export class ExtHostLanguageFeatures implements ExtHostLanguageFeaturesShape {

	private static _handlePool: number = 0;

	private _proxy: MainThreadLanguageFeaturesShape;
	private _telemetry: MainThreadTelemetryShape;
	private _documents: ExtHostDocuments;
	private _commands: ExtHostCommands;
	private _heapService: ExtHostHeapService;
	private _diagnostics: ExtHostDiagnostics;
	private _adapter = new Map<number, Adapter>();
	private _colorFormatCache = new Map<string, number>();

	constructor(
		mainContext: IMainContext,
		documents: ExtHostDocuments,
		commands: ExtHostCommands,
		heapMonitor: ExtHostHeapService,
		diagnostics: ExtHostDiagnostics
	) {
		this._proxy = mainContext.get(MainContext.MainThreadLanguageFeatures);
		this._telemetry = mainContext.get(MainContext.MainThreadTelemetry);
		this._documents = documents;
		this._commands = commands;
		this._heapService = heapMonitor;
		this._diagnostics = diagnostics;
	}

	private _createDisposable(handle: number): Disposable {
		return new Disposable(() => {
			this._adapter.delete(handle);
			this._proxy.$unregister(handle);
		});
	}

	private _nextHandle(): number {
		return ExtHostLanguageFeatures._handlePool++;
	}

	private _withAdapter<A, R>(handle: number, ctor: { new(...args: any[]): A }, callback: (adapter: A) => TPromise<R>): TPromise<R> {
		let adapter = this._adapter.get(handle);
		if (!(adapter instanceof ctor)) {
			return TPromise.wrapError<R>(new Error('no adapter found'));
		}
		return callback(<any>adapter);
	}

	// --- outline

	registerDocumentSymbolProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentSymbolProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new OutlineAdapter(this._documents, provider));
		this._proxy.$registerOutlineSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentSymbols(handle: number, resource: URI): TPromise<modes.SymbolInformation[]> {
		return this._withAdapter(handle, OutlineAdapter, adapter => adapter.provideDocumentSymbols(resource));
	}

	// --- code lens

	registerCodeLensProvider(selector: vscode.DocumentSelector, provider: vscode.CodeLensProvider): vscode.Disposable {
		const handle = this._nextHandle();
		const eventHandle = typeof provider.onDidChangeCodeLenses === 'function' ? this._nextHandle() : undefined;

		this._adapter.set(handle, new CodeLensAdapter(this._documents, this._commands.converter, this._heapService, provider));
		this._proxy.$registerCodeLensSupport(handle, selector, eventHandle);
		let result = this._createDisposable(handle);

		if (eventHandle !== undefined) {
			const subscription = provider.onDidChangeCodeLenses(_ => this._proxy.$emitCodeLensEvent(eventHandle));
			result = Disposable.from(result, subscription);
		}

		return result;
	}

	$provideCodeLenses(handle: number, resource: URI): TPromise<modes.ICodeLensSymbol[]> {
		return this._withAdapter(handle, CodeLensAdapter, adapter => adapter.provideCodeLenses(resource));
	}

	$resolveCodeLens(handle: number, resource: URI, symbol: modes.ICodeLensSymbol): TPromise<modes.ICodeLensSymbol> {
		return this._withAdapter(handle, CodeLensAdapter, adapter => adapter.resolveCodeLens(resource, symbol));
	}

	// --- declaration

	registerDefinitionProvider(selector: vscode.DocumentSelector, provider: vscode.DefinitionProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new DefinitionAdapter(this._documents, provider));
		this._proxy.$registerDeclaractionSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDefinition(handle: number, resource: URI, position: IPosition): TPromise<modes.Definition> {
		return this._withAdapter(handle, DefinitionAdapter, adapter => adapter.provideDefinition(resource, position));
	}

	registerImplementationProvider(selector: vscode.DocumentSelector, provider: vscode.ImplementationProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new ImplementationAdapter(this._documents, provider));
		this._proxy.$registerImplementationSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideImplementation(handle: number, resource: URI, position: IPosition): TPromise<modes.Definition> {
		return this._withAdapter(handle, ImplementationAdapter, adapter => adapter.provideImplementation(resource, position));
	}

	registerTypeDefinitionProvider(selector: vscode.DocumentSelector, provider: vscode.TypeDefinitionProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new TypeDefinitionAdapter(this._documents, provider));
		this._proxy.$registerTypeDefinitionSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideTypeDefinition(handle: number, resource: URI, position: IPosition): TPromise<modes.Definition> {
		return this._withAdapter(handle, TypeDefinitionAdapter, adapter => adapter.provideTypeDefinition(resource, position));
	}

	// --- extra info

	registerHoverProvider(selector: vscode.DocumentSelector, provider: vscode.HoverProvider, extensionId?: string): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new HoverAdapter(this._documents, provider, once((name: string, data: any) => {
			data['extension'] = extensionId;
			this._telemetry.$publicLog(name, data);
		})));
		this._proxy.$registerHoverProvider(handle, selector);
		return this._createDisposable(handle);
	}

	$provideHover(handle: number, resource: URI, position: IPosition): TPromise<modes.Hover> {
		return this._withAdapter(handle, HoverAdapter, adpater => adpater.provideHover(resource, position));
	}

	// --- occurrences

	registerDocumentHighlightProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentHighlightProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new DocumentHighlightAdapter(this._documents, provider));
		this._proxy.$registerDocumentHighlightProvider(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentHighlights(handle: number, resource: URI, position: IPosition): TPromise<modes.DocumentHighlight[]> {
		return this._withAdapter(handle, DocumentHighlightAdapter, adapter => adapter.provideDocumentHighlights(resource, position));
	}

	// --- references

	registerReferenceProvider(selector: vscode.DocumentSelector, provider: vscode.ReferenceProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new ReferenceAdapter(this._documents, provider));
		this._proxy.$registerReferenceSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideReferences(handle: number, progressHandle: number, resource: URI, position: IPosition, context: modes.ReferenceContext): TPromise<modes.Location[]> {
		const progress = (locations: modes.Location[]) => {
			this._proxy.$notifyProvideReferencesProgress(handle, progressHandle, locations);
		};
		return this._withAdapter(handle, ReferenceAdapter, adapter => adapter.provideReferences(resource, position, context, progress));
	}

	// --- quick fix

	registerCodeActionProvider(selector: vscode.DocumentSelector, provider: vscode.CodeActionProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new QuickFixAdapter(this._documents, this._commands.converter, this._diagnostics, provider));
		this._proxy.$registerQuickFixSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideCodeActions(handle: number, resource: URI, range: IRange): TPromise<modes.Command[]> {
		return this._withAdapter(handle, QuickFixAdapter, adapter => adapter.provideCodeActions(resource, range));
	}

	// --- formatting

	registerDocumentFormattingEditProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentFormattingEditProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new DocumentFormattingAdapter(this._documents, provider));
		this._proxy.$registerDocumentFormattingSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentFormattingEdits(handle: number, resource: URI, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {
		return this._withAdapter(handle, DocumentFormattingAdapter, adapter => adapter.provideDocumentFormattingEdits(resource, options));
	}

	registerDocumentRangeFormattingEditProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentRangeFormattingEditProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new RangeFormattingAdapter(this._documents, provider));
		this._proxy.$registerRangeFormattingSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentRangeFormattingEdits(handle: number, resource: URI, range: IRange, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {
		return this._withAdapter(handle, RangeFormattingAdapter, adapter => adapter.provideDocumentRangeFormattingEdits(resource, range, options));
	}

	registerOnTypeFormattingEditProvider(selector: vscode.DocumentSelector, provider: vscode.OnTypeFormattingEditProvider, triggerCharacters: string[]): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new OnTypeFormattingAdapter(this._documents, provider));
		this._proxy.$registerOnTypeFormattingSupport(handle, selector, triggerCharacters);
		return this._createDisposable(handle);
	}

	$provideOnTypeFormattingEdits(handle: number, resource: URI, position: IPosition, ch: string, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]> {
		return this._withAdapter(handle, OnTypeFormattingAdapter, adapter => adapter.provideOnTypeFormattingEdits(resource, position, ch, options));
	}

	// --- navigate types

	registerWorkspaceSymbolProvider(provider: vscode.WorkspaceSymbolProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new NavigateTypeAdapter(provider, this._heapService));
		this._proxy.$registerNavigateTypeSupport(handle);
		return this._createDisposable(handle);
	}

	$provideWorkspaceSymbols(handle: number, search: string): TPromise<modes.SymbolInformation[]> {
		return this._withAdapter(handle, NavigateTypeAdapter, adapter => adapter.provideWorkspaceSymbols(search));
	}

	$resolveWorkspaceSymbol(handle: number, symbol: modes.SymbolInformation): TPromise<modes.SymbolInformation> {
		return this._withAdapter(handle, NavigateTypeAdapter, adapter => adapter.resolveWorkspaceSymbol(symbol));
	}

	// --- rename

	registerRenameProvider(selector: vscode.DocumentSelector, provider: vscode.RenameProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new RenameAdapter(this._documents, provider));
		this._proxy.$registerRenameSupport(handle, selector);
		return this._createDisposable(handle);
	}

	$provideRenameEdits(handle: number, resource: URI, position: IPosition, newName: string): TPromise<modes.WorkspaceEdit> {
		return this._withAdapter(handle, RenameAdapter, adapter => adapter.provideRenameEdits(resource, position, newName));
	}

	// --- suggestion

	registerCompletionItemProvider(selector: vscode.DocumentSelector, provider: vscode.CompletionItemProvider, triggerCharacters: string[]): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new SuggestAdapter(this._documents, this._commands.converter, this._heapService, provider));
		this._proxy.$registerSuggestSupport(handle, selector, triggerCharacters);
		return this._createDisposable(handle);
	}

	$provideCompletionItems(handle: number, resource: URI, position: IPosition): TPromise<modes.ISuggestResult> {
		return this._withAdapter(handle, SuggestAdapter, adapter => adapter.provideCompletionItems(resource, position));
	}

	$resolveCompletionItem(handle: number, resource: URI, position: IPosition, suggestion: modes.ISuggestion): TPromise<modes.ISuggestion> {
		return this._withAdapter(handle, SuggestAdapter, adapter => adapter.resolveCompletionItem(resource, position, suggestion));
	}

	// --- parameter hints

	registerSignatureHelpProvider(selector: vscode.DocumentSelector, provider: vscode.SignatureHelpProvider, triggerCharacters: string[]): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new SignatureHelpAdapter(this._documents, provider));
		this._proxy.$registerSignatureHelpProvider(handle, selector, triggerCharacters);
		return this._createDisposable(handle);
	}

	$provideSignatureHelp(handle: number, resource: URI, position: IPosition): TPromise<modes.SignatureHelp> {
		return this._withAdapter(handle, SignatureHelpAdapter, adapter => adapter.provideSignatureHelp(resource, position));
	}

	// --- links

	registerDocumentLinkProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentLinkProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new LinkProviderAdapter(this._documents, this._heapService, provider));
		this._proxy.$registerDocumentLinkProvider(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentLinks(handle: number, resource: URI): TPromise<modes.ILink[]> {
		return this._withAdapter(handle, LinkProviderAdapter, adapter => adapter.provideLinks(resource));
	}

	$resolveDocumentLink(handle: number, link: modes.ILink): TPromise<modes.ILink> {
		return this._withAdapter(handle, LinkProviderAdapter, adapter => adapter.resolveLink(link));
	}

	registerColorProvider(selector: vscode.DocumentSelector, provider: vscode.DocumentColorProvider): vscode.Disposable {
		const handle = this._nextHandle();
		this._adapter.set(handle, new ColorProviderAdapter(this._proxy, this._documents, this._colorFormatCache, provider));
		this._proxy.$registerDocumentColorProvider(handle, selector);
		return this._createDisposable(handle);
	}

	$provideDocumentColors(handle: number, resource: URI): TPromise<IRawColorInfo[]> {
		return this._withAdapter(handle, ColorProviderAdapter, adapter => adapter.provideColors(resource));
	}

	// --- configuration

	setLanguageConfiguration(languageId: string, configuration: vscode.LanguageConfiguration): vscode.Disposable {
		let { wordPattern } = configuration;

		// check for a valid word pattern
		if (wordPattern && regExpLeadsToEndlessLoop(wordPattern)) {
			throw new Error(`Invalid language configuration: wordPattern '${wordPattern}' is not allowed to match the empty string.`);
		}

		// word definition
		if (wordPattern) {
			this._documents.setWordDefinitionFor(languageId, wordPattern);
		} else {
			this._documents.setWordDefinitionFor(languageId, null);
		}

		const handle = this._nextHandle();
		this._proxy.$setLanguageConfiguration(handle, languageId, configuration);
		return this._createDisposable(handle);
	}
}
