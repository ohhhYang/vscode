/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sourcegraph. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// tslint:disable-next-line:import-patterns
import * as telligent from 'telligent-tracker';
// tslint:disable-next-line
import product from 'vs/platform/node/product';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ISourcegraphTelemetryProperties, INativeMetadata } from 'vs/platform/telemetry/node/sourcegraphTelemetryAppender';

const TELLIGENT_FUNCTION_NAME = 'telligent';
const APP_PLATFORM = 'NativeApp';
const ENV: string = 'production';

/**
 * TelligentWrapper should be instantiated in each process
 */
export class TelligentWrapper {
	private telligent: (...args: any[]) => void | null;

	constructor(
		@IEnvironmentService private environmentService: IEnvironmentService
	) {
		let appId: string;
		let env: string;
		// TODO(Dan): will we have a separate var for Sourcegraph dev vs prod env?
		if (this.environmentService.isBuilt && !this.environmentService.isExtensionDevelopment && !this.environmentService.args['disable-telemetry'] && !!product.enableTelemetry) {
			// TODO(Dan): update this once available
			appId = 'SourcegraphEditor'; //this.environmentService.sourcegraphContext.trackingAppID;
			env = ENV;
		}

		if (appId && env) {
			const win = window.top;
			// Create the initializing function
			win[TELLIGENT_FUNCTION_NAME] = function (): void {
				(win[TELLIGENT_FUNCTION_NAME].q = win[TELLIGENT_FUNCTION_NAME].q || []).push(arguments);
			};

			// Set up the initial queue, if it doesn't already exist
			win[TELLIGENT_FUNCTION_NAME].q = telligent.Telligent((win[TELLIGENT_FUNCTION_NAME].q || []), TELLIGENT_FUNCTION_NAME);

			this.telligent = win[TELLIGENT_FUNCTION_NAME];
			this.initialize(appId, env);
		}
	}

	isTelligentLoaded(): boolean {
		return Boolean(this.telligent);
	}

	setUserId(loginInfo: string): void {
		if (!this.telligent) {
			return;
		}
		this.telligent('setUserId', loginInfo);
	}

	addStaticMetadataObject(metadata: any): void {
		if (!this.telligent) {
			return;
		}
		this.telligent('addStaticMetadataObject', metadata);
	}

	private addStaticMetadata(property: string, value: string, command: string): void {
		if (!this.telligent) {
			return;
		}
		this.telligent('addStaticMetadata', property, value, command);
	}

	setUserProperty(property: string, value: any): void {
		this.addStaticMetadata(property, value, 'userInfo');
	}

	log(eventType: string, eventProps?: ISourcegraphTelemetryProperties): void {
		if (!this.telligent) {
			return;
		}

		// Separate out native/common metadata
		let nativeMetadata: INativeMetadata;
		if (eventProps && eventProps.native) {
			nativeMetadata = eventProps.native;
			delete eventProps.native;
		}

		// TODO(Dan): validate white list
		// // for an on-prem trial, we only want to collect high level usage information
		// // if we are keeping data onsite anyways, we can collect all info
		// if (this.environmentService.sourcegraphContext.onPrem && this.environmentService.sourcegraphContext.trackingAppID !== 'UmamiWeb') {
		// 	// if a user using teensy-Sourcegraph specifies no tracking ID, we won't log either.
		// 	if (!this.environmentService.sourcegraphContext.trackingAppID) {
		// 		return;
		// 	}
		// 	const limitedEventProps = {
		// 		event_action: eventProps.eventAction,
		// 		event_category: eventProps.eventCategory,
		// 		event_label: eventProps.eventLabel,
		// 		language: eventProps.language,
		// 		platform: eventProps.platform,
		// 		repo: eventProps.repo,
		// 		path_name: eventProps.path_name,
		// 		page_title: eventProps.page_title,
		// 	};
		// 	this.telligent('track', eventAction, limitedEventProps);
		// 	return;
		// }

		this.telligent('track', eventType, eventProps, { native: cleanPropertyNames(nativeMetadata) });
	}

	/**
	 * Initialize the telemetry library.
	 */
	private initialize(appId: string, env: string): void {
		if (!this.telligent) {
			return;
		}

		let url = 'sourcegraph.com/.api/telemetry';

		// TODO(Dan): Update this URL.
		// For clients with on-prem deployments, we use a bi-logger.
		if (this.environmentService.sourcegraphContext.onPrem && this.environmentService.sourcegraphContext.trackingAppID === 'UmamiWeb') {
			url = `${window.top.location.host}`.concat('/.bi-logger');
		}

		try {
			this.telligent('newTracker', 'sg', url, {
				appId: appId,
				platform: APP_PLATFORM,
				encodeBase64: false,
				env: env,
				forceSecureTracker: true,
				trackUrls: false
			});
		} catch (err) {
			this.telligent = null;
			if (this.environmentService.eventLogDebug) {
				console.warn(`Error encountered initializing telemetry: ${err}`);
			}
		}
	}

	dispose(): void {
		if (!this.telligent) {
			return;
		}
		this.telligent('flushBuffer');
		this.telligent = null;
	}
}

/**
 * Remove dots (".") from field names, as they are unsupported by some data warehouses. This is
 * related to fields generated in the commonProperties object.
 */
function cleanPropertyNames(props: any): any {
	let cleanProps = {};
	Object.keys(props).forEach(key => {
		cleanProps[key.replace(/\./g, '_')] = props[key];
	});
	return cleanProps;
}
