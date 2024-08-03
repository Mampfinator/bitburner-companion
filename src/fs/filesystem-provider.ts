import { Disposable, Event, FileChangeEvent, FileStat, FileSystemError, FileSystemProvider, FileType, Uri } from "vscode";
import { parseDirectoryFromFileList, parseUri } from "./util";
import { BitburnerServer } from "../bitburner-server";
import { BitburnerError, BitburnerErrorCode } from "../bitburner-server/errors";

export class BitburnerFilesystemProvider implements FileSystemProvider {
    onDidChangeFile: Event<FileChangeEvent[]>;

    constructor(
        private readonly server: BitburnerServer
    ) {
        this.onDidChangeFile = (_callback) => { return {dispose() {}}; };
    }

    // not implementable for now
    watch(uri: Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): Disposable {
        throw FileSystemError.Unavailable("Unimplemented");
    }
    async stat(uri: Uri): Promise<FileStat> {
        const filePath = parseUri(uri);
        if (!filePath) {
            throw FileSystemError.FileNotFound("Invalid URI");
        }

        return {
            type: FileType.File,
            ctime: 0,
            mtime: 0,
            size: 1,
        };
    }

    async readDirectory(uri: Uri): Promise<[string, FileType][]> { 
        const filePath = parseUri(uri); 

        const files = await this.server.getFileNames(filePath.server);
        if (!files) {
            throw FileSystemError.FileNotFound("Failed to get files.");
        }

        return parseDirectoryFromFileList(files, filePath.filename);
    }

    // not really implementable; directories as such don't really exist in bitburner.
    createDirectory(uri: Uri): void | Thenable<void> {}
    
    async readFile(uri: Uri): Promise<Uint8Array> {
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            throw FileSystemError.FileNotFound("Invalid URI");
        }

        try {
            const textContent = await this.server.getFileContent(filePath.filename, filePath.server);
            if (!textContent) {
                return new Uint8Array();
            }

            return new TextEncoder().encode(textContent);
        } catch (e) {
            if (e instanceof BitburnerError) {
                switch (e.code) {
                    case BitburnerErrorCode.FileNotFound:
                    case BitburnerErrorCode.InvalidFile:
                    case BitburnerErrorCode.InvalidHostname:
                        throw FileSystemError.FileNotFound(e.message);
                }
            }

            throw e;
        }
    }

    async writeFile(uri: Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            return;
        }

        if (!options.overwrite) {
            try {
                // If file exists or if game is not currently connected, this doesn't throw.
                // in either case, we don't want to overwrite the file, so we return.
                const text = await this.server.getFileContent(filePath.filename, filePath.server);
                if (!text) {
                    throw FileSystemError.Unavailable("Game is not connected.");
                }
                return;
            } catch (e) {
                if (e instanceof BitburnerError) {
                    if (e.code === BitburnerErrorCode.FileNotFound) {}
                    else {
                        switch (e.code) {
                            case BitburnerErrorCode.InvalidFile:
                            case BitburnerErrorCode.InvalidHostname:
                                throw FileSystemError.FileNotFound(e.message);
                            default:
                                throw e;
                        }
                    }
                }

                throw e;
            }
        }

        try {
            await this.server.pushFile(filePath.filename, new TextDecoder().decode(content), filePath.server);
        } catch {}
    }

    async delete(uri: Uri, options: { readonly recursive: boolean; }): Promise<void> {
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            return;
        }

        // TODO: handle recursive deletions. This would require listing all files on the server and deleting them one by one.
        try {
            await this.server.deleteFile(filePath.filename, filePath.server);
        } catch {}
    }
    rename(oldUri: Uri, newUri: Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        
    }
}