/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import { TernarySearchTree } from 'vs/base/common/map';
import { flatten } from 'vs/base/common/arrays';
import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IFolderCatalogProvider, ICatalogFolder, IFolderCatalogService } from 'vs/platform/folders/common/folderCatalog';

type ProviderRegistration = {
	root: URI;
	provider: IFolderCatalogProvider;
};

export class FolderCatalogService implements IFolderCatalogService {

	_serviceBrand: any;

	/**
	 * All registered providers.
	 */
	private providers: ProviderRegistration[] = [];

	/**
	 * Maps from a URI to the provider that registered for that URI.
	 */
	private providersMap: TernarySearchTree<IFolderCatalogProvider>;

	constructor() {
		this.updateProvidersMap();
	}

	public registerFolderCatalogProvider(root: URI, provider: IFolderCatalogProvider): IDisposable {
		const reg: ProviderRegistration = { root, provider };
		this.providers.push(reg);
		this.updateProvidersMap();

		return toDisposable(() => {
			const index = this.providers.indexOf(reg);
			if (index === -1) {
				return; // already disposed
			}

			this.providers.splice(index, 1);
			this.updateProvidersMap();
		});
	}

	public resolveFolder(resource: URI): TPromise<ICatalogFolder> {
		const provider = this.getProviderForResource(resource);
		if (!provider) {
			return TPromise.wrapError(new Error(`no folder catalog provider registered for resource: ${resource.toString()}`));
		}
		return provider.resolveFolder(resource);
	}

	public resolveLocalFolderResources(path: string): TPromise<URI[]> {
		// Return the first provider to resolve a non-null ICatalogFolder.
		return TPromise.join(this.providers.map(({ root, provider }) => {
			return provider.resolveLocalFolderResource(path).then(resource => {
				const resources: URI[] = [];
				if (resource) {
					resources.push(resource);
				}
				resources.forEach(resource => {
					// Ensure resource is underneath the provider's root (to detect defective providers).
					if (this.getProviderForResource(resource) !== provider) {
						throw new Error(`folder catalog provider resolved local folder resource ${resource.toString()} that is not underneath the provider's root ${root.toString()}`);
					}
				});
				return resources;
			});
		})).then(urisUnflattened => {
			return flatten(urisUnflattened);
		});
	}

	public search(query: string): TPromise<ICatalogFolder[]> {
		return TPromise.join(
			this.providers.map(({ root, provider }) =>
				provider.search(query).then(folders => {
					// Ensure all folders are underneath the provider's root (to detect defective providers).
					for (const folder of folders) {
						if (this.getProviderForResource(folder.resource) !== provider) {
							throw new Error(`folder catalog provider returned search result ${folder.resource.toString()} that is not underneath the provider's root ${root.toString()}`);
						}
					}

					return folders;
				})
			)
		).then(flatten);
	}

	private getProviderForResource(resource: URI): IFolderCatalogProvider {
		return this.providersMap.findSubstr(resource.toString());
	}

	private updateProvidersMap(): void {
		this.providersMap = TernarySearchTree.forPaths<IFolderCatalogProvider>();
		for (const { root, provider } of this.providers) {
			this.providersMap.set(root.toString(), provider);
		}
	}
}
