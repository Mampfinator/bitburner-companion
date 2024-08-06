import * as vscode from "vscode";
import { BitburnerServer } from "../bitburner-server";
import { normalizePath, parseUri } from "../fs/util";
import { IChildLogger } from "@vscode-logging/logger";
import { BitburnerStatusBarItem } from "../status-bar";

/**
 * Provides static RAM usage display for workspace script files.
 */
export class RamDisplayProvider implements Disposable, vscode.Disposable {
    public readonly logger;
    private readonly onActiveEditorChange: vscode.Disposable;
    private readonly codeLensProvider: RamDisplayCodeLensProvider;

    constructor(
        public readonly server: BitburnerServer,
        public readonly statusBar: BitburnerStatusBarItem,
    ) {
        this.logger = server.logger.getChildLogger({ label: "ram-display" });

        this.onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            this.logger.debug(`onDidChangeActiveTextEditor: ${editor?.document.uri.toString()}`);
            const uri = editor?.document.uri;

            if (!uri) {
                return;
            }

            const ram = await this.getRam(uri);
            this.statusBar.setCurrentFileRam(ram);
        });

        this.codeLensProvider = new RamDisplayCodeLensProvider(this);

    }

    private get config() {
        return this.server.config;
    }

    [Symbol.dispose]() {
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

type Tuple<T, N extends number, R extends T[] = []> = R["length"] extends N ? R : Tuple<T, N, [T, ...R]>;

/**
 * Splits an iterable into tuples of length `sliceLength`.
 */
function* slices<T, N extends number>(iterable: Iterable<T>, sliceLength: N): Iterable<Tuple<T, N>> {
    let slice: T[] = [];
    for (const item of iterable) {
        slice.push(item);
        if (slice.length === sliceLength) {
            yield slice as Tuple<T, N>;
            slice = [];
        }
    }
}

function* iterTokens(semanticTokens: vscode.SemanticTokens): Iterable<Tuple<number, 5>> {
    let line = 0;
    let char = 0;

    for (const [deltaLine, deltaStartChar, length, type, modifiers] of slices(semanticTokens.data, 5)) {
        line += deltaLine;
        char = (deltaLine === 0) ? char + deltaStartChar : deltaStartChar;
        yield [line, char, length, type, modifiers];
    }
}

function* skip<T>(iterable: Iterable<T>, n: number): Iterable<T> {
    let i = 0;
    for (const item of iterable) {
        if (i++ >= n) {
            yield item;
        }
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
        const tokens = await this.getRamHintLocations(document);
        if (!tokens) {
            return [];
        }

        return tokens.map(hit => {
            const range = new vscode.Range(hit.line, hit.char, hit.line, hit.char + hit.length);
            return new vscode.CodeLens(range, {
                command: "noop",
                title: `RAM usage: ${hit.cost} GB`,
            });
        });
    }

    public async getRamHintLocations(document: vscode.TextDocument): Promise<{line: number, char: number, length: number, cost: number}[]> {
        // If we don't have TypeScript, we can't access hover/JSDoc information to parse the cost from.
        if (!(await vscode.languages.getLanguages()).includes("typescript")) {
            return [];
        }

        const logger = this.logger;

        const tokens: { line: number, char: number, length: number, cost: number }[] = [];

        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", document.uri);

        const M_DECLARATION = legend.tokenModifiers.indexOf("declaration")!;

        function isDeclaration(token: Tuple<number, 5> | number): boolean;
        function isDeclaration(modifier: number): boolean;
        function isDeclaration(tokenOrModifier: Tuple<number, 5> | number): boolean {
            const modifierBits = typeof tokenOrModifier === "number" ? tokenOrModifier : tokenOrModifier[4];
            return (modifierBits & (1 << M_DECLARATION)) !== 0;
        }

        const M_DEFAULT_LIBRARY = legend.tokenModifiers.indexOf("defaultLibrary")!;
        function isDefaultLibrary(token: Tuple<number, 5> | number): boolean {
            const modifierBits = typeof token === "number" ? token : token[4];
            return (modifierBits & (1 << M_DEFAULT_LIBRARY)) !== 0;
        }

        const T_VARIABLE = legend.tokenTypes.indexOf("variable")!;
        const T_PROPERTY = legend.tokenTypes.indexOf("property")!;
        const T_FUNCTION = legend.tokenTypes.indexOf("function")!;
        const T_METHOD = legend.tokenTypes.indexOf("method")!;


        const semanticTokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", document.uri);

        async function getTokenName([line, char, length]: Tuple<number, 3>, uri: vscode.Uri): Promise<string> {
            const document = await vscode.workspace.openTextDocument(uri);
            const token = document.lineAt(line).text.substring(char, char + length);
            return token;
        }

        async function getDefinitionTokens([line, char, length, type]: Tuple<number, 4>, uri: vscode.Uri): Promise<{ token: Tuple<number, 5>, uri: vscode.Uri}[]> {
            const locations: vscode.Location[] = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                "vscode.executeDefinitionProvider", 
                uri, 
                new vscode.Position(line, char),
            ).then(locations => locations.map(location => {
                return location instanceof vscode.Location ? location : new vscode.Location(location.targetUri, location.targetSelectionRange ?? location.targetRange);
            }));

            return Promise.all(
                locations.map(async location => {
                    return {
                        token: [
                            location.range.start.line,
                            location.range.start.character,
                            length,
                            // type should be the same as where we came frome
                            type,
                            // modifier bits beyond `M_DECLARATION` don't matter, and since this location is definitely a declaration,
                            // we don't need a semantic token lookup
                            1 << M_DECLARATION,
                        ], 
                        uri: location.uri
                    };
                })
            );
        }

        const costLookup = new Map<string, number | null>();

        async function getHoverCost([line, char,]: Tuple<number, 3>, uri: vscode.Uri): Promise<number | null> {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(line, char));
            
            if (!hovers || hovers.length === 0) {
                return null;
            }

            const hoverText = hovers.map(hover => hover.contents).flat().map(c => typeof c === "string" ? c : c.value).join("");

            const costText = hoverText.match(/(?<=RAM cost\: *)\d+(\.\d+)?(?= *GB)/);
            if (!costText || costText.length === 0) {
                return null;
            }

            const cost = parseFloat(costText[0]);
            if (isNaN(cost)) {
                return null;
            }

            return cost;
        }

        async function getFunctionBodyRange([line, char]: Tuple<number, 2>, uri: vscode.Uri): Promise<vscode.Range | null> {
            logger.debug(`getFunctionBody started: ${line}, ${char}`);
            
            const document = await vscode.workspace.openTextDocument(uri);

            let shouldMarkStart = false;
            let start: vscode.Position | null = null;

            let parenState = 0;

            let lineText: string = document.lineAt(line).text;

            while (parenState !== 0 || !start) {
                if (char >= lineText.length) {
                    try {
                        line++;
                        lineText = document.lineAt(line).text;
                        char = 0; // Reset char to 0 after moving to next line
                    } catch {
                        // We've reached the end of the document
                        return null;
                    }
                }
        
                const currentChar = lineText[char];
        
                if (currentChar === "{") {
                    parenState++;
                    shouldMarkStart = true;
                } else if (currentChar === "}") {
                    parenState--;
                } else {
                    if (!start && shouldMarkStart) {
                        start = new vscode.Position(line, char);
                    }
                }
        
                char++;
            }

            if (!start) {
                console.error("Could not find start of function body");
                return null;
            }

            return new vscode.Range(start, new vscode.Position(line, char));
        }

        async function getFunctionBodyCost([declarationLine, declarationChar, length]: Tuple<number, 3>, uri: vscode.Uri): Promise<number | null> {

            const searchRange = await getFunctionBodyRange([declarationLine, declarationChar], uri);
            
            if (!searchRange) {
                return null;
            }

            const tokenName = await getTokenName([declarationLine, declarationChar, length], uri);

            logger.debug(`getFunctionBodyCost: got search range for ${tokenName}@${uri.toString(false)}: (${searchRange.start.line}, ${searchRange.start.character}) - (${searchRange.end.line}, ${searchRange.end.character})`);

            const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentRangeSemanticTokens", uri, searchRange);
            if (!tokens) {
                return null;
            }

            costLookup.set(`${uri.toString(true)}:${declarationLine}:${declarationChar}`, null);

            // every token is only accounted for *once* for RAM calculation, no matter how many times it appears in a function.
            let costMap = new Map<string, number>();

            // skip function declaration, since we'd end in an infinite loop otherwise
            for (const token of iterTokens(tokens)) {
                if (token[0] === declarationLine && token[1] === declarationChar) {
                    continue;
                }

                const { id, cost } = await getTokenCost(token, uri);
                if (cost !== null && !costMap.has(id)) {
                    costMap.set(id, cost);
                }
            }

            const totalCost = [...costMap.values()].reduce((a, b) => a + b, 0);

            logger.debug(`getFunctionBodyCost: ${tokenName}@${uri.toString(false)}: ${totalCost}GB`);

            return totalCost;
        }

        /**
         * Recursively calculate the cost of a given token.
         */
        async function getTokenCost([line, char, length, type, modifier]: Tuple<number, 5>, uri = document.uri): Promise<{id: string, cost: number | null}> {
            const key = `${uri.toString(true)}:${line}:${char}`;

            if (costLookup.has(key)) {
                return { id: key, cost: costLookup.get(key) ?? null};
            }

            if (isDefaultLibrary(modifier) && (type === T_VARIABLE || type === T_PROPERTY)) {
                const name = await getTokenName([line, char, length], uri);
                // window and document (document as property of window as well)
                // are special cases that incur a 25 gig RAM cost
                if (name === "window" || name === "document") {
                    return { id: "window", cost: 25 };
                }

                return { id: key, cost: null };
            }

            if (type !== T_FUNCTION && type !== T_METHOD && type !== T_PROPERTY) {
                return { id: key, cost: null };
            }

            if (!isDeclaration(modifier)) {
                try {
                    const declarations = await getDefinitionTokens([line, char, length, type], uri);

                    for (const declaration of declarations) {
                        const cost = await getTokenCost(declaration.token, declaration.uri);
                        if (cost.cost !== null) {
                            return cost;
                        }
                    }

                    return { id: key, cost: null };
                } catch (e) {
                    console.error(e);
                    return { id: key, cost: null };
                }
            }

            // try getting cost from hover text first, as that's cheaper.
            const hoverCost = await getHoverCost([line, char, length], uri);
            if (hoverCost !== null) {
                costLookup.set(key, hoverCost);
                return { id: key, cost: hoverCost }; 
            }

            // find end of function body and calculate cost similarly
            const bodyCost = await getFunctionBodyCost([line, char, length], uri);
            if (bodyCost !== null) {
                costLookup.set(key, bodyCost);
                return { id: key, cost: bodyCost };
            }

            costLookup.set(key, null);
            return { id: key, cost: null };
        }

        for (const [line, startChar, length, tokenType, modifiers] of iterTokens(semanticTokens)) {
            try {
                const { cost } = await getTokenCost([line, startChar, length, tokenType, modifiers]);
                if (cost !== null && cost > 0) {
                    tokens.push({line, char: startChar, length, cost});
                }
            } catch (e) {
                console.error(e);
            }
        }

        this.logger.debug(`renderRamUsageHints: found ${tokens.length} tokens (${tokens.reduce((a, b) => a + b.cost, 0)} GB total)`);

        return tokens;
    }
}