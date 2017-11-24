//    Copyright 2017 Sebastian Wiesner <sebastian@swsnr.de>
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

import { execFile } from "child_process";
import * as fs from "fs";

import { Observable, Observer } from "rxjs/Rx";
import * as semver from "semver";
import * as tmp from "tmp";

import {
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
 * Wrap a command with "stack exec".
 *
 * @param cmd The command to wrap
 * @return cmd wrapped with stack exec
 */
const stackExec = (cmd: ReadonlyArray<string>): ReadonlyArray<string> =>
    ["stack", "exec", "--", ...cmd];

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
    readonly note: ReadonlyArray<string>;
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
 * @return An observable with standard output of the command
 */
const runInWorkspace =
    (command: ReadonlyArray<string>, stdin?: string): Observable<string> =>
        Observable.create((observer: Observer<string>): void => {
            const cwd = vscode.workspace.rootPath || process.cwd();
            const child = execFile(command[0], command.slice(1), { cwd },
                (error, stdout) => {
                    if (error) {
                        observer.error(error);
                    } else {
                        observer.next(stdout);
                        observer.complete();
                    }
                });
            if (stdin) {
                child.stdin.end(stdin);
            }
        });

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
    readonly cleanup: () => void;
}

/**
 * Create a temporary file with the given contents.
 *
 * @param contents The contents of the file.
 * @return An observable pushing the temporary file.
 */
const temporaryFile = (contents: string): Observable<ITemporaryFile> =>
    Observable.create((observer: Observer<ITemporaryFile>): void => {
        tmp.file((err, path, fd, cleanup) => {
            if (err) {
                observer.error(err);
            } else {
                fs.createWriteStream("", { fd }).end(contents, () => {
                    observer.next({ path, cleanup });
                    observer.complete();
                });
            }
        });
    });

/**
 * Refactor a piece of code with "refactor".
 *
 * @param code The code to refactor.
 * @param refactorings A serialized description of the refactorings to apply
 * @return An observable with the refactored code or null if no refactoring was
 *         performed.
 */
