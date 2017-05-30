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
import * as fs from "fs";

import {
    Observable,
} from "rxjs/Rx";
import * as semver from "semver";
import * as tmp from "tmp";

import {
    CancellationToken,
    CodeActionContext,
    Command,
    Diagnostic,
    DiagnosticSeverity,
    Disposable,
    ExtensionContext,
    Range,
    TextDocument,
    WorkspaceEdit,
} from "vscode";
import * as vscode from "vscode";

/**
 * An HLint severity.
 */
type HLintSeverity = "Ignore" | "Suggestion" | "Warning" | "Error";

/**
 * Constant denoting diagnostics from HLint.
 */
const HLINT_SOURCE = "hlint";

/**
 * Commands this extension provides
 */
const commands = {
    APPLY_REFACTORINGS: "hlint.applyRefactorings",
};

/**
 * An HLint message, as it appears in HLint's JSON output.
 */
interface IHLintMessage {
    /** The module this message appeared in. */
    readonly module: string;
    /** The declaration the message appeared in. */
    readonly decl: string;
    /** The severity of this message. */
    readonly severity: HLintSeverity;
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
 * Convert an HLint message severity to the corresponding VSCode diagnostic
 * severity.
 *
 * @param hlintSeverity An HLint message severity as from HLint's JSON
 * @return The corresponding severity
 */
const toDiagnosticSeverity =
    (hlintSeverity: HLintSeverity): DiagnosticSeverity => {
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
const toDiagnostic = (hlintMessage: IHLintMessage): Diagnostic => {
    // VSCode has zero-based positions, whereas hlint outputs 1-based line and
    // column numbers.  Hence adjust accordingly.
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
 * Run a command in the current workspace.
 *
 * @param command The command to run.  The first element is the executable
 * @param stdin Optional text to write to standard input
 * @return The standard output of the command
 */
const runInWorkspace = (command: string[], stdin?: string): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
        const cwd = vscode.workspace.rootPath || process.cwd();
        const child = execFile(command[0], command.slice(1), { cwd },
            (error, stdout, stderr) => {
                if (error) {
                    // tslint:disable-next-line:max-line-length
                    const errorMessage =
                        `Failed to run ${command}: ${error.message} (stderr: ${stderr})`;
                    reject(new Error(errorMessage));
                } else {
                    resolve(stdout);
                }
            });
        if (stdin) {
            // Send standard input and close stdin stream to notify the child
            // process
            child.stdin.write(stdin, () => child.stdin.end());
        }
    });
};

/**
 * A temporary file.
 */
interface ITemporaryFile {
    /**
     * The path of the file.
     */
    readonly path: string;

    /**
     * Cleanup this temporary, i.e. delete it.
     */
    cleanup(): void;
}

/**
 * Create a temporary file with the given contents.
 *
 * @param contents The contents of the file.
 * @return The temporary file.
 */
const temporaryFile = (contents: string): Promise<ITemporaryFile> => {
    return new Promise<ITemporaryFile>((resolve, reject) => {
        tmp.file((err, path, fd, cleanup) => {
            if (err) {
                reject(err);
            } else {
                fs.createWriteStream("", { fd }).end(contents, () => {
                    resolve({ path, cleanup });
                });
            }
        });
    });
};

/**
 * Refactor a piece of code with "refactor".
 *
 * @param code The code to refactor.
 * @param refactorings A serialized description of the refactorings to apply
 * @return The refactored code, or null if no refactoring was performed.
 */
const refactor =
    async (code: string, refactorings: string): Promise<string | null> => {
        const refactFile = await temporaryFile(refactorings);
        try {
            const refactoredCode = await runInWorkspace(
                ["refactor", "--refact-file", refactFile.path], code);
            if (0 < refactoredCode.length) {
                // Trim the last character from the refactored code because
                // refactor seems to add an extra newline.
                return refactoredCode.slice(0, -1);
            } else {
                return null;
            }
        } finally {
            refactFile.cleanup();
        }
    };

/**
 * The maximum range, to refer to the whole document.
 */
const MAX_RANGE = new Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);

/**
 * Provide code actions to apply HLint suggestions.
 *
 * Create a code action for every HLint diagnostic in context that provides a
 * refactoring.
 *
 * @param document The document for which to provide actions
 * @param _range Ignored
 * @param context The context for which to provide actions
 * @param _token Ignored
 * @return A list of commands that apply code actions
 */
const provideHLintCodeActions = (
    document: TextDocument,
    _range: Range, context:
        CodeActionContext,
    _token: CancellationToken,
): Command[] =>
    context.diagnostics
        .filter((d) => d.source === HLINT_SOURCE && d.code)
        .map((diagnostic) => {
            return {
                arguments: [document, diagnostic.code],
                command: commands.APPLY_REFACTORINGS,
                title: `Fix: ${diagnostic.message}`,
            };
        });

/**
 * Apply refactorings, used as command callback for a code action command.
 *
 * Call the "refactor" tool to apply the refactoring, and replace the document
 * contents with the refactored code.
 *
 * @param document The text document that is being refactoring
 * @param refactoring The refactoring, as serialized structure for "refactor"
 * @return Whether the refactoring was applied or not
 */
