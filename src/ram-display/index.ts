import * as vscode from "vscode";
import { BitburnerServer } from "../bitburner-server";
import { normalizePath, parseUri } from "../fs/util";
import { IChildLogger } from "@vscode-logging/logger";

/**
 * Provides static RAM usage display for workspace script files.
 */
export class RamDisplayProvider implements Disposable, vscode.Disposable {
    public readonly logger;
    private readonly ramDisplay = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private readonly onActiveEditorChange: vscode.Disposable;
    private readonly codeLensProvider: RamDisplayCodeLensProvider;

    constructor(
        public readonly server: BitburnerServer,
    ) {
        this.logger = server.logger.getChildLogger({ label: "ram-display" });

        this.onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            this.logger.debug(`[ram-display] onDidChangeActiveTextEditor: ${editor?.document.uri.toString()}`);
            const uri = editor?.document.uri;
            if (!uri) {
                return this.ramDisplay.hide();
            } 

            const ram = await this.getRam(uri);

            if (!ram) {
                return this.ramDisplay.hide();
            }

            if (ram < 0) {
                this.ramDisplay.text = `Syntax error`;
            } else {
                this.ramDisplay.text = `${ram} GB`;
            }

            this.ramDisplay.show();
        });

        this.codeLensProvider = new RamDisplayCodeLensProvider(this);

    }

    private get config() {
        return this.server.config;
    }

    [Symbol.dispose]() {
        this.ramDisplay.dispose();
        this.onActiveEditorChange.dispose();
        this.codeLensProvider.dispose();
    }

    dispose() {
        this[Symbol.dispose]();
    }

    public async getRam(uri: vscode.Uri): Promise<number | null> {
        if (uri.scheme !== "bitburner") {
            this.logger.debug(`Attempting to map non-bitburner URI.`);
            const newUri = await this.mapFile(uri);
            if (!newUri) {
                return null;
            }

            uri = newUri;
        }

        const path = parseUri(uri);
        if (!path.filename) {
            return null;
        }

        return await this.server.calculateRam(path.filename, path.server)
            .catch(() => null);
    }

    /**
     * Get the content of a file on the server, or null if it fails.
     */
    public async getFileContent(filename: string, server = "home"): Promise<string | null> {
        try {
            return await this.server.getFileContent(filename, server);
        } catch (e) {
            return null;
        }
    }

    /**
     * Map a file in the workspace to a file on a server.
     */
    public async mapFile(uri: vscode.Uri): Promise<vscode.Uri | null> {
        if (uri.scheme === "bitburner") {
            return uri;
        }
        
        // for now, we only accept file schemes. This *should* also work for other schemes, but for the prototype this is good enough.
        if (uri.scheme !== "file") {
            return null;
        }

        // we only care about workspace files.
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return null;
        }

        let relativePath = normalizePath(uri.path.slice(workspaceFolder.uri.path.length + 1 + normalizePath(this.config.scriptFolder).length));

        const server = this.config.useServerFolders ? relativePath.split("/")[0] : "home";
        if (!server) {
            return null;
        }

        if (!/\.[a-zA-Z]+$/.test(relativePath)) {
            return null;
        }

        relativePath = replaceExtension(relativePath, ".js");

        return vscode.Uri.parse(`bitburner://${server}/${relativePath}`);
    }
}

function replaceExtension(filename: string, extension: string) {
    return filename.replace(/\.[a-zA-Z]+$/, extension);
}

function* windows<T, U>(iterable: Iterable<T>, windowSize: number): Iterable<U> {
    let window: T[] = [];
    for (const item of iterable) {
        window.push(item);
        if (window.length === windowSize) {
            yield window as U;
            window = [];
        }
    }
}

function* iterTokens(semanticTokens: vscode.SemanticTokens): Iterable<[number, number, number, number, number]> {
    let line = 0;
    let char = 0;

    for (const [deltaLine, deltaStartChar, length, type, modifiers] of windows<number, [number, number, number, number, number]>(semanticTokens.data, 5)) {
        line += deltaLine;
        char = (deltaLine === 0) ? char + deltaStartChar : deltaStartChar;
        yield [line, char, length, type, modifiers];
    }
}


class RamDisplayCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    public readonly logger: IChildLogger;

    readonly disposables: vscode.Disposable[] = [];

    constructor(
        ramDisplay: RamDisplayProvider
    ) {
        this.logger = ramDisplay.logger;


        this.disposables.push(vscode.languages.registerCodeLensProvider({ language: "typescript", scheme: "file" }, this));
        this.disposables.push(vscode.languages.registerCodeLensProvider({ language: "typescript", scheme: "bitburner" }, this));
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const hits = await this.getRamUsageHits(document);
        if (!hits) {
            return [];
        }

        return hits.map(hit => {
            const range = new vscode.Range(hit.line, hit.char, hit.line, hit.char + hit.length);
            return new vscode.CodeLens(range, {
                command: "noop",
                title: `${hit.cost} GB`
            });
        });
    }


    public async getRamUsageHits(document: vscode.TextDocument) {
        if (!(await vscode.languages.getLanguages()).includes("typescript")) {
            return;
        }

        const hits: { line: number, char: number, length: number, cost: number }[] = [];

        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", document.uri);
        const semanticTokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", document.uri);

        function getTokenName(line: number, char: number, length: number) {
            const token = document.lineAt(line).text.substring(char, char + length);
            return token;
        }

        for (const [line, startChar, length, tokenType, modifiers] of iterTokens(semanticTokens)) {
            if (legend.tokenTypes[tokenType] === "variable") {
                const variableName = getTokenName(line, startChar, length);
                if (variableName === "window" || variableName === "document") {
                    hits.push({ line: line, char: startChar, length, cost: 25 });
                }
            }

            else if (legend.tokenTypes[tokenType] === "method" || (legend.tokenTypes[tokenType] === "property" && modifiers === 0)) {
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, new vscode.Position(line, startChar), undefined);
                if (hovers && hovers.length > 0) {
                    const hoverText = hovers.map(hover => hover.contents).flat().map(c => typeof c === "string" ? c : c.value).join("");

                    const costText = hoverText.match(/(?<=RAM cost\: *)\d+(\.\d+)?(?= *GB)/);
                    if (!costText) {
                        continue;
                    }

                    const cost = parseFloat(costText[0]);
                    if (isNaN(cost) || cost === 0) {
                        continue;
                    }

                    hits.push({ line: line, char: startChar, length, cost });
                }
            }
        }

        this.logger.debug(`renderRamUsageHints: got ${hits.length} hits`);

        return hits;
    }
}