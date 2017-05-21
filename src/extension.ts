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

/**
 * An hlint severity.
 */
type HlintSeverity = 'Ignore' | 'Suggestion' | 'Warning' | 'Error';

/**
 * Constant denoting diagnostics from hlint.
 */
const HLINT_SOURCE = 'hlint';

/**
 * Commands this extension provides
 */
const commands = {
    APPLY_REFACTORINGS: 'hlint.applyRefactorings'
}

/**
 * An hlint message, as it appears in hlint's JSON output.
 */
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

/**
 * Convert an hlint message severity to the corresponding VSCode diagnostic
 * severity.
 *
 * @param hlintSeverity An hlint message severity as from hlint's JSON
 * @return The corresponding severity
 */
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

/**
 * Convert an hlint message to a VSCode diagnostic.
 *
 * @param hlintMessage An hlint message from hlint's JSON output
 * @return The corresponding diagnostic
 */
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
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = HLINT_SOURCE;
    // Cheat and track the refactoring information as "code" to get hold of it later
    diagnostic.code = hlintMessage.refactorings;
    return diagnostic;
};

/**
 * Lint a single text document.
 *
 * @param diagnostics The diagnostic collection to add the results of linting to
 * @param document The text document to lint
 */
const lintDocument = (diagnostics: vscode.DiagnosticCollection) => (document: vscode.TextDocument): Promise<void> => {
    if (document.isDirty || (!existsSync(document.fileName))) {
        // Bail out if the document isn't saved or doesn't exist no disk
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        const options = { cwd: vscode.workspace.rootPath || process.cwd() };
        execFile('hlint', ['--json', document.fileName], options, (error, stdout, stderr) => {
            if (error && (<any>error).errno) {
                // Check if an errno property exists on the error.  If so it's a
                // system error which we should tell the user about, otherwise it's
                // perhaps just the non-zero exit code of hlint when it found something
                vscode.window.showErrorMessage(`Failed to run hlint: ${error.message}`);
                reject(error);
            } else if (stderr.length > 0) {
                const errorMessage = `hslint failed: ${stderr}`;
                vscode.window.showErrorMessage(errorMessage);
                reject(errorMessage);
            } else {
                const messages = JSON.parse(stdout) as IHlintMessage[];
                diagnostics.set(
                    document.uri,
                    messages.filter(m => m.file === document.fileName).map(toDiagnostic))
                resolve();
            }
        })
    });
}

/**
 * Provide commands to apply hlint suggestions.
 */
class HlintRefactoring implements vscode.CodeActionProvider {
    public provideCodeActions(document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken): vscode.Command[] {
        // Create a code action for every diagnostic from hlint that provides a
        // refactoring
        return context.diagnostics
            .filter(d => d.source === HLINT_SOURCE && d.code)
            .map(diagnostic => {
                return {
                    command: commands.APPLY_REFACTORINGS,
                    title: 'Apply suggestion',
                    arguments: [document, diagnostic.code]
                }
            });
    }
}

/**
 * Apply refactorings, used as command callback for a code action command.
 *
 * Call the "refactor" tool to apply the refactoring.
 *
 * @param diagnostics The diagnostics collection, required to lint the file after applying diagnostics
 * @param document The text document that is being refactoring
 * @param refactoring The refactoring, as serialized structure for "refactor"
 */
const applyRefactorings = (diagnostics: vscode.DiagnosticCollection) =>
    (document: vscode.TextDocument, refactorings: string): Thenable<boolean> => {
        // Save the document and run "refactor" over it to apply the suggestion.
        return document.save().then(success => {
            return new Promise<boolean>((resolve, reject) => {
                const refactor = execFile('refactor', [document.fileName, '--inplace'],
                    (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                        } else {
                            // Hlint the document again after the refactoring
                            // was applied, to update the diagnostics.
                            lintDocument(diagnostics)(document).then(() => resolve(true));
                        }
                    });
                // Feed the refactor information to "refactor"; a unusual input
                // format hence this strange leading empty string.
                refactor.stdin.write(`[("", ${refactorings})]`, () => refactor.stdin.end());
            });
        });
    }

/**
 * Activate this extension.
 *
 * VSCode invokes this entry point whenever this extension is activated.
 *
 * @param context The context for this extension.
 */
export function activate(context: vscode.ExtensionContext) {
    // Create a diagnostic collection to highlight hlint messages, and register
    // it to make sure it's disposed when the extension is disabled.
    const diagnostics = vscode.languages.createDiagnosticCollection('hlint');
    context.subscriptions.push(diagnostics);

    // Register code actions to apply hlint suggestions, and a corresponding command.
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        'haskell', new HlintRefactoring));
    context.subscriptions.push(vscode.commands.registerCommand(
        commands.APPLY_REFACTORINGS, applyRefactorings(diagnostics)));

    // Start linting documents when they are saved or freshly opened
    vscode.workspace.onDidSaveTextDocument(lintDocument(diagnostics), null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(lintDocument(diagnostics), null, context.subscriptions);
    // Remove a document from the diagnostics collection when it's closed
    vscode.workspace.onDidCloseTextDocument(document => {
        diagnostics.delete(document.uri);
    }, null, context.subscriptions);

    // Lint all open documents
    vscode.workspace.textDocuments.forEach(lintDocument(diagnostics));
}
