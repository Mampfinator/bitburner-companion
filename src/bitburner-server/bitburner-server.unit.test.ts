import { IVSCodeExtLogger } from "@vscode-logging/logger";
import { BitburnerServer, DEFAULT_CONFIG } from ".";
import assert from "assert";
import { after, before, suite, test } from "mocha";

function mockExtensionLogger(): IVSCodeExtLogger {
    return {
        trace: () => {},
        debug: () => {},
        info: console.log,
        warn: console.warn,
        error: console.error,
        fatal: console.error,
        changeLevel: () => { },
        changeSourceLocationTracking: () => { },
        getChildLogger: () => mockExtensionLogger()
    };
}

suite("Bitburner Server", async () => {
    let server: BitburnerServer;
    
    before(async function() {
        this.timeout(60000);
        console.log(`To proceed, connect to the server at localhost:${DEFAULT_CONFIG.port} ingame.`);
        server = await new BitburnerServer(DEFAULT_CONFIG, mockExtensionLogger()).awaitConnection();
    });

    test("can get script ram", async function() {
        const ram = await server.calculateRam("test.js");

        assert(typeof ram === "number");
        assert((ram as number) === 1.6);
    });


    test("can get definitions file", async function() {
        const file = await server.getDefinitionFile() as string;
        assert(typeof file === "string");
        
        const firstLine = file.split("\n")[0].trim();
        assert(firstLine === "/** All netscript definitions */");
    });

    test("can list servers", async function() {
        const servers = await server.getAllServers();
        assert(servers && servers.length > 0);

        const n00dles = servers.find(s => s.hostname === "n00dles");
        assert(n00dles && n00dles.hostname === "n00dles" && !n00dles.purchasedByPlayer);

        const home = servers.find(s => s.hostname === "home");
        assert(home && home.hostname === "home" && home.purchasedByPlayer && home.hasAdminRights);
    });

    after(() => server[Symbol.dispose]());
});