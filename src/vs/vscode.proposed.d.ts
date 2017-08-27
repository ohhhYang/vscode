/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This is the place for API experiments and proposal.

declare module 'vscode' {

	export interface OpenDialogOptions {
		uri?: Uri;
		openFiles?: boolean;
		openFolders?: boolean;
		openMany?: boolean;
	}

	export namespace window {

		export function showOpenDialog(options: OpenDialogOptions): Thenable<Uri[]>;
	}

	export interface ResolveFileOptions {
		resolveTo?: Uri[];
		resolveSingleChildDescendants?: boolean;

		/**
		 * Return all descendants in a flat array in the FileStat's children property.
		 */
		resolveAllDescendants?: boolean;
	}

	export interface FileStat {
		resource: Uri;
		name: string;
		mtime?: number;
		etag?: string;
		isDirectory: boolean;
		hasChildren: boolean;
		children?: FileStat[];
		size?: number;
	}

	// todo@joh discover files etc
	export interface FileSystemProvider {
		// todo@joh -> added, deleted, renamed, changed
		onDidChange: Event<Uri>;

		/**
		 * Resolves a resource and returns stat info, or null if the resource doesn't
		 * exist.
		 */
		resolveFile(resource: Uri, options?: ResolveFileOptions): Thenable<FileStat | null>;

		resolveContents(resource: Uri): string | Thenable<string>;
		writeContents(resource: Uri, contents: string): void | Thenable<void>;

		// -- search
		// todo@joh - extract into its own provider?
		findFiles(query: string, progress: Progress<Uri>, token?: CancellationToken): Thenable<void>;
	}

	/**
	 * Provides a method to resolve resources for a particular scheme (e.g. 'git+https').
	 */
	export interface ResourceResolutionProvider {
		/**
		 * Resolves a (possibly abstract) resource URI to a concrete resource URI (typically file:).
		 *
		 * For example, a resource resolution provider might be registered that resolves URIs with scheme 'git'.
		 * The user could then open a URI such as git://example.com/my/repo.git. The provider decides how to
		 * resolve this URI. One possible provider implementation could clone that repository to a temporary
		 * directory and return the directory's file URI, to allow the user to open and edit a repository's
		 * files without needing to manually clone it.
		 */
		resolveResource(resource: Uri): Thenable<Uri>;
	}

	/**
	 * A folder from the folder catalog service, typically representing a repository on
	 * a remote code host.
	 */
	export interface CatalogFolder {
		/**
		 * The unique identifier for this folder.
		 *
		 * For folders on the local file system, this is the folder's file: URI.
		 *
		 * For repositories on a remote code host, this should be a URI that is a child
		 * of the registered provider's root URI. For example, a GitHub folder catalog
		 * provider's root URI might be github://github.com and a repository's resource URI
		 * would then be of the form github://github.com/repository/M6A8DY3daz8q4f==
		 * (where the last path component is the repository's ID obtained from GitHub's GraphQL
		 * API). It is better to use unique, stable IDs (such as in that example) than names,
		 * which change when repositories are renamed.
		 */
		resource: Uri;

		/**
		 * The path of the folder (typically excluding common ancestor directories), for display
		 * purposes only. For example, a GitHub repository at https://github.com/foo/bar might
		 * have path "foo/bar".
		 */
		displayPath?: string;

		/**
		 * The name of the folder (typically the last component of its path), for display purposes
		 * only.
		 */
		displayName?: string;

		/**
		 * The URL to an icon image for this folder.
		 */
		iconUrl?: string;

		/**
		 * The class of icon to use for this folder, used when the visual representation
		 * of the folder is likely too small to display the icon image from iconUrl.
		 */
		genericIconClass?: 'repo' | 'lock' | 'repo-forked' | 'mirror' | 'circle-slash' | 'file-directory' | 'file-submodule' | 'file-symlink-directory';

		/**
		 * The primary clone URL of this folder's repository.
		 */
		cloneUrl?: Uri;

		/**
		 * The user-provided description of the folder (e.g., the
		 * repository description).
		 */
		description?: string;

		/**
		 * Whether this folder represents a repository that is private,
		 * as defined by the repository's host.
		 */
		isPrivate?: boolean;

		/**
		 * Whether this folder represents a repository that is a fork
		 * of some other repository, as reported by the repository's host.
		 */
		isFork?: boolean;

