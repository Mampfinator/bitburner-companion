import * as vscode from "vscode";
import { BitburnerConfig } from "./bitburner-server";

type ConnectionStatus = "connected" | "disconnected";


export class BitburnerStatusBarItem implements vscode.Disposable {
    readonly status: vscode.StatusBarItem;    
    private connectionStatus: ConnectionStatus = "disconnected";
    private currentFileRam: number | null = null;
    // set in `updateConfig
    private listenPort!: number;


    constructor(config: BitburnerConfig) {
        this.status = vscode.window.createStatusBarItem(
            "bitburner-companion.status-display",
            vscode.StatusBarAlignment.Right,
            100,
        );

        this.updateConfig(config);

        this.status.show();
    }

    public updateConfig(config: BitburnerConfig) {
        this.listenPort = config.port;

        this.updateStatusText();
        this.updateStatusTooltip();
    }

    private updateStatusText() {
        this.status.text = `${this.connectionStatus === "connected" ? "$(pass)" : "$(debug-disconnect)"} Bitburner`;
        if (this.currentFileRam !== null) {
            this.status.text += ` ${this.currentFileRam} GB`;
        }
    }

    private updateStatusTooltip() {
        if (this.connectionStatus === "connected") {
            this.status.tooltip = `Game connected at localhost:${this.listenPort}`;
        } else {
            this.status.tooltip = `Game not connected. Connect at localhost:${this.listenPort}`;
        }
    }

    public setConnectionStatus(status: ConnectionStatus) {
        this.connectionStatus = status;
        this.updateStatusText();
        this.updateStatusTooltip();
    }

    public setCurrentFileRam(ram: number | null) {
        this.currentFileRam = ram;
        this.updateStatusText();
        this.updateStatusTooltip();
    }

    dispose(): void {
        this.status.dispose();
    }
}