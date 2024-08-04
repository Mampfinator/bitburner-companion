import { FileType, Uri } from "vscode";

export function parseUri(uri: Uri): { server: string, filename?: string } {
    const {path: filename, authority: server} = uri;

    return { server, filename };
}

type FileTree = Map<string, FileType | Map<string, FileType>>;

function removeLeadingSlash(path?: string): string | undefined {
    return path ? 
        path.startsWith("/") ? path.slice(1) : path
        : path;
}

export function normalizePath<T extends string | undefined>(path: T): T {
    if (!path) {
        return path;
    }

    path = removeLeadingSlash(path)! as T;
    path = path!.replaceAll("\\", "/") as T;
    return path;
}

export function parseDirectoryFromFileList(files: string[], folderPath?: string): [string, FileType][] {
    folderPath = normalizePath(folderPath);
    
    // `files` is a list of absolute file paths for every single file on a server.
    const tree = new Map();
    for (const file of files) {
        if (folderPath && !file.startsWith(folderPath)) {
            continue;
        }

        const path = file.split("/").filter(x => x.length > 0);
        let folder = tree;
        while (path.length > 1) {
            const name = path.shift()!;

            if (!folder.has(name)) {
                folder.set(name, new Map());
            }
            folder = folder.get(name) as Map<string, Map<string, FileType>>;
        }

        folder.set(path[0]!, FileType.File);
    }

    if (!folderPath || folderPath.length === 0) {
        return [...tree.entries()].map(([name, type]) => [name, type instanceof Map ? FileType.Directory : type]);
    }


    let folder = tree;
    const path = folderPath.split("/").filter(x => x.length > 0);
    while (path.length > 0) {
        const name = path.shift()!;
        folder = folder.get(name) as Map<string, Map<string, FileType>>;
    }

    return [...folder.entries()].map(([name, type]) => [name, type instanceof Map ? FileType.Directory : type]);
}