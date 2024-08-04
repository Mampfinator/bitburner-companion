import { IVSCodeExtLogger } from "@vscode-logging/logger";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { FileData, Message, Server } from "./interfaces";
import { BitburnerError, BitburnerErrorCode } from "./errors";

export const DEFAULT_CONFIG: BitburnerConfig = {
    port: 12525, 
    messageTimeout: 10000,
    relayServers: [],
    useServerFolders: false,
    scriptFolder: "src",
};

export interface BitburnerConfig {
    port: number;
    relayServers: string[];
    messageTimeout: number;
    useServerFolders: boolean;
    scriptFolder: string;
}

function normalizeAddress(address: string) {
    if (!address.startsWith("ws://") && !address.startsWith("wss://")) {
        address = `ws://${address}`;
    }

    return address;
}

// TODO: move relay logic to a separate class
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

    private recheckTimeout?: NodeJS.Timeout;
    private failedRelays = new Set<string>();

    get config() {
        return structuredClone(this._config);
    }

    constructor(private _config: BitburnerConfig, public readonly logger: IVSCodeExtLogger) {
        this.start();
        this.syncRelayConnections();

        this.recheckTimeout = setInterval(async () => {
            for (const address of this.failedRelays) {
                this.addRelay(address).catch(() => {});
            }

            if (this.ws && this.relayQueue.length > 0) {
                const failed: typeof this.relayQueue = [];
                while (this.relayQueue.length > 0) {
                    const entry = this.relayQueue.shift()!;
                    if (!entry) {
                        continue;
                    }

                    const [message, ws, originalId] = entry;

                    try {
                        const response = await this.send(message);
                        if (!response) {
                            // game websocket became unavailable in the meantime. We just try again later.
                            failed.push(entry);
                            continue;
                        }

                        this.logger.trace(`[relay] sent message: ${JSON.stringify(message)} => ${JSON.stringify(response)}`);

                        ws.send(JSON.stringify({
                            ...message,
                            id: originalId,
                            result: response
                        }));
                    } catch (err) {
                        if (err instanceof BitburnerError) {
                            ws.send(JSON.stringify({
                                ...message,
                                id: originalId,
                                error: err.originalMessage,
                            }));
                        }
                    }
                }

                this.relayQueue.push(...failed);
            }
        }, 20 * 1000);
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

    private readonly relayConnections = new Map<string, WebSocket>();
    /**
     * Messages that came in while we were disconnected.
     */
    private readonly relayQueue: [Message, WebSocket, number][] = [];
    /**
     * Add a relay WebSocket connection. 
     * Messages from this socket will be sent to the game, and their responses relayed back to the original server.
     * 
     * @returns true if the connection was successful, false if not.
     */
    public async addRelay(address: string): Promise<void> {
        address = normalizeAddress(address);

        this.logger.info(`[relay] attempting to connect to to ${address}`);

        let res!: () => void;
        let rej!: (err: any) => void;
        const promise = new Promise<void>((resolve, reject) => {
            res = resolve;
            rej = reject;
        });
        
        try {
            const ws = new WebSocket(address);
            this.setupRelay(ws);
            
            ws.on("close", () => {
                this.relayConnections.delete(address);
            });
            ws.on("open", () => {
                res(); 
            });

            ws.on("error", err => {
                this.logger.error(`[relay] ${address}: ${err}`);
            });

            if (ws.readyState === WebSocket.OPEN) {
                res();
            }

            this.logger.info(`[relay] connected to ${address}`);

            this.relayConnections.set(address, ws);
        } catch (error) {
            this.failedRelays.add(address);
            this.logger.info(`[relay] failed to connect to ${address}: ${error}`);
            res();
        }

        return promise;
    }

    private setupRelay(ws: WebSocket) {
        ws.on("message", async data => {
            this.logger.trace(`[relay] received message: ${data}`);
            const message: Message = JSON.parse(data.toString());
            if (message.jsonrpc !== "2.0" || typeof message.id !== "number") {
                return;
            }

            const actualMessage = {...message, id: this.messageCounter++};

            if (this.ws) {
                const response = await this.send(actualMessage).catch(() => null);
                if (!response) {
                    this.logger.error(`[relay] failed to send message: ${data}`);
                    return;
                }

                ws.send(JSON.stringify({
                    ...message,
                    result: response
                }));
            } else {
                this.relayQueue.push([actualMessage, ws, message.id]);
            }
        });
    }

    private setupServer(): WebSocketServer {
        const wss = new WebSocketServer({port: this._config.port});

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
            this.logger.info(`[server] listening on port ${this._config.port}`);
        });

        return wss;
    }

    private setupClient(ws: WebSocket) {
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
        const old = structuredClone(this._config) as typeof this._config;
        Object.assign(this._config, config);

        if (old.port !== this._config.port) {
            this.logger.info(`[server] changing port from ${old.port} to ${this._config.port}`);
            this.wss.close();
            this.wss = this.setupServer();
        }

        this.syncRelayConnections();
    }

    public syncRelayConnections() {
        this.logger.info(`[server] syncing ${this._config.relayServers.length} relay servers: ${this._config.relayServers.join(", ")}`);
        const seen = new Set<string>();
        for (const address of this._config.relayServers.map(address => normalizeAddress(address))) {
            if (!this.relayConnections.has(address) && !this.failedRelays.has(address)) {
                this.addRelay(address).catch(() => {});
            }

            seen.add(address);
        }

        for (const [address, ws] of [...this.relayConnections.entries()].map(([address, ws]) => [normalizeAddress(address), ws] as const)) {
            if (seen.has(address)) {
                continue;
            }
            ws.close();
        }

        for (const address of this.failedRelays) {
            if (seen.has(address)) {
                continue;
            }
            this.failedRelays.delete(address);
        }
    }

    [Symbol.dispose]() {
        this.ws?.close();
        this.wss.close();
        for (const ws of this.relayConnections.values()) {
            ws.close();
        }
        clearTimeout(this.recheckTimeout);
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
            }, this._config.messageTimeout!);

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