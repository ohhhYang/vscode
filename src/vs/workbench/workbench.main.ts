/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Base
import 'vs/base/common/strings';
import 'vs/base/common/errors';

// Configuration
import 'vs/workbench/services/configuration/common/configurationExtensionPoint';

// Editor
import 'vs/editor/editor.all';

// Menus/Actions
import 'vs/platform/actions/electron-browser/menusExtensionPoint';

// Views
import 'vs/workbench/api/browser/viewsExtensionPoint';

// Workbench
import 'vs/workbench/browser/actions/toggleNavbarVisibility';
import 'vs/workbench/browser/actions/toggleActivityBarVisibility';
import 'vs/workbench/browser/actions/toggleStatusbarVisibility';
import 'vs/workbench/browser/actions/toggleContextbarVisibility';
import 'vs/workbench/browser/actions/toggleSidebarVisibility';
import 'vs/workbench/browser/actions/toggleSidebarPosition';
import 'vs/workbench/browser/actions/toggleEditorLayout';
import 'vs/workbench/browser/actions/toggleZenMode';
import 'vs/workbench/parts/preferences/browser/preferences.contribution';
import 'vs/workbench/parts/preferences/browser/keybindingsEditorContribution';

import 'vs/workbench/browser/parts/quickopen/quickopen.contribution';
import 'vs/workbench/parts/quickopen/browser/quickopen.contribution';
import 'vs/workbench/browser/parts/editor/editorPicker';


import 'vs/workbench/parts/management/electron-browser/management.contribution'; // can be packaged separately
import 'vs/workbench/parts/management/electron-browser/managementViewlet';

import 'vs/workbench/browser/parts/navbar/navbar.contribution';

import 'vs/workbench/parts/files/browser/explorerViewlet';
import 'vs/workbench/parts/files/browser/fileActions.contribution';
import 'vs/workbench/parts/files/browser/files.contribution';

import 'vs/workbench/parts/folders/common/folders.contribution';

import 'vs/workbench/parts/backup/common/backup.contribution';

import 'vs/workbench/parts/codeComments/electron-browser/codeComments.contribution';

import 'vs/workbench/parts/search/browser/search.contribution';
import 'vs/workbench/parts/search/browser/searchViewlet'; // can be packaged separately
import 'vs/workbench/parts/search/browser/openAnythingHandler'; // can be packaged separately

import 'vs/workbench/parts/scm/electron-browser/scm.contribution';
import 'vs/workbench/parts/scm/electron-browser/scmViewlet'; // can be packaged separately

import 'vs/workbench/parts/invite/electron-browser/invite.contribution';

import 'vs/workbench/parts/review/electron-browser/review.contribution';

import 'vs/workbench/parts/debug/electron-browser/debug.contribution';
import 'vs/workbench/parts/debug/browser/debugQuickOpen';
import 'vs/workbench/parts/debug/electron-browser/repl';
import 'vs/workbench/parts/debug/browser/debugEditorActions';
import 'vs/workbench/parts/debug/browser/debugViewlet'; // can be packaged separately

import 'vs/workbench/parts/markers/markers.contribution';
import 'vs/workbench/parts/markers/browser/markersPanel'; // can be packaged separately

import 'vs/workbench/parts/html/browser/html.contribution';

import 'vs/workbench/parts/webbrowser/electron-browser/webbrowser.contribution';

import 'vs/workbench/parts/welcome/walkThrough/electron-browser/walkThrough.contribution';

import 'vs/workbench/parts/extensions/electron-browser/extensions.contribution';
import 'vs/workbench/parts/extensions/browser/extensionsQuickOpen';
import 'vs/workbench/parts/extensions/electron-browser/extensionsViewlet'; // can be packaged separately

import 'vs/workbench/parts/welcome/migrate/electron-browser/migrate.contribution';

import 'vs/workbench/parts/welcome/page/electron-browser/welcomePage.contribution';

import 'vs/workbench/parts/output/browser/output.contribution';
import 'vs/workbench/parts/output/browser/outputPanel'; // can be packaged separately

import 'vs/workbench/parts/terminal/electron-browser/terminal.contribution';
import 'vs/workbench/parts/terminal/browser/terminalQuickOpen';
import 'vs/workbench/parts/terminal/electron-browser/terminalPanel'; // can be packaged separately

import 'vs/workbench/electron-browser/workbench';
import 'vs/workbench/electron-browser/configureLocale';

import 'vs/workbench/parts/trust/electron-browser/unsupportedWorkspaceSettings.contribution';

import 'vs/workbench/parts/relauncher/electron-browser/relauncher.contribution';

import 'vs/workbench/parts/tasks/electron-browser/task.contribution';

import 'vs/workbench/parts/emmet/browser/emmet.browser.contribution';
import 'vs/workbench/parts/emmet/electron-browser/emmet.contribution';

// Code Editor enhacements
import 'vs/workbench/parts/codeEditor/codeEditor.contribution';

import 'vs/workbench/parts/execution/electron-browser/execution.contribution';

import 'vs/workbench/parts/snippets/electron-browser/snippets.contribution';
import 'vs/workbench/parts/snippets/electron-browser/snippetsService';
import 'vs/workbench/parts/snippets/electron-browser/insertSnippet';
import 'vs/workbench/parts/snippets/electron-browser/tabCompletion';

import 'vs/workbench/parts/themes/electron-browser/themes.contribution';

import 'vs/workbench/parts/feedback/electron-browser/feedback.contribution';

import 'vs/workbench/parts/welcome/gettingStarted/electron-browser/gettingStarted.contribution';

import 'vs/workbench/parts/update/electron-browser/update.contribution';

import 'vs/workbench/parts/surveys/electron-browser/nps.contribution';
import 'vs/workbench/parts/surveys/electron-browser/languageSurveys.contribution';

import 'vs/workbench/parts/performance/electron-browser/performance.contribution';

import 'vs/workbench/parts/cli/electron-browser/cli.contribution';

import 'vs/workbench/api/electron-browser/extensionHost.contribution';

import 'vs/workbench/electron-browser/main.contribution';
import 'vs/workbench/electron-browser/main';

import 'vs/workbench/parts/themes/test/electron-browser/themes.test.contribution';

import 'vs/workbench/parts/watermark/electron-browser/watermark';

import 'vs/workbench/parts/welcome/overlay/browser/welcomeOverlay';
import 'vs/workbench/parts/modal/modal.contribution';
import 'vs/platform/auth/electron-browser/auth.contribution';
