// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { getExtensionLogger } from "@vscode-logging/logger";
import { BitburnerConfig, BitburnerServer, DEFAULT_CONFIG } from './bitburner-server';
import { BitburnerFilesystemProvider } from './fs/filesystem-provider';
import { BitburnerRemoteFsTreeDataProvider } from './fs/tree-data';
import { parseUri } from './fs/util';

function getServerSettings(settings: vscode.WorkspaceConfiguration): BitburnerConfig {
	const config = {} as Partial<BitburnerConfig>;
	
	for (const key of Object.keys(DEFAULT_CONFIG) as (keyof BitburnerConfig)[]) {
		config[key] = settings.get<any>(key, DEFAULT_CONFIG[key]);
	}

	return config as BitburnerConfig;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const logger = getExtensionLogger({
		extName: "bitburner-companion",
		level: "debug",
		logPath: context.logUri.fsPath,
		logOutputChannel: vscode.window.createOutputChannel("Bitburner Sync"),
		sourceLocationTracking: false,
		logConsole: false,
	});

	let settings = getServerSettings(vscode.workspace.getConfiguration("bitburner-companion"));
	const server = new BitburnerServer(settings, logger);

	const restartServer = vscode.commands.registerCommand("bitburner-companion.restart-server", () => {
		server[Symbol.dispose]();
		server.start();
	});

	const stopServer = vscode.commands.registerCommand("bitburner-companion.stop-server", () => {
		server.dispose();
		server.start();
	});

	const startServer = vscode.commands.registerCommand("bitburner-companion.start-server", () => {
		server.start();
	});

	const reconnectRelays = vscode.commands.registerCommand("bitburner-companion.reconnect-relays", () => {
		server.syncRelayConnections();
	});

	const onConfigChange = vscode.workspace.onDidChangeConfiguration(e => {
		logger.info(`[config] configuration changed: ${e.affectsConfiguration("bitburner-companion")}`);
		console.log(e);
		if (!e.affectsConfiguration("bitburner-companion")) {
			return;
		}

		if (!server) {
			return;
		}

		settings = getServerSettings(vscode.workspace.getConfiguration("bitburner-companion"));
		server.updateConfig(settings);
	});

	const watcher = vscode.workspace.createFileSystemWatcher("");

	const statusbarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusbarIcon.command = "bitburner-companion.restart-server";
	statusbarIcon.tooltip = "Click to restart Bitburner server";
	statusbarIcon.text = "BB $(loading~spin)";

	server.onGameConnected(() => {
		statusbarIcon.text = "BB $(pass)";
	});

	server.onGameDisconnected(() => {
		statusbarIcon.text = "BB $(debug-disconnect)";
	});

	statusbarIcon.show();
	
	const filesystem = new BitburnerFilesystemProvider(server);

	const filesystemProvider = vscode.workspace.registerFileSystemProvider("bitburner", filesystem);
	const openFile = vscode.commands.registerCommand("bitburner-companion.open-remote-file", async () => {
		const hostname = await vscode.window.showInputBox({
			placeHolder: "Hostname",
			value: "home",
		});

		const filepath = await vscode.window.showInputBox({
			placeHolder: "Filepath",
		});

		const uri = vscode.Uri.parse(`bitburner://${hostname!}/${filepath}`);

		vscode.commands.executeCommand("vscode.open", uri);

		if (!uri) {
			return;
		}
	});

	
	const remoteFs = vscode.window.createTreeView("bitburner-companion.remote-fs", {
		treeDataProvider: new BitburnerRemoteFsTreeDataProvider(server, filesystem),
	});


	const ramUsageIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	ramUsageIcon.text = "/";

	function setRamUsage(usage: number | null | undefined | void) {
		if (!usage) {
			ramUsageIcon.hide();
		} else if (usage >= 0) {
			ramUsageIcon.text = `$(bitburner-logo) ${usage.toFixed(2)} GB`;
			ramUsageIcon.show();
		} else {
			ramUsageIcon.text = `$(bitburner-logo) Syntax error`;
			ramUsageIcon.show();
		}
	}

	// RAM-usage status bar hint
	vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		const uri = editor?.document.uri;
		
		if (!uri) {
			ramUsageIcon.hide();
			return;
		}

		const filePath = parseUri(uri);

		if (!filePath.filename) {
			logger.error("Failed to parse uri for RAM usage hint.");
			setRamUsage(undefined);
			return;
		}

		let filename: string;
		let hostname: string;

		if (uri.scheme === "bitburner") {
			hostname = filePath.server;
			filename = filePath.filename!;
		} else if (uri.scheme === "file") {
			// for now, blindly remap ${workspaceFolder}/src/ to home/ and replace extension with .js
			// TODO: find a way to automatically associate workspace files with home files
			hostname = "home";
			filename = uri.path.replace(/.+?\/src\//, "/").replace(/\.ts$/, ".js");
		} else {
			setRamUsage(undefined);
			return;
		}

		const ramUsage = await server.calculateRam(filename, hostname).catch(() => {});
		setRamUsage(ramUsage);
	});
	

	context.subscriptions.push(
		restartServer, 
		stopServer, 
		startServer,
		onConfigChange,
		watcher, 
		server, 
		statusbarIcon,
		openFile,
		filesystemProvider,
		remoteFs,
		ramUsageIcon,
		reconnectRelays,
	);

	
}

// This method is called when your extension is deactivated
export function deactivate() {}