const refactor =
    (code: string, refactorings: string): Observable<string | null> =>
        temporaryFile(refactorings)
            .concatMap((refactFile) =>
                runInWorkspace(
                    stackExec(["refactor", "--refact-file", refactFile.path]),
                    code,
                ).finally(() => refactFile.cleanup()))
            .map((stdout) => {
                if (0 < stdout.length) {
                    // Trim the last character from the refactored code because
                    // refactor seems to add an extra newline.
                    return stdout.slice(0, -1);
                } else {
                    return null;
                }
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
    (document: TextDocument, refactorings: string): Promise<boolean> =>
        refactor(document.getText(), `[("", ${refactorings})]`)
            .catch((error): Observable<string | null> => {
                vscode.window.showErrorMessage(
                    `Failed to refactor hlint suggestions: ${error.message}`);
                throw error;
            })
            .filter((code) => !!code) // Ensure that code's defined
            .map((code) => {
                const edit = new WorkspaceEdit();
                // Replace the whole document with the new refactored code.
                edit.replace(document.uri,
                    document.validateRange(new Range(
                        0, 0, Number.MAX_VALUE, Number.MAX_VALUE)),
                    // Code's not null here, because we filtered accordingly
                    // above
                    code!);
                return edit;
            })
            .concatMap((edit) => Observable.fromPromise(
                vscode.workspace.applyEdit(edit)))
            .defaultIfEmpty(false)
            .toPromise();

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
    readonly messages: ReadonlyArray<IHLintMessage>;
}

/**
 * Lint a document.
 *
 * @param document The document to lint
 * @return An observable with the result of linting
 */
const lintDocument = (document: TextDocument): Observable<IHLintResult> => {
    return runInWorkspace(
        stackExec(["hlint", "--no-exit-code", "--json", "-"]),
        document.getText(),
    ).map((stdout) => ({ document, messages: JSON.parse(stdout) }));
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
 * Register providers and commands.
 *
 * @param context The extension context
 */
const registerRefactoringProvidersAndCommands =
    (context: ExtensionContext): void => {
        // Register code actions to apply HLint suggestions, and a corresponding
        // command.
        context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
            "haskell", {
                provideCodeActions(document, _, actionContext) {
                    return actionContext.diagnostics
                        .filter((d) => d.source === HLINT_SOURCE && d.code)
                        .map((diagnostic) => {
                            return {
                                arguments: [document, diagnostic.code],
                                command: commands.APPLY_REFACTORINGS,
                                title: `Fix: ${diagnostic.message}`,
                            };
                        });
                },
            }));
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
        .map((events) => events.debounceTime(200))
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
 * An error denoting a mismatched version.
 */
class VersionError extends Error {
    /**
     * Create a new version error.
     *
     * @param message The error message
     */
    constructor(message: string) {
        super(message);
        this.name = "VersionError";
    }
}

/**
 * Get the expected version of a program.
 *
 * Run the given command and try to parse the version number from standard
 * output, using the first match group of the provided regular expression
 * pattern.
 *
 * Then compare the version against the given semantic versioning range (in npm
 * syntax) and return an observable pushing the version if it meets the
 * requirements.
 *
 * If the regular expression didn't match or if the version didn't meet the
 * provided range, the observable fails with a VersionError.
 *
 * If the command failed to execute for whatever reason the observable fails
 * with a NodeJS system error.
 *
 * @param program The human-readable program name, for error messages
 * @param command The command to run to get the version
 * @param pattern A regular expression to extract the version from the output
 * @param range A semver version range specifying the expected version
 * @return An observable with the extracted version
 */
const getExpectedVersion = (
    program: string,
    command: ReadonlyArray<string>,
    pattern: RegExp,
    range: string,
): Observable<string> => runInWorkspace(command)
    .map((stdout) => {
        const matches = stdout.match(pattern);
        if (matches && matches.length === 2) {
            const version = matches[1];
            // Compare ranges loosely since we might not get a totally valid
            // semantic version from the program
            if (semver.satisfies(version, range, true)) {
                return version;
            } else {
                // tslint:disable-next-line:max-line-length
                throw new VersionError(`${program} version ${version} did not meet requirements ${range}`);
            }
        } else {
            throw new VersionError(
                `Failed to extract ${program} version from ${stdout}`);
        }
    });

/**
 * Version ranges required by this extension.
 *
 * We require either HLint 2.0.8 or newer as it adds back stdin support, or
 * version 1.9.25 (which fixes stdin support and refactor integration) or newer
 * and less than version 2 (as version 2 removes stdin support).
 */
const VERSION_RANGES = {
    applyRefact: ">= 0.3",
    hlint: ">=2.0.8 || <2 >=1.9.25",
};

/**
 * Activate this extension.
 *
 * VSCode invokes this entry point whenever this extension is activated.
 *
 * @param context The context for this extension.
 */
export function activate(context: ExtensionContext): Promise<any> {
    // Enable linting with HLint or fail if it's missing or doesn't meet our
    // requirements
    const enableLinting = getExpectedVersion(
        "HLint", stackExec(["hlint", "--version"]),
        /^HLint v([^,]+),/, VERSION_RANGES.hlint,
    ).do((version) => {
        console.info("lunaryorn.hlint: found HLint version", version,
            "starting to lint documents");
        startLinting(context);
    });
    // Enable refactoring actions with apply-refact.  If it's missing or doesn't
    // meet our requirements show a warning messages and do not register the
    // corresponding commands and code action providers, but do not fail.
    //
    // apply-refact has a four-component which is not a valid semantic version
    // (these have at most three components).  To work around this we explicitly
    // extract just the first three components of the refactor version number.
    const enableRefactoring = getExpectedVersion(
        "apply-refact", stackExec(["refactor", "--version"]),
        /^v(\d+\.\d+\.\d+)/, VERSION_RANGES.applyRefact,
    ).catch((error) => {
        if (error.name instanceof VersionError) {
            vscode.window.showWarningMessage(
                `HLint suggestions not available: ${error.message}`);
            return Observable.empty();
        } else if (error.code === "ENOENT") {
            vscode.window.showErrorMessage(
                `HLint suggestions not available: apply-refact missing, \
please install the latest release from Hackage or Stackage`);
            return Observable.empty();
        } else {
            throw error;
        }
    }).do((version) => {
        console.info("lunaryorn.hlint: found apply-refact version", version,
            "registering refactoring commands and providers");
        registerRefactoringProvidersAndCommands(context);
    });

    return Observable.concat(enableLinting, enableRefactoring).toPromise();
}
