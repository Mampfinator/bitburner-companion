export enum BitburnerErrorCode {
    /**
     * Generic error.
     */
    Failed = "Failed",
    /**
     * Returned when the server sends an incorrect method.
     */
    UnknownMessage = "UnknownMessage",
    /**
     * Returned when the server sends incorrect parameters.
     */
    MissingParameters = "MissingParameters",
    InvalidFile = "InvalidFilePath",
    InvalidFileExtension = "InvalidFileExtension",
    InvalidHostname = "InvalidHostname",
    FileNotFound = "FileNotFound",
    /**
     * Returned by `getScriptRam` when the script exists, but contains errors that prevent RAM calculation.
     */
    RamNotCalculated = "RamNotCalculated",
    ResponseTimeout = "ResponseTimeout",
}

export function parseErrorCode(error: string): BitburnerErrorCode {
    switch (error) {
        case "Misses parameters":
        case "Message misses parameters":
            return BitburnerErrorCode.MissingParameters;
        case "Invalid file path":
        case "Invalid filename":
            return BitburnerErrorCode.InvalidFile;
        case "Invalid file extension":
            return BitburnerErrorCode.InvalidFileExtension;
        case "File doesn't exist":
            return BitburnerErrorCode.FileNotFound;
        case "Server hostname invalid":
            return BitburnerErrorCode.InvalidHostname;
        case "Ram cost could not be calculated":
            return BitburnerErrorCode.RamNotCalculated;
        default:
            return BitburnerErrorCode.Failed;
    }
}

const ERROR_MESSAGES: Record<BitburnerErrorCode, string> = {
    [BitburnerErrorCode.Failed]: "Failed",
    [BitburnerErrorCode.UnknownMessage]: "Unknown message",
    [BitburnerErrorCode.MissingParameters]: "Missing parameters",
    [BitburnerErrorCode.InvalidFile]: "Invalid file path",
    [BitburnerErrorCode.InvalidFileExtension]: "Invalid file extension",
    [BitburnerErrorCode.InvalidHostname]: "Server hostname invalid",
    [BitburnerErrorCode.FileNotFound]: "File doesn't exist",
    [BitburnerErrorCode.RamNotCalculated]: "RAM cost could not be calculated",
    [BitburnerErrorCode.ResponseTimeout]: "Response timed out",
};


export class BitburnerError<TCode extends BitburnerErrorCode = BitburnerErrorCode> extends Error {
    constructor(public readonly code: TCode, public readonly originalMessage: string) {
        super(ERROR_MESSAGES[code]);    
    }

    public static fromErrorMessage<T extends BitburnerErrorCode = BitburnerErrorCode>(errorMessage: string): BitburnerError<T> | null {
        const code = parseErrorCode(errorMessage);
        if (!code) {
            return null;
        }

        return new BitburnerError<T>(code as T, errorMessage);
    }
}