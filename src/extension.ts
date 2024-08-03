// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { getExtensionLogger } from "@vscode-logging/logger";
import { BitburnerConfig, BitburnerServer, DEFAULT_CONFIG } from './bitburner-server';
import { BitburnerFilesystemProvider } from './fs/filesystem-provider';
import { BitburnerRemoteFsTreeDataProvider } from './fs/tree-data';

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

	const onConfigChange = vscode.workspace.onDidChangeConfiguration(e => {
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
	statusbarIcon.text = "$(loading~spin) BB: Waiting";

	server.onGameConnected(() => {
		statusbarIcon.text = "$(check) BB: Connected";
	});

	server.onGameDisconnected(() => {
		statusbarIcon.text = "$(close) BB: Disconnected";
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
	);

	
}

// This method is called when your extension is deactivated
export function deactivate() {}