		/**
		 * Whether this folder represents a repository that is a mirror
		 * of some other repository, as reported by the repository's host.
		 */
		isMirror?: boolean;

		/**
		 * The number of users who have starred this folder's repository.
		 */
		starsCount?: number;

		/**
		 * The number of forks of this folder's repository that exist.
		 */
		forksCount?: number;

		/**
		 * The number of users watching this folder's repository.
		 */
		watchersCount?: number;

		/**
		 * The primary programming language of the code in this folder.
		 */
		primaryLanguage?: string;

		/**
		 * The date when this folder's repository was created.
		 */
		createdAt?: Date;

		/**
		 * The date when this folder's repository was last updated.
		 */
		updatedAt?: Date;

		/**
		 * The date when this folder's repository was last pushed to.
		 */
		pushedAt?: Date;

		/**
		 * Whether the viewer has starred this folder.
		 */
		viewerHasStarred?: boolean;

		/**
		 * Whether the viewer has admin permissions on this folder.
		 */
		viewerCanAdminister?: boolean;

		/**
		 * The approximate number of bytes that this folder takes up on disk.
		 */
		approximateByteSize?: number;
	}

	/**
	 * Provides a method to search for folders (typically repositories).
	 */
	export interface FolderCatalogProvider {
		/**
		 * Gets information about the folder (typically a repository) with the given URI.
		 */
		resolveFolder(resource: Uri): Thenable<CatalogFolder>;

		/**
		 * Searches for folders, typically repositories on a remote code host.
		 */
		search(query: string, token: CancellationToken): Thenable<CatalogFolder[]>;
	}

	export namespace workspace {
		/**
		 * Finds the preferred parent folder for the resource. Unlike getRoot, it may
		 * return a URI that is not a currently open folder in the current workspace.
		 *
		 * If the resource is inside an existing workspace folder, it returns that
		 * root. Otherwise it uses heuristics to find the preferred parent. If none of
		 * these yield a result, it returns undefined.
		 *
		 * @param uri A uri.
		 * @return A folder uri or `undefined`
		 */
		export function findContainingFolder(resource: Uri): Uri | undefined;

		export function registerFileSystemProvider(authority: string, provider: FileSystemProvider): Disposable;

		/**
		 * Registers a IResourceResolutionProvider for the given scheme (e.g. 'git+ssh').
		 */
		export function registerResourceResolutionProvider(scheme: string, provider: ResourceResolutionProvider): Disposable;

		/**
		 * Registers a folder catalog provider to search and manage folders (typically repositories on
		 * a remote code host).
		 *
		 * All folders underneath the given root resource are associated with the provider. See
		 * CatalogFolder#resource for more information.
		 */
		export function registerFolderCatalogProvider(root: Uri, provider: FolderCatalogProvider): Disposable;
	}

	export namespace window {

		export function sampleFunction(): Thenable<any>;
	}

	/**
	 * The contiguous set of modified lines in a diff.
	 */
	export interface LineChange {
		readonly originalStartLineNumber: number;
		readonly originalEndLineNumber: number;
		readonly modifiedStartLineNumber: number;
		readonly modifiedEndLineNumber: number;
	}

	export namespace commands {

		/**
		 * Registers a diff information command that can be invoked via a keyboard shortcut,
		 * a menu item, an action, or directly.
		 *
		 * Diff information commands are different from ordinary [commands](#commands.registerCommand) as
		 * they only execute when there is an active diff editor when the command is called, and the diff
		 * information has been computed. Also, the command handler of an editor command has access to
		 * the diff information.
		 *
		 * @param command A unique identifier for the command.
		 * @param callback A command handler function with access to the [diff information](#LineChange).
		 * @param thisArg The `this` context used when invoking the handler function.
		 * @return Disposable which unregisters this command on disposal.
		 */
		export function registerDiffInformationCommand(command: string, callback: (diff: LineChange[], ...args: any[]) => any, thisArg?: any): Disposable;
	}

	/**
	 * PATCH(sourcegraph): See ISCMRevision for canonical documentation for this type.
	 */
	export interface SCMRevision {
		readonly specifier?: string;
		readonly rawSpecifier?: string;
		readonly id?: string;
	}

	/**
	 * Options for the command to execute.
	 */
	export interface CommandOptions {
		stdin?: string;
	}

