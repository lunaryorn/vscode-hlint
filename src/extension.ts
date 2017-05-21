// Copyright (C) 2017  Sebastian Wiesner <swiesner@lunaryorn.com>
//
// This file is part of vscode-hlint.
//
// vscode-hlint is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// vscode-hlint is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with vscode-hlint.  If not, see <http://www.gnu.org/licenses/>.
//

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

type HlintSeverity = 'Ignore' | 'Suggestion' | 'Warning' | 'Error';

interface IHlintMessage {
    /** The module this message appeared in. */
    readonly module: string;
    /** The declaration the message appeared in. */
    readonly decl: string;
    /** The severity of this message. */
    readonly severity: HlintSeverity;
    /** The name of the hint that triggered this message. */
    readonly hint: string
    /** The path to the file the message appeared in. */
    readonly file: string;
    /** The line the message started. */
    readonly startLine: number;
    /** The column the message started. */
    readonly startColumn: number
    /** The line the message ended. */
    readonly endLine: number;
    /** The column the message ended. */
    readonly endColumn: number;
    /** The faulty Haskell expression that caused the message. */
    readonly from: string;
    /** The suggested replacement. */
    readonly to: string;
    /** Additional notes? */
    readonly note: string[];
    /** Internal representation of suggested refactoring? */
    readonly refactorings: string;
}

const toDiagnosticSeverity = (hlintSeverity: HlintSeverity): vscode.DiagnosticSeverity => {
    switch (hlintSeverity) {
        case 'Suggestion':
            return vscode.DiagnosticSeverity.Hint
        case 'Warning':
            return vscode.DiagnosticSeverity.Warning;
        case 'Error':
            return vscode.DiagnosticSeverity.Error;
        default:
            return vscode.DiagnosticSeverity.Information
    }
};

const toDiagnostic = (hlintMessage: IHlintMessage): vscode.Diagnostic => {
    const range = new vscode.Range(
        hlintMessage.startLine - 1,
        hlintMessage.startColumn - 1,
        hlintMessage.endLine - 1,
        hlintMessage.endColumn - 1);
    const message = hlintMessage.to ?
        `${hlintMessage.hint}. Replace with ${hlintMessage.to}` :
        hlintMessage.hint;
    const severity = toDiagnosticSeverity(hlintMessage.severity);
    return new vscode.Diagnostic(range, message, severity);
};


/**
 * Lint a single text document.
 *
 * @param document The text document to lint
 */
const lintDocument = (diagnosticsCollection: vscode.DiagnosticCollection) => (document: vscode.TextDocument): void => {
    if (document.isDirty || (!existsSync(document.fileName))) {
        // Bail out if the document isn't saved or doesn't exist no disk
        return;
    }
    const options = { cwd: vscode.workspace.rootPath || process.cwd() };
    execFile('hlint', ['--json', document.fileName], options, (error, stdout, stderr) => {
        if (error && (<any>error).errno) {
            // Check if an errno property exists on the error.  If so it's a
            // system error which we should tell the user about, otherwise it's
            // perhaps just the non-zero exit code of hlint when it found something
            vscode.window.showErrorMessage(`Failed to run hlint: ${error.message}`);
        } else if (stderr.length > 0) {
            vscode.window.showErrorMessage(`hslint failed: ${stderr}`);
        } else {
            const messages = JSON.parse(stdout) as IHlintMessage[];
            const diagnostics = messages
                .filter(msg => msg.file === document.fileName)
                .map(toDiagnostic);
            diagnosticsCollection.set(document.uri, diagnostics);
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    const diagnostics = vscode.languages.createDiagnosticCollection('hlint2');
    context.subscriptions.push(diagnostics);

    // Start linting documents when they are saved or freshly opened
    vscode.workspace.onDidSaveTextDocument(lintDocument(diagnostics), null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(lintDocument(diagnostics), null, context.subscriptions);
    // Remove a document from the diagnostics collection when it's closed
    vscode.workspace.onDidCloseTextDocument(document => {
        diagnostics.delete(document.uri);
    }, null, context.subscriptions);
}
