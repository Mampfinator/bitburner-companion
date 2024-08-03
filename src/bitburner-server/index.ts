import { IVSCodeExtLogger } from "@vscode-logging/logger";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { FileData, Message, Server } from "./interfaces";
import { BitburnerError, BitburnerErrorCode } from "./errors";

export const DEFAULT_CONFIG: BitburnerConfig = {
    allowedFileTypes: [".js", ".script", ".txt", ".json"],
    allowDeletingFiles: true,
    port: 12525, 
    scriptsFolder: ".",
    definitionsFile: {
        update: true,
        path: "${workspaceFolder}/NetScriptDefinitions.d.ts",
    },
    pushAllOnConnection: true,
    messageTimeout: 10000,
};

export interface BitburnerConfig {
    allowedFileTypes: string[];
    allowDeletingFiles: boolean;
    port: number;
    scriptsFolder: string;
    definitionsFile: {update: boolean, path: string};
    pushAllOnConnection: boolean;
    messageTimeout?: number;
}

export class BitburnerServer implements Disposable {
    private wss!: WebSocketServer;

    /**
     * The game's active WebSocket connection.
     */
    private ws?: WebSocket;

    /**
     * JSON-RPC message counter
     */
    private messageCounter = 0;

    private messagePromises = new Map<number, {resolve: (response: any) => void, reject: (reason: any) => void}>();

    constructor(private config: BitburnerConfig, public readonly logger: IVSCodeExtLogger) {
        this.start();
    }

    public start() {
        this.wss = this.setupServer();
    }

    //#region Setup & Connection
    private connectionPromise?: 
        { promise: Promise<BitburnerServer>, resolve: (server: BitburnerServer) => void }; 
    public async awaitConnection(): Promise<BitburnerServer> {
        if (this.ws) {
            return this;
        }

        if (!this.connectionPromise) {
            this.connectionPromise = {} as any;
            this.connectionPromise!.promise = new Promise<BitburnerServer>(r => this.connectionPromise!.resolve = r);
        }

        return this.connectionPromise!.promise;
    }

    private onGameConnectedCb?: () => void;
    /**
     * Register a callback that will be called when a game connects.
     */
    public onGameConnected(cb: () => void) {
        this.onGameConnectedCb = cb;
    }

    private onGameDisconnectedCb?: () => void;
    /**
     * Register a callback that will be called when a game disconnects.
     */
    public onGameDisconnected(cb: () => void) {
        this.onGameDisconnectedCb = cb;
    }

    setupServer(): WebSocketServer {
        const wss = new WebSocketServer({port: this.config.port});

        wss.on("connection", (ws) => {
            // we're assuming one game instance at a time.
            this.ws = ws;
            this.setupClient(ws);
            this.connectionPromise?.resolve(this);
            this.onGameConnectedCb?.();
        });

        wss.on("close", () => {
            this.ws = undefined;
        });

        wss.on("error", (err) => {
            this.logger.error(`[server] ${err}`);
        });

        wss.on("listening", () => {
            this.logger.info(`[server] listening on port ${this.config.port}`);
        });

        return wss;
    }

    setupClient(ws: WebSocket) {
        ws.on("close", () => {
            this.ws = undefined;
            this.onGameDisconnectedCb?.();
        });
        
        ws.on("message", data => {
            this.logger.trace(`[server] received message: ${data}`);
            this.handleMessage(data);
        });
    }

    private handleMessage(data: RawData) {
        const message = JSON.parse(data.toString()) as Message;

        if (message.jsonrpc !== "2.0" || typeof message.id !== "number") {
            this.logger.warn(`[server] invalid message: ${data}`);
            return;
        }

        const promise = this.messagePromises.get(message.id);
        if (!promise) {
            this.logger.warn(`[server] unknown message: ${data}`);
            return;
        }

        if (message.error) {
            this.logger.error(`[server] error: ${message.error}`);
            let error = BitburnerError.fromErrorMessage(message.error);
            if (!error) {
                error = new BitburnerError(BitburnerErrorCode.Failed, message.error);
            }
            promise.reject(error);
        }

        if (message.result === null) {
            this.logger.error(`[server] invalid message: ${data}`);
            promise.reject(new BitburnerError(BitburnerErrorCode.Failed, "invalid response"));
            return;
        }

        promise.resolve(message.result);
        this.messagePromises.delete(message.id);
    }
    //#endregion