	export interface CommandExecutor {
		executeCommand(args: string[], options?: CommandOptions): Thenable<string>;
	}

	export interface SourceControl {
		/**
		 * The root (top-level) folder of the source control repository.
		 */
		readonly rootFolder?: Uri;

		/**
		 * The current SCM revision of the source control. Can be undefined if the source
		 * control has not yet determined its revision or does not implement revision
		 * determination. The extension should update this property's value whenever it
		 * detects the revision has changed.
		 */
		revision?: SCMRevision;

		/**
		 * Optional set revision command.
		 *
		 * This command will be invoked to set the revision of the source control. An
		 * argument of type SCMRevision (specifying the revision to set) is appended to
		 * the Command's arguments array.
		 *
		 * If there is no argument, the source control should present the user with a menu
		 * to select a revision.
		 */
		setRevisionCommand?: Command;

		commandExecutor?: CommandExecutor;
	}

	/**
	 * Options specified when creating a source control.
	 */
	export interface SourceControlOptions {
		/**
		 * A human-readable string for the source control. Eg: `Git`.
		 */
		label: string;

		/**
		 * The root (top-level) folder of the source control repository.
		 */
		rootFolder?: Uri;
	}

	export namespace scm {

		/**
		 * Creates a new [source control](#SourceControl) instance.
		 *
		 * @param id A unique `id` for the source control. Something short, eg: `git`.
		 * @param options Options for creating the source control.
		 * @return An instance of [source control](#SourceControl).
		 */
		export function createSourceControl(id: string, options: SourceControlOptions): SourceControl;

		/**
		 * Returns the source control for the given resource (by traversing up the directory
		 * hierarchy until the first folder is found that is associated with an source
		 * control). Can be undefined if the resource is not in any known source control.
		 */
		export function getSourceControlForResource(resource: Uri): SourceControl | undefined;
	}

	/**
	 * Represents a color in RGBA space.
	 */
	export class Color {

		/**
		 * The red component of this color in the range [0-1].
		 */
		readonly red: number;

		/**
		 * The green component of this color in the range [0-1].
		 */
		readonly green: number;

		/**
		 * The blue component of this color in the range [0-1].
		 */
		readonly blue: number;

		/**
		 * The alpha component of this color in the range [0-1].
		 */
		readonly alpha: number;

		constructor(red: number, green: number, blue: number, alpha: number);

		/**
		 * Creates a color from the HSLA space.
		 *
		 * @param hue The hue component in the range [0-1].
		 * @param saturation The saturation component in the range [0-1].
		 * @param luminance The luminance component in the range [0-1].
		 * @param alpha The alpha component in the range [0-1].
		 */
		static fromHSLA(hue: number, saturation: number, luminance: number, alpha: number): Color;

		/**
		 * Creates a color by from a hex string. Supported formats are: #RRGGBB, #RRGGBBAA, #RGB, #RGBA.
		 * <code>null</code> is returned if the string does not match one of the supported formats.
		 * @param hex a string to parse
		 */
		static fromHex(hex: string): Color | null;
	}

	/**
	 * A color format is either a single format or a combination of two
	 * formats: an opaque one and a transparent one. The format itself
	 * is a string representation of how the color can be formatted. It
	 * supports the use of placeholders, similar to how snippets work.
	 * Each placeholder, surrounded by curly braces `{}`, requires a
	 * variable name and can optionally specify a number format and range
	 * for that variable's value.
	 *
	 * Supported variables:
	 *  - `red`
	 *  - `green`
	 *  - `blue`
	 *  - `hue`
	 *  - `saturation`
	 *  - `luminance`
	 *  - `alpha`
	 *
	 * Supported number formats:
	 *  - `f`, float with 2 decimal points. This is the default format. Default range is `[0-1]`.
	 *  - `Xf`, float with `X` decimal points. Default range is `[0-1]`.
	 *  - `d`, decimal. Default range is `[0-255]`.
	 *  - `x`, `X`, hexadecimal. Default range is `[00-FF]`.
	 *
	 * The default number format is float. The default number range is `[0-1]`.
	 *
	 * As an example, take the color `Color(1, 0.5, 0, 1)`. Here's how
	 * different formats would format it:
	 *
	 *  - CSS RGB
	 *   - Format: `rgb({red:d[0-255]}, {green:d[0-255]}, {blue:d[0-255]})`
	 *   - Output: `rgb(255, 127, 0)`
	 *
	 *  - CSS RGBA
	 *   - Format: `rgba({red:d[0-255]}, {green:d[0-255]}, {blue:d[0-255]}, {alpha})`
	 *   - Output: `rgba(255, 127, 0, 1)`
	 *
	 *  - CSS Hexadecimal
	 *   - Format: `#{red:X}{green:X}{blue:X}`
	 *   - Output: `#FF7F00`
	 *
	 *  - CSS HSLA
	 *   - Format: `hsla({hue:d[0-360]}, {saturation:d[0-100]}%, {luminance:d[0-100]}%, {alpha})`
	 *   - Output: `hsla(30, 100%, 50%, 1)`
	 */
	export type ColorFormat = string | { opaque: string, transparent: string };

