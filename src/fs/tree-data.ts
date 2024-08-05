import * as vscode from "vscode";
import { BitburnerServer } from "../bitburner-server";
import { BitburnerFilesystemProvider } from "./filesystem-provider";
import { join } from "path";
import { IChildLogger } from "@vscode-logging/logger";
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
    private readonly logger: IChildLogger;

    onDidChangeTreeData: vscode.Event<undefined>;

    constructor(
        private readonly server: BitburnerServer,
        private readonly filesystem: BitburnerFilesystemProvider,
    ) {
        this.logger = server.logger.getChildLogger({ label: "remote-files" });

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
        const uri = vscode.Uri.from({
            scheme: "bitburner",
            authority: element.server,
            path: "/" + normalizePath(element.filename || ""),
        });

        if (!element.filename) {
            const item = new vscode.TreeItem(element.server, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("server");
            item.contextValue = "server";
            return item;
        } else {
            // path is a file
            if (/\./.test(element.filename)) {
                const fileItem =  new vscode.TreeItem(lastSegment(element.filename), vscode.TreeItemCollapsibleState.None);
                fileItem.command = {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [uri],
                };

                fileItem.contextValue = "file";

                fileItem.resourceUri = uri;
                return fileItem;
            } else {
                const item = new vscode.TreeItem(lastSegment(element.filename), vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = uri;
                item.contextValue = "folder";
                return item;
            }
        }
    }
    async getChildren(element?: FileData | undefined): Promise<FileData[]> {
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