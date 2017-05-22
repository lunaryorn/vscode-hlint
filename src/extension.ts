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

import { execFile } from "child_process";
import { existsSync } from "fs";
import {
    Diagnostic, DiagnosticCollection, DiagnosticSeverity,
    TextDocument, Range, WorkspaceEdit, Command,
    CodeActionProvider, CodeActionContext, CancellationToken,
    ExtensionContext
} from "vscode";
import * as vscode from "vscode";

/**
 * An hlint severity.
 */
type HlintSeverity = "Ignore" | "Suggestion" | "Warning" | "Error";

/**
 * Constant denoting diagnostics from hlint.
 */
const HLINT_SOURCE = "hlint";

/**
 * Commands this extension provides
 */
const commands = {
    APPLY_REFACTORINGS: "hlint.applyRefactorings",
};

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
    readonly hint: string;
    /** The path to the file the message appeared in. */
    readonly file: string;
    /** The line the message started. */
    readonly startLine: number;
    /** The column the message started. */
    readonly startColumn: number;
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
const toDiagnosticSeverity =
    (hlintSeverity: HlintSeverity): DiagnosticSeverity => {
        switch (hlintSeverity) {
            case "Suggestion":
                return DiagnosticSeverity.Hint;
            case "Warning":
                return DiagnosticSeverity.Warning;
            case "Error":
                return DiagnosticSeverity.Error;
            default:
                return DiagnosticSeverity.Information;
        }
    };

/**
 * Convert an hlint message to a VSCode diagnostic.
 *
 * @param hlintMessage An hlint message from hlint's JSON output
 * @return The corresponding diagnostic
 */
const toDiagnostic = (hlintMessage: IHlintMessage): Diagnostic => {
    const range = new Range(
        hlintMessage.startLine - 1,
        hlintMessage.startColumn - 1,
        hlintMessage.endLine - 1,
        hlintMessage.endColumn - 1);
    const message = hlintMessage.to ?
        `${hlintMessage.hint}. Replace with ${hlintMessage.to}` :
        hlintMessage.hint;
    const severity = toDiagnosticSeverity(hlintMessage.severity);
    const diagnostic = new Diagnostic(range, message, severity);
    diagnostic.source = HLINT_SOURCE;
    // Cheat and track the refactoring information as "code" to get hold of it
    // later
    diagnostic.code = hlintMessage.refactorings;
    return diagnostic;
};

/**
 * Run hlint on the given file and return all messages.
 *
 * @param fileName The name of the file to run hlint on
 */
const runHlint = (fileName: string): Promise<IHlintMessage[]> =>
    new Promise<IHlintMessage[]>((resolve, reject) => {
        const cwd = vscode.workspace.rootPath || process.cwd();
        // Do not return a non-zero exit code when hints apply, so that
        // "execFile" does not fail
        execFile(
            "hlint", ["--no-exit-code", "--json", fileName],
            { cwd }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(
                        `Failed to run hlint: ${error.message}`));
                } else if (stderr.length > 0) {
                    reject(new Error(`hslint failed: ${stderr}`));
                } else {
                    resolve(JSON.parse(stdout));
                }
            });
    });

/**
 * Lint a single text document.
 *
 * @param diagnostics The diagnostic collection to add the results of linting to
 * @param document The text document to lint
 */
const lintDocument =
    (diagnostics: DiagnosticCollection) =>
        async (document: TextDocument): Promise<void> => {
            if (document.isDirty || (!existsSync(document.fileName))) {
                // Bail out if the document isn't saved or doesn't exist no disk
                return;
            }
            try {
                const messages = await runHlint(document.fileName);
                diagnostics.set(document.uri,
                    messages
                        .filter((message) => message.file === document.fileName)
                        .map(toDiagnostic));
            } catch (error) {
                diagnostics.delete(document.uri);
                vscode.window.showErrorMessage(error.message);
            }
        };

/**
 * Provide commands to apply hlint suggestions.
 */
class HlintRefactorings implements CodeActionProvider {
    public provideCodeActions(
        document: TextDocument,
        range: Range,
        context: CodeActionContext,
        token: CancellationToken): Command[] {
        // Create a code action for every diagnostic from hlint that provides a
        // refactoring
        return context.diagnostics
            .filter((d) => d.source === HLINT_SOURCE && d.code)
            .map((diagnostic) => {
                return {
                    arguments: [document, diagnostic.code],
                    command: commands.APPLY_REFACTORINGS,
                    title: `Fix: ${diagnostic.message}`,
                };
            });
    }
}

/**
 * Apply a refactoring on a given file.
 *
 * The file is refactoring in place.
 *
 * @param fileName The name of the file to refactor.
 * @param refactorings The refactorings to apply, as serialized string
 * @return The entire refactored code as string
 */
const runRefactor = (fileName: string, refactorings: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        const refactor = execFile("refactor", [fileName],
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(
                        `Failed to run refactor: ${error.message}`));
                } else {
                    resolve(stdout);
                }
            });
        // Feed refactoring description to refactor and close its standard input
        // afterwards
        refactor.stdin.write(`[("", ${refactorings})]`,
            () => refactor.stdin.end());
    });

/**
 * Apply refactorings, used as command callback for a code action command.
 *
 * Call the "refactor" tool to apply the refactoring, and replace the document
 * contents with the refactored code.
 *
 * @param diagnostics The diagnostics collection, required to lint the file
 *                    after applying diagnostics
 * @param document The text document that is being refactoring
 * @param refactoring The refactoring, as serialized structure for "refactor"
 * @return Whether the refactoring was applied or not
 */
const applyRefactorings =
    (diagnostics: DiagnosticCollection) =>
        async (
            document: TextDocument,
            refactorings: string): Promise<boolean> => {
            // Save the document and run "refactor" over it to apply the
            // suggestion.
            await document.save();
            try {
                // Hlint the document again after the refactoring was applied,
                // to update the diagnostics.
                const refactored = await runRefactor(
                    document.fileName, refactorings);
                // Create and apply a text edit that replaces the whole document
                // with the refactored code.
                const wholeDocument = document.validateRange(
                    new Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE));
                const edit = new WorkspaceEdit();
                edit.replace(document.uri, wholeDocument, refactored);
                return vscode.workspace.applyEdit(edit);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
                return false;
            }
        };

/**
 * Activate this extension.
 *
 * VSCode invokes this entry point whenever this extension is activated.
 *
 * @param context The context for this extension.
 */
export function activate(context: ExtensionContext) {
    // Create a diagnostic collection to highlight hlint messages, and register
    // it to make sure it's disposed when the extension is disabled.
    const diagnostics = vscode.languages.createDiagnosticCollection("hlint");
    context.subscriptions.push(diagnostics);

    // Register code actions to apply hlint suggestions, and a corresponding
    // command.
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        "haskell", new HlintRefactorings()));
    context.subscriptions.push(vscode.commands.registerCommand(
        commands.APPLY_REFACTORINGS, applyRefactorings(diagnostics)));

    // Start linting documents when they are saved or freshly opened
    vscode.workspace.onDidSaveTextDocument(
        lintDocument(diagnostics), null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(
        lintDocument(diagnostics), null, context.subscriptions);
    // Remove a document from the diagnostics collection when it's closed
    vscode.workspace.onDidCloseTextDocument((document) => {
        diagnostics.delete(document.uri);
    }, null, context.subscriptions);

    // Lint all open documents
    vscode.workspace.textDocuments.forEach(lintDocument(diagnostics));
}
