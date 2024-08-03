import * as vscode from "vscode";
import { BitburnerServer } from "../bitburner-server";
import { BitburnerFilesystemProvider } from "./filesystem-provider";
import { join } from "path";
import { IVSCodeExtLogger } from "@vscode-logging/logger";
import { normalizePath } from "./util";

interface FileData {
    filename?: string;
    server: string;
}

function lastSegment(path: string): string {
    const segments = path.split(/(\/|\\)/);
    return segments[segments.length - 1];
}

function ensureLeadingSlash(path: string): string {
    if (path.startsWith("/")) {
        return path;
    } else {
        return `/${path}`;
    }
}

export class BitburnerRemoteFsTreeDataProvider implements vscode.TreeDataProvider<FileData> {
    private readonly logger: IVSCodeExtLogger;

    onDidChangeTreeData: vscode.Event<undefined>;

    constructor(
        private readonly server: BitburnerServer,
        private readonly filesystem: BitburnerFilesystemProvider,
    ) {
        this.logger = server.logger;

        this.onDidChangeTreeData = (callback) => {
            const interval = setInterval(() => {
                callback(undefined);
            }, 1000);

            return {
                dispose() {
                    clearInterval(interval);
                }
            };
        };
    }

    async getTreeItem(element: FileData): Promise<vscode.TreeItem> {
        this.logger.info(`[fs] getTreeItem: ${JSON.stringify(element)}`);
        if (!element.filename) {
            const item = new vscode.TreeItem(element.server, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("server");
            return item;
        } else {
            // path is a file
            if (/\./.test(element.filename)) {
                const fileItem =  new vscode.TreeItem(lastSegment(element.filename), vscode.TreeItemCollapsibleState.None);
                fileItem.command = {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [
                        vscode.Uri.from({
                            scheme: "bitburner",
                            authority: element.server,
                            path: "/" + normalizePath(element.filename),
                        }),
                    ],
                };

                fileItem.iconPath = vscode.ThemeIcon.File;

                return fileItem;
            } else {
                const item = new vscode.TreeItem(lastSegment(element.filename), vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = vscode.ThemeIcon.Folder;
                return item;
            }
        }
    }
    async getChildren(element?: FileData | undefined): Promise<FileData[]> {
        this.logger.info(`[fs] getChildren: ${JSON.stringify(element)}`);
        if (!element) {
            const servers = await this.server.getAllServers();
            if (!servers) {
                this.logger.error("[fs] getChildren: Failed to get servers");
                return [];
            }
            return servers.map(server => ({
                server: server.hostname
            }));
        } else {
            this.logger.info(`[fs] getChildren: ${element.server} ${element.filename}`);

            const files = await this.filesystem.readDirectory(vscode.Uri.from({
                scheme: "bitburner",
                authority: element.server,
                path: element.filename ? ensureLeadingSlash(element.filename) : undefined,
            }));

            if (!files) {
                this.logger.error("[fs] getChildren: Failed to get files");
                return [];
            }

            return files.map(file => ({
                filename: join(element.filename ?? "", file[0]),
                server: element.server
            }));
        }
    }
}