	/**
	 * Represents a color range from a document.
	 */
	export class ColorRange {

		/**
		 * The range in the document where this color appers.
		 */
		range: Range;

		/**
		 * The actual color value for this color range.
		 */
		color: Color;

		/**
		 * The other formats this color range supports the color to be formatted in.
		 */
		availableFormats: ColorFormat[];

		/**
		 * Creates a new color range.
		 *
		 * @param range The range the color appears in. Must not be empty.
		 * @param color The value of the color.
		 * @param format The format in which this color is currently formatted.
		 */
		constructor(range: Range, color: Color, availableFormats: ColorFormat[]);
	}

	/**
	 * The document color provider defines the contract between extensions and feature of
	 * picking and modifying colors in the editor.
	 */
	export interface DocumentColorProvider {
		/**
		 * Provide colors for the given document.
		 *
		 * @param document The document in which the command was invoked.
		 * @param token A cancellation token.
		 * @return An array of [color ranges](#ColorRange) or a thenable that resolves to such. The lack of a result
		 * can be signaled by returning `undefined`, `null`, or an empty array.
		 */
		provideDocumentColors(document: TextDocument, token: CancellationToken): ProviderResult<ColorRange[]>;
	}

	export namespace languages {
		export function registerColorProvider(selector: DocumentSelector, provider: DocumentColorProvider): Disposable;
	}

	export namespace debug {
		/**
		 * Register a [debug configuration provider](#DebugConfigurationProvider) for a specifc debug type.
		 * More than one provider can be registered for the same type.
		 *
		 * @param type The debug type for which the provider is registered.
		 * @param provider The [debug configuration provider](#DebugConfigurationProvider) to register.
		 * @return A [disposable](#Disposable) that unregisters this provider when being disposed.
		 */
		export function registerDebugConfigurationProvider(debugType: string, provider: DebugConfigurationProvider): Disposable;
	}

	/**
	 * A debug configuration provider allows to add the initial debug configurations to a newly created launch.json
	 * and allows to resolve a launch configuration before it is used to start a new debug session.
	 * A debug configuration provider is registered via #workspace.registerDebugConfigurationProvider.
	 */
	export interface DebugConfigurationProvider {
		/**
		 * Provides initial [debug configuration](#DebugConfiguration). If more than one debug configuration provider is
		 * registered for the same type, debug configurations are concatenated in arbitrary order.
		 *
		 * @param folder The workspace folder for which the configurations are used or undefined for a folderless setup.
		 * @param token A cancellation token.
		 * @return An array of [debug configurations](#DebugConfiguration).
		 */
		provideDebugConfigurations?(folder: WorkspaceFolder | undefined, token?: CancellationToken): ProviderResult<DebugConfiguration[]>;

		/**
		 * Resolves a [debug configuration](#DebugConfiguration) by filling in missing values or by adding/changing/removing attributes.
		 * If more than one debug configuration provider is registered for the same type, the resolveDebugConfiguration calls are chained
		 * in arbitrary order and the initial debug configuration is piped through the chain.
		 *
		 * @param folder The workspace folder from which the configuration originates from or undefined for a folderless setup.
		 * @param debugConfiguration The [debug configuration](#DebugConfiguration) to resolve.
		 * @param token A cancellation token.
		 * @return The resolved debug configuration.
		 */
		resolveDebugConfiguration?(folder: WorkspaceFolder | undefined, debugConfiguration: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration>;
	}
}
