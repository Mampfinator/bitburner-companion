import { Disposable, Event, FileChangeEvent, FileStat, FileSystemError, FileSystemProvider, FileType, Uri } from "vscode";
import { parseDirectoryFromFileList, parseUri } from "./util";
import { BitburnerServer } from "../bitburner-server";
import { BitburnerError, BitburnerErrorCode } from "../bitburner-server/errors";
import { IChildLogger } from "@vscode-logging/logger";

function isFileUri(uri: Uri): boolean {
    return uri.path.match(/\.[a-zA-Z]+$/) !== null;
}

/**
 * Map errors to their `FileSystemError` equivalents where possible and rethrow.
 * 
 * @param e Error to map.
 * @param throwUnknown Whether to throw if `e` is not directly mappable to `FileSystemError`.
 * @param ignore Optional function to determine whether to ignore `e`.
 * 
 * @returns If `throwUnknown` is true, nothing is returned. Otherwise, `e` is returned if it doesn't map to a `FileSystemError`. 
 * If `ignore` is provided and returns true, `e` is returned regardless of `throwUnknown`.
 */
function mapError<
    E extends Error = Error, 
    TThrowUnknown extends boolean = true, 
    TIgnore extends ((e: E) => boolean) | undefined = undefined
>(e: E, throwUnknown: TThrowUnknown = true as TThrowUnknown, ignore?: TIgnore): 
    (TThrowUnknown extends true ? never : E) |  (TIgnore extends Function ? E : never)
{
    function shouldThrow() {
        return throwUnknown === undefined ? true : throwUnknown;
    }

    if (ignore?.(e)) {
        return e as any;
    }

    if (!(e instanceof BitburnerError)) {
        if (shouldThrow()) {
            throw e;
        } else {
            return e as any;
        }
    }

    switch (e.code) {
        case BitburnerErrorCode.FileNotFound:
        case BitburnerErrorCode.InvalidFile:
        case BitburnerErrorCode.InvalidHostname:
            throw FileSystemError.FileNotFound(e.message);
        default: 
            if (shouldThrow()) {
                throw e;
            } else {
                return e as any;
            }
    }
}

export class BitburnerFilesystemProvider implements FileSystemProvider {
    private readonly logger: IChildLogger;
    onDidChangeFile: Event<FileChangeEvent[]>;

    constructor(
        private readonly server: BitburnerServer
    ) {
        this.logger = server.logger.getChildLogger({ label: "filesystem-provider" });
        this.onDidChangeFile = (_callback) => { return {dispose() {}}; };
    }

    // not implementable for now
    watch(uri: Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): Disposable {
        throw new FileSystemError("Method not implemented.");
    }

    async stat(uri: Uri): Promise<FileStat> {
        if (!isFileUri(uri)) {
            throw new FileSystemError("Invalid URI. Can only stat files.");
        }
        
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            throw FileSystemError.FileNotFound("Invalid URI");
        }

        const text = await this.server.getFileContent(filePath.filename, filePath.server).catch(mapError);

        if (!text) {
            throw FileSystemError.Unavailable("Game is not connected.");
        }

        return {
            // folders don't exist in bitburner
            type: FileType.File,
            ctime: 0,
            mtime: 0,
            size: text.length,
        };
    }

    async readDirectory(uri: Uri): Promise<[string, FileType][]> { 
        if (isFileUri(uri)) {
            throw FileSystemError.FileNotADirectory();
        }
        const filePath = parseUri(uri); 

        const files = await this.server.getFileNames(filePath.server).catch(mapError);
        if (!files) {
            throw FileSystemError.Unavailable("Game is not connected.");
        }

        return parseDirectoryFromFileList(files, filePath.filename);
    }

    // not really implementable; directories as such don't really exist in bitburner.
    createDirectory(uri: Uri): void | Thenable<void> {}
    
    async readFile(uri: Uri): Promise<Uint8Array> {
        if (!isFileUri(uri)) {
            throw FileSystemError.FileIsADirectory();
        }
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            throw FileSystemError.FileNotFound("Invalid URI");
        }

        const textContent = await this.server.getFileContent(filePath.filename, filePath.server).catch(mapError);
        if (!textContent) {
            return new Uint8Array();
        }

        return new TextEncoder().encode(textContent);
    }

    async writeFile(uri: Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
        if (!isFileUri(uri)) {
            throw FileSystemError.FileIsADirectory();
        }
        const filePath = parseUri(uri);
        if (!filePath.filename) {
            return;
        }

        if (!options.overwrite) {
            // If file exists or if game is not currently connected, this doesn't throw.
            // in either case, we don't want to overwrite the file, so we throw.
            const text = await this.server.getFileContent(filePath.filename, filePath.server).catch((e: BitburnerError) => mapError(e, true, (e: BitburnerError<BitburnerErrorCode>) => e.code === BitburnerErrorCode.FileNotFound));
            if (!text) {
                throw FileSystemError.Unavailable("Game is not connected.");
            }
            if (typeof text === "string") {
                throw FileSystemError.FileExists(uri);
            }
        }

        try {
            await this.server.pushFile(filePath.filename, new TextDecoder().decode(content), filePath.server);
        } catch {}
    }

    async delete(uri: Uri, options: { readonly recursive: boolean; }): Promise<void> {
        if (!options.recursive && !isFileUri(uri)) {
            throw FileSystemError.FileIsADirectory();
        }

        const filePath = parseUri(uri);
        if (!filePath.filename) {
            return;
        }

        if (isFileUri(uri)) {
            try {
                await this.server.deleteFile(filePath.filename, filePath.server);
            } catch {}
        } else {
            
        }
    }

    rename(oldUri: Uri, newUri: Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        // TODO: rename would require getting the old file's content, pushing it to the new location and deleting the old file.
    }
}