const applyRefactorings =
    async (document: TextDocument, refactorings: string): Promise<boolean> => {
        try {
            const refactoredCode = await refactor(
                document.getText(), `[("", ${refactorings})]`);
            if (refactoredCode) {
                const edit = new WorkspaceEdit();
                // Replace the whole document with the new refactored code.
                edit.replace(document.uri,
                    document.validateRange(MAX_RANGE),
                    refactoredCode);
                return vscode.workspace.applyEdit(edit);
            } else {
                return false;
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to refactor hlint suggestions: ${err.message}`);
            throw err;
        }
    };

/**
 * An event that can be subscribed to.
 */
type Event<T> = (handler: (document: T) => void) => Disposable;

/**
 * Observe a vscode event.
 *
 * @param event The event to observe
 * @return An observable which pushes every event
 */
const observeEvent = <T>(event: Event<T>): Observable<T> =>
    Observable.fromEventPattern(
        (handler) => event((d) => handler(d)),
        (_: any, subscription: Disposable) => subscription.dispose(),
        (d) => d as T,
    );

/**
 * The result of an HLint run.
 */
interface IHLintResult {
    /**
     * The linted document.
     */
    readonly document: TextDocument;

    /**
     * Messages from HLint.
     */
    readonly messages: IHLintMessage[];
}

/**
 * Lint a document.
 *
 * @param document The document to lint
 * @return An observable with the result of linting
 */
const lintDocument = (document: TextDocument): Observable<IHLintResult> => {
    const cmd = ["hlint", "--no-exit-code", "--json", "-"];
    return Observable.fromPromise(runInWorkspace(cmd, document.getText()))
        .map((stdout) => ({ document, messages: JSON.parse(stdout) }));
};

/**
 * An HLint version error.
 */
class HLintVersionError extends Error {
    /**
     * Create a new version error.
     *
     * @param message The error message
     */
    constructor(message: string) {
        super(message);
        this.name = "HLintVersionError";
    }
}

/**
 * HLint version required for this extension.
 *
 * We require either 2.0.8 or newer as it adds back stdin support, or version
 * 1.9.25 (which fixes stdin support and refactor integration) or newer and less
 * than version 2 (as version 2 removes stdin support).
 */
const HLINT_VERSION_REQUIREMENT = ">=2.0.8 || <2 >=1.9.25";

/**
 * Get the HLint version.
 *
 * @return An observable that provides the version or fails if the version is
 *         missing or doesn't meet the requirements.
 */
const getHLintVersion = () => {
    return Observable.fromPromise(runInWorkspace(["hlint", "--version"]))
        .catch((error): Observable<string> => {
            // Wrap error if hlint failed to run.
            throw new HLintVersionError(`Failed to run HLint: ${error}`);
        })
        .map((stdout) => {
            const matches = stdout.match(/^HLint v([^,]+),/);
            if (matches && matches.length === 2) {
                return matches[1];
            } else {
                throw new HLintVersionError(
                    `Failed to parse HLint version from output: ${stdout}`);
            }
        })
        .map((version) => {
            if (semver.satisfies(version, HLINT_VERSION_REQUIREMENT)) {
                return version;
            } else {
                throw new HLintVersionError(
                    // tslint:disable-next-line:max-line-length
                    `HLint version ${version} did not meet requirements: \
${HLINT_VERSION_REQUIREMENT}! Please install the latest hlint version from Stackage or Hackage.`);
            }
        });
};

/**
 * Register providers and commands.
 *
 * @param context The extension context
 */
const registerProvidersAndCommands = (context: ExtensionContext): void => {
    // Register code actions to apply HLint suggestions, and a corresponding
    // command.
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        "haskell", { provideCodeActions: provideHLintCodeActions }));
    context.subscriptions.push(vscode.commands.registerCommand(
        commands.APPLY_REFACTORINGS, applyRefactorings));
};

/**
 * Start linting with HLint.
 *
 * @param context The extension context
 */
const startLinting = (context: ExtensionContext): void => {
    // Create a diagnostic collection to highlight HLint messages, and register
    // it to make sure it's disposed when the extension is disabled.
    const diagnostics = vscode.languages.createDiagnosticCollection("hlint");
    context.subscriptions.push(diagnostics);

    // Lint all currently open documents, plus every time a document was opened
    // or saved.  Only lint each document once in 200ms to avoid flooding the
    // system with too many hlint process.
    const linting = Observable.from(vscode.workspace.textDocuments)
        .merge(observeEvent(vscode.workspace.onDidOpenTextDocument))
        .merge(observeEvent(vscode.workspace.onDidSaveTextDocument))
        .merge(observeEvent(vscode.workspace.onDidChangeTextDocument)
            .map(({ document }) => document))
        .filter((document) => document.languageId === "haskell")
        .groupBy((document) => document.uri)
        .map((events) => events.throttleTime(200))
        .mergeAll()
        .map((document) => lintDocument(document)
            .catch((err) => {
                // If an error occurs while linting show the error message,
                // delete past diagnostics for the document and continue with an
                // empty promise.
                vscode.window.showErrorMessage(err.toString());
                diagnostics.delete(document.uri);
                return Observable.empty<IHLintResult>();
            }))
        .mergeAll()
        .subscribe(({ document, messages }) => {
            diagnostics.set(document.uri,
                messages.filter((m) => m.file === "-").map(toDiagnostic));
        });
    context.subscriptions.push({ dispose: linting.unsubscribe });

    // Remove diagnostics whenever a document is closed.
    const cleanup = observeEvent(vscode.workspace.onDidCloseTextDocument)
        .subscribe((document) => diagnostics.delete(document.uri));
    context.subscriptions.push({ dispose: cleanup.unsubscribe });
};

/**
 * Activate this extension.
 *
 * VSCode invokes this entry point whenever this extension is activated.
 *
 * @param context The context for this extension.
 */
export function activate(context: ExtensionContext): Promise<any> {
    return getHLintVersion()
        .do((version) => {
            console.log("lunaryorn.hlint: Found HLint version", version);
            registerProvidersAndCommands(context);
            startLinting(context);
        }).toPromise();
}