    public updateConfig(config: Partial<BitburnerConfig>) {
        const old = structuredClone(this.config) as typeof this.config;
        Object.assign(this.config, config);

        if (old.port !== this.config.port) {
            this.logger.info(`[server] changing port from ${old.port} to ${this.config.port}`);
            this.wss.close();
            this.wss = this.setupServer();
        }
    }

    [Symbol.dispose]() {
        this.ws?.close();
        this.wss.close();
    }
    
    // to comply with VSCode's own `Disposable` interface.
    public dispose() {
        return this[Symbol.dispose]();
    }
    
    //#region RPC Methods
    /**
     * Send a message to the game.
     * 
     * @returns A promise that resolves to the response for the sent message, or `null` if the game is not connected.
     */
    private send<T>(message: Omit<Message, "id" | "jsonrpc">): Promise<T | null> {
        if (!this.ws) {
            return Promise.resolve(null);
        }

        const fullMessage = { ...message, id: this.messageCounter++, jsonrpc: "2.0" };

        const promise = new Promise<T>((resolve, reject) => {
            this.messagePromises.set(fullMessage.id, { resolve, reject });
            
            setTimeout(() => {
                if (this.messagePromises.has(fullMessage.id)) {
                    this.messagePromises.delete(fullMessage.id);
                    reject(new BitburnerError(BitburnerErrorCode.ResponseTimeout, "response timeout"));   
                }
            }, this.config.messageTimeout!);

        });

        this.ws.send(JSON.stringify(fullMessage));

        return promise;
    }

    
    /**
     * Push a file to a server.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidFile> } If the file path is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.InvalidFileExtension> } If the `filename`'s extension isn't a script or text extension.
     */
    async pushFile(filename: string, content: string, server = "home"): Promise<boolean> {
        return this.send<"OK">({
            method: "pushFile",
            params: {
                filename,
                content,
                server
            }
        })
        .then(res => res === "OK");
    }

    /**
     * Get the content of a file.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidFile> } If the file path is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.FileNotFound> } If the file doesn't exist.
     */
    async getFileContent(filename: string, server = "home"): Promise<string | null> {
        return this.send<string>({
            method: "getFile",
            params: {
                filename,
                server
            }
        });
    }

    /**
     * Delete a file on an ingame server.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidFile> } If the file path is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.Failed> } If the file couldn't be deleted.
     */
    // TODO: Update the error code parser, cuz this can throw a *host* of errors, all different variants of "... file not found".
    async deleteFile(filename: string, server = "home"): Promise<boolean> {
        return this.send<"OK">({
            method: "deleteFile",
            params: {
                filename,
                server
            },
        })
        .then(res => res === "OK");
    }

    /**
     * Get the names of all files on a server.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     */
    async getFileNames(server = "home"): Promise<string[] | null> {
        return this.send<string[]>({
            method: "getFileNames",
            params: {
                server
            }
        }).catch(() => null);
    }


    /**
     * Get the `NetScriptDefinitions.d.ts` file for the game.
     */
    async getDefinitionFile(): Promise<string | null> {
        // this shouldn't ever throw.
        return this.send<string>({
            method: "getDefinitionFile",
        });
    }

    /**
     * Get the files and their content of an ingame server.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     */
    async getFiles(server = "home"): Promise<FileData[] | null> {
        return this.send<FileData[]>({
            method: "getFiles",
            params: {
                server
            }
        }).catch(() => null);
    }

    /**
     * Get the static RAM usage for a script on an ingame server.
     * 
     * @throws { BitburnerError<BitburnerErrorCode.InvalidFile> } If the file path is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.InvalidHostname> } If the server hostname is invalid.
     * @throws { BitburnerError<BitburnerErrorCode.FileNotFound> } If the file doesn't exist.
     * 
     * @returns the script's static RAM usage, `-1` if the script's RAM could not be calculated, or null if the game isn't connected.
     */
    async calculateRam(filename: string, server = "home"): Promise<number | null> {
        return this.send<number>({
            method: "calculateRam",
            params: {
                filename,
                server,
            },
        }).catch(e => {
            if (e instanceof BitburnerError && e.code === BitburnerErrorCode.RamNotCalculated) {
                return -1;
            } else {
                throw e;
            }
        });
    }

    /**
     * Get all servers that currently exist in the game.
     */
    async getAllServers(): Promise<Server[] | null> {
        return this.send<Server[]>({
            method: "getAllServers",
        });
    }
    //#endregion
}