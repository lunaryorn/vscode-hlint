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

import * as semver from "semver";
import * as tmp from "tmp";

import {
    CancellationToken,
    CodeActionContext,
    CodeActionProvider,
    Command,
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
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
 * The context for HLint operations.
 */
interface IHLintContext {
    /**
     * The diagnostic collection for HLint hints.
     */
    readonly diagnostics: DiagnosticCollection;
}

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
        const child = execFile(command[0], command.slice(1),
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
                const sink = fs.createWriteStream("", { fd });
                sink.end(contents, () => {
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
                return refactoredCode;
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
 * Lint a single text document.
 *
 * @param hlint The context for HLint operations.
 * @param document The text document to lint
 */
const lintDocument =
    (hlint: IHLintContext) =>
        async (document: TextDocument): Promise<void> => {
            try {
                const output = await runInWorkspace(
                    ["hlint", "--no-exit-code", "--json", "-"],
                    document.getText(MAX_RANGE));
                const messages = JSON.parse(output) as IHLintMessage[];
                // Parse all messages and take only those that refer to the
                // stdin file, to make sure that we don't highlight errors from
                // other files in the linted document.
                const diagnostics = messages
                    .filter((message) => message.file === "-")
                    .map(toDiagnostic);
                hlint.diagnostics.set(document.uri, diagnostics);
            } catch (error) {
                hlint.diagnostics.delete(document.uri);
                vscode.window.showErrorMessage(error.message);
            }
        };

/**
 * Provide commands to apply HLint suggestions.
 */
class HLintRefactorings implements CodeActionProvider {
    public provideCodeActions(
        document: TextDocument,
        range: Range,
        context: CodeActionContext,
        token: CancellationToken): Command[] {
        // Create a code action for every diagnostic from HLint that provides a
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
 * Apply refactorings, used as command callback for a code action command.
 *
 * Call the "refactor" tool to apply the refactoring, and replace the document
 * contents with the refactored code.
 *
 * @param hlint The context for HLint operations
 * @param document The text document that is being refactoring
 * @param refactoring The refactoring, as serialized structure for "refactor"
 * @return Whether the refactoring was applied or not
 */
const applyRefactorings = (hlint: IHLintContext) =>
    async (document: TextDocument, refactorings: string): Promise<boolean> => {
        try {
        const refactoredCode = await refactor(
            document.getText(MAX_RANGE), `[("", ${refactorings})]`);
        if (refactoredCode) {
            const edit = new WorkspaceEdit();
                // Replace the whole document with the new refactored code.
                // Trim the last character from the refactored code because
                // refactor seems to add an extra newline.
            edit.replace(document.uri,
                document.validateRange(MAX_RANGE),
                refactoredCode.slice(0, -1));
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
 * HLint version required for this extension.
 *
 * We require either 2.0.8 or newer as it adds back stdin support, or version
 * 1.9.25 (which fixes stdin support and refactor integration) or newer and less
 * than version 2 (as version 2 removes stdin support).
 */
const HLINT_VERSION_REQUIREMENT = ">=2.0.8 || <2 >=1.9.25";

/**
 * An HLint version error.
 */
interface IHLintVersionError {
    /**
     * The human-readable error message.
     */
    readonly message: string;
}

/**
 * Check hlint version.
 *
 * @returns Either a version error or null if the version is fine.
 */
const checkHLintVersion = async (): Promise<IHLintVersionError | null> => {
    const stdout = await runInWorkspace(["hlint", "--version"]);
    const match = stdout.match(/^HLint v([^,]+),/);
    if (match && 2 <= match.length) {
        const hlintVersion = match[1];
        if (semver.satisfies(hlintVersion, HLINT_VERSION_REQUIREMENT)) {
            return null; // The version is fine.
        } else {
            return {
                // tslint:disable-next-line:max-line-length
                message: `HLint version ${hlintVersion} did not meet requirements: \
${HLINT_VERSION_REQUIREMENT}! Please install the latest hlint version from Stackage or Hackage.`,
            };
        }
    } else {
        return {
            message: `Failed to parse HLint version from output: ${stdout}`,
        };
    }
};

/**
 * Activate this extension.
 *
 * VSCode invokes this entry point whenever this extension is activated.
 *
 * @param context The context for this extension.
 */
export async function activate(context: ExtensionContext) {
    // Check our hlint version.
    const versionError = await checkHLintVersion();
    if (versionError) {
        vscode.window.showErrorMessage(versionError.message);
        return;
    }

    // Create a diagnostic collection to highlight HLint messages, and register
    // it to make sure it's disposed when the extension is disabled.
    const diagnostics = vscode.languages.createDiagnosticCollection("hlint");
    context.subscriptions.push(diagnostics);

    const hlint = { diagnostics };

    // Register code actions to apply HLint suggestions, and a corresponding
    // command.
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        "haskell", new HLintRefactorings()));
    context.subscriptions.push(vscode.commands.registerCommand(
        commands.APPLY_REFACTORINGS, applyRefactorings(hlint)));

    // Start linting documents when they are saved or freshly opened
    vscode.workspace.onDidSaveTextDocument(
        lintDocument(hlint), null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(
        lintDocument(hlint), null, context.subscriptions);
    // Remove a document from the diagnostics collection when it's closed
    vscode.workspace.onDidCloseTextDocument((document) => {
        diagnostics.delete(document.uri);
    }, null, context.subscriptions);

    // Lint all open documents
    vscode.workspace.textDocuments.forEach(lintDocument(hlint));
}
