"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = deactivate;
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// ─── MODULE-LEVEL (so deactivate() can reach the process) ────────────────────
let _validatorProcess = null;
function deactivate() {
    if (_validatorProcess) {
        _validatorProcess.kill();
        _validatorProcess = null;
    }
}
// ─── ACTIVATE ────────────────────────────────────────────────────────────────
async function activate(context) {
    const arcaneOutput = vscode.window.createOutputChannel('Arcane Studio');
    const platform = os.platform(); // 'win32' | 'darwin' | 'linux'
    const getState = () => ({
        lastNetwork: context.globalState.get('lastNetwork', 'localnet'),
        lastKeypairPath: context.globalState.get('lastKeypairPath', ''),
        lastProgramId: context.globalState.get('lastProgramId', ''),
    });
    const openDashboardCmd = vscode.commands.registerCommand('arcane.openDashboard', () => {
        const panel = vscode.window.createWebviewPanel('arcaneStudio', '⬡ Arcane Studio', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        panel.webview.html = getWebviewContent(getState(), platform);
        const uiLog = (text, type = 'info', failCmd = '') => {
            panel.webview.postMessage({ command: 'log', text, type, failCmd });
            arcaneOutput.appendLine('[' + type.toUpperCase() + '] ' + text);
        };
        const openInTerminal = (cmd, name = 'Arcane Studio') => {
            const terminal = vscode.window.createTerminal({ name });
            terminal.show();
            terminal.sendText(cmd);
        };
        const refreshStudio = async () => {
            let addr = '', bal = '0 SOL', network = '';
            const nodeStatus = _validatorProcess ? 'LIVE' : 'OFFLINE';
            try {
                const { stdout } = await execAsync('solana address');
                addr = stdout.trim();
            }
            catch { }
            try {
                const { stdout } = await execAsync('solana balance');
                bal = stdout.trim();
            }
            catch { }
            try {
                const { stdout } = await execAsync('solana config get');
                const m = stdout.match(/RPC URL:\s*(\S+)/);
                if (m)
                    network = m[1];
            }
            catch { }
            panel.webview.postMessage({ command: 'sync', addr, bal, nodeStatus, network });
        };
        const checkTools = async () => {
            const tools = [
                { name: 'Rust', cmd: 'rustc --version' },
                { name: 'Solana', cmd: 'solana --version' },
                { name: 'Arcium', cmd: 'arcium --version' },
                { name: 'Anchor', cmd: 'anchor --version' },
                { name: 'Node', cmd: 'node --version' },
            ];
            for (const t of tools) {
                try {
                    const { stdout } = await execAsync(t.cmd);
                    panel.webview.postMessage({
                        command: 'toolStatus', name: t.name,
                        status: 'ok', version: stdout.trim().split('\n')[0],
                    });
                }
                catch {
                    panel.webview.postMessage({ command: 'toolStatus', name: t.name, status: 'missing', version: '' });
                }
            }
        };
        panel.webview.onDidReceiveMessage(async (msg) => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            switch (msg.command) {
                case 'ready': {
                    panel.webview.postMessage({ command: 'init', platform, ...getState() });
                    await refreshStudio();
                    await checkTools();
                    const st = getState();
                    if (st.lastProgramId)
                        panel.webview.postMessage({ command: 'programId', id: st.lastProgramId });
                    break;
                }
                case 'checkSystem': {
                    await checkTools();
                    break;
                }
                case 'toggleNode': {
                    if (_validatorProcess) {
                        _validatorProcess.kill();
                        _validatorProcess = null;
                        uiLog('Validator stopped.', 'warn');
                        refreshStudio();
                    }
                    else {
                        uiLog('Spawning solana-test-validator --reset...', 'info');
                        _validatorProcess = (0, child_process_1.spawn)('solana-test-validator', ['--reset']);
                        _validatorProcess.stdout?.on('data', (d) => {
                            const line = d.toString().trim();
                            if (!line)
                                return;
                            uiLog(line, 'info');
                            if (line.includes('Ledger location') || line.includes('Genesis Hash')) {
                                uiLog('✓ Validator is LIVE', 'success');
                                refreshStudio();
                            }
                        });
                        _validatorProcess.stderr?.on('data', (d) => {
                            const t = d.toString().trim();
                            if (t)
                                uiLog(t, 'error');
                        });
                        _validatorProcess.on('exit', (code) => {
                            _validatorProcess = null;
                            uiLog('Validator exited (code ' + code + ')', 'warn');
                            refreshStudio();
                        });
                        refreshStudio();
                    }
                    break;
                }
                case 'setNetwork': {
                    const urls = {
                        localnet: 'http://127.0.0.1:8899',
                        devnet: 'https://api.devnet.solana.com',
                        testnet: 'https://api.testnet.solana.com',
                        mainnet: 'https://api.mainnet-beta.solana.com',
                    };
                    const url = urls[msg.network];
                    if (!url)
                        break;
                    try {
                        await execAsync('solana config set --url ' + url);
                        await context.globalState.update('lastNetwork', msg.network);
                        uiLog('✓ Network → ' + msg.network, 'success');
                        refreshStudio();
                    }
                    catch (e) {
                        uiLog('Network switch failed: ' + e.message, 'error', 'solana config set --url ' + url);
                    }
                    break;
                }
                case 'airdrop': {
                    const amount = msg.amount || '2';
                    uiLog('Requesting ' + amount + ' SOL airdrop...', 'info');
                    (0, child_process_1.exec)('solana airdrop ' + amount, (err, stdout, stderr) => {
                        if (err)
                            uiLog('Airdrop failed: ' + stderr.trim(), 'error', 'solana airdrop ' + amount);
                        else {
                            uiLog('✓ ' + stdout.trim(), 'success');
                            refreshStudio();
                        }
                    });
                    break;
                }
                case 'generateKeypair': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const outPath = path.join(root, 'id.json');
                    const genCmd = 'solana-keygen new --outfile "' + outPath + '" --no-bip39-passphrase --force';
                    (0, child_process_1.exec)(genCmd, (err, _out, stderr) => {
                        if (err)
                            uiLog('Keygen failed: ' + stderr.trim(), 'error', genCmd);
                        else {
                            uiLog('✓ Keypair created at ' + outPath, 'success');
                            context.globalState.update('lastKeypairPath', outPath);
                            refreshStudio();
                        }
                    });
                    break;
                }
                case 'setKeypair': {
                    const kpPath = (msg.kpPath || '').trim().replace(/^~/, os.homedir());
                    if (!kpPath) {
                        uiLog('No keypair path provided.', 'error');
                        break;
                    }
                    const kpCmd = 'solana config set --keypair "' + kpPath + '"';
                    (0, child_process_1.exec)(kpCmd, (err) => {
                        if (err)
                            uiLog('Failed to set keypair.', 'error', kpCmd);
                        else {
                            uiLog('✓ Keypair set to ' + kpPath, 'success');
                            context.globalState.update('lastKeypairPath', kpPath);
                            refreshStudio();
                        }
                    });
                    break;
                }
                case 'build': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    uiLog('Building with cargo build-sbf...', 'info');
                    panel.webview.postMessage({ command: 'buildState', state: 'building' });
                    const bp = (0, child_process_1.spawn)('cargo', ['build-sbf'], { cwd: root });
                    bp.stdout?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'info'); });
                    bp.stderr?.on('data', (d) => {
                        const t = d.toString().trim();
                        if (!t)
                            return;
                        if (t.startsWith('error'))
                            uiLog(t, 'error');
                        else
                            uiLog(t, 'info');
                    });
                    bp.on('exit', (code) => {
                        panel.webview.postMessage({ command: 'buildState', state: 'idle' });
                        if (code === 0)
                            uiLog('✓ Build succeeded!', 'success');
                        else
                            uiLog('✗ Build failed (exit ' + code + ')', 'error', 'cargo build-sbf');
                    });
                    break;
                }
                case 'clippy': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    uiLog('Running cargo clippy...', 'info');
                    const cp = (0, child_process_1.spawn)('cargo', ['clippy', '--', '-D', 'warnings'], { cwd: root });
                    cp.stdout?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'info'); });
                    cp.stderr?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'warn'); });
                    cp.on('exit', (code) => {
                        if (code === 0)
                            uiLog('✓ Clippy clean!', 'success');
                        else
                            uiLog('Clippy found issues. Check logs.', 'warn', 'cargo clippy -- -D warnings');
                    });
                    break;
                }
                case 'test': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    uiLog('Running cargo test...', 'info');
                    const tp = (0, child_process_1.spawn)('cargo', ['test'], { cwd: root });
                    tp.stdout?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'info'); });
                    tp.stderr?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'error'); });
                    tp.on('exit', (code) => {
                        if (code === 0)
                            uiLog('✓ All tests passed!', 'success');
                        else
                            uiLog('✗ Tests failed.', 'error', 'cargo test');
                    });
                    break;
                }
                case 'deploy': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    let soFile = (msg.soPath || '').trim();
                    if (!soFile) {
                        const deployDir = path.join(root, 'target', 'deploy');
                        try {
                            const files = fs.readdirSync(deployDir).filter(f => f.endsWith('.so'));
                            if (!files.length) {
                                uiLog('No .so found — run build first.', 'error');
                                break;
                            }
                            if (files.length > 1)
                                uiLog('Multiple .so files — using: ' + files[0], 'warn');
                            soFile = path.join(deployDir, files[0]);
                        }
                        catch {
                            uiLog('target/deploy not found — run build first.', 'error');
                            break;
                        }
                    }
                    uiLog('Deploying ' + path.basename(soFile) + '...', 'info');
                    const depCmd = 'solana program deploy "' + soFile + '"';
                    (0, child_process_1.exec)(depCmd, { cwd: root }, (err, stdout, stderr) => {
                        if (err)
                            uiLog('Deploy failed: ' + stderr.trim(), 'error', depCmd);
                        else {
                            uiLog('✓ ' + stdout.trim(), 'success');
                            const match = stdout.match(/Program Id:\s*(\S+)/);
                            if (match) {
                                panel.webview.postMessage({ command: 'programId', id: match[1] });
                                context.globalState.update('lastProgramId', match[1]);
                            }
                        }
                    });
                    break;
                }
                case 'showPrograms': {
                    (0, child_process_1.exec)('solana program show --programs', (err, stdout, stderr) => {
                        if (err)
                            uiLog('Failed: ' + stderr.trim(), 'error', 'solana program show --programs');
                        else
                            uiLog(stdout.trim(), 'info');
                    });
                    break;
                }
                // ── ARCIUM STEP 1 ─────────────────────────────────────────────
                // arcium init <name>
                // Creates workspace, Arcium.toml, and encrypted-ixs/ directory
                case 'arciumInit': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const projectName = (msg.projectName || '').trim() || 'my_arcium_project';
                    const initCmd = 'arcium init ' + projectName;
                    uiLog('Running: ' + initCmd, 'info');
                    (0, child_process_1.exec)(initCmd, { cwd: root }, (err, stdout, stderr) => {
                        if (err)
                            uiLog('arcium init failed: ' + stderr.trim(), 'error', initCmd);
                        else
                            uiLog('✓ ' + (stdout.trim() || 'Project initialized. Arcium.toml and encrypted-ixs/ created.'), 'success');
                    });
                    break;
                }
                // ── ARCIUM STEP 2 ─────────────────────────────────────────────
                // arcium build
                // Compiles Arcis circuits to bytecode + .idarc interface files,
                // then builds the Solana program. Replaces cargo build-sbf
                // for Arcium projects.
                case 'arciumBuild': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    uiLog('Running: arcium build', 'info');
                    panel.webview.postMessage({ command: 'arciumBuildState', state: 'building' });
                    const abp = (0, child_process_1.spawn)('arcium', ['build'], { cwd: root });
                    abp.stdout?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'info'); });
                    abp.stderr?.on('data', (d) => {
                        const t = d.toString().trim();
                        if (!t)
                            return;
                        if (t.startsWith('error'))
                            uiLog(t, 'error');
                        else
                            uiLog(t, 'info');
                    });
                    abp.on('exit', (code) => {
                        panel.webview.postMessage({ command: 'arciumBuildState', state: 'idle' });
                        if (code === 0)
                            uiLog('✓ arcium build succeeded!', 'success');
                        else
                            uiLog('✗ arcium build failed (exit ' + code + ')', 'error', 'arcium build');
                    });
                    break;
                }
                // ── ARCIUM STEP 3 ─────────────────────────────────────────────
                // arcium test
                // Runs TypeScript tests against a local MPC cluster
                case 'arciumTest': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    uiLog('Running: arcium test', 'info');
                    const atp = (0, child_process_1.spawn)('arcium', ['test'], { cwd: root });
                    atp.stdout?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'info'); });
                    atp.stderr?.on('data', (d) => { const t = d.toString().trim(); if (t)
                        uiLog(t, 'error'); });
                    atp.on('exit', (code) => {
                        if (code === 0)
                            uiLog('✓ All arcium tests passed!', 'success');
                        else
                            uiLog('✗ arcium test failed.', 'error', 'arcium test');
                    });
                    break;
                }
                // ── ARCIUM STEP 4 ─────────────────────────────────────────────
                // arcium deploy
                // Single command: deploys Solana program + initializes MXE on-chain,
                // links to MPC cluster, creates key recovery material, sets up mempool.
                // NOTE: --mempool-size is set here, NOT in a separate command.
                case 'arciumDeploy': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const clusterOffset = (msg.clusterOffset || '').trim() || '456';
                    const recoverySize = (msg.recoverySize || '').trim() || '4';
                    const rpcUrl = (msg.rpcUrl || '').trim();
                    const mempoolSize = (msg.mempoolSize || '').trim() || 'Medium';
                    const args = [
                        'deploy',
                        '--cluster-offset', clusterOffset,
                        '--recovery-set-size', recoverySize,
                        '--mempool-size', mempoolSize,
                        ...(rpcUrl ? ['--rpc-url', rpcUrl] : []),
                    ];
                    uiLog('Running: arcium ' + args.join(' '), 'info');
                    panel.webview.postMessage({ command: 'arciumDeployState', state: 'deploying' });
                    const adp = (0, child_process_1.spawn)('arcium', args, { cwd: root });
                    adp.stdout?.on('data', (d) => {
                        const t = d.toString().trim();
                        if (!t)
                            return;
                        uiLog(t, 'info');
                        const pidMatch = t.match(/Program Id:\s*(\S+)/);
                        if (pidMatch) {
                            panel.webview.postMessage({ command: 'programId', id: pidMatch[1] });
                            context.globalState.update('lastProgramId', pidMatch[1]);
                        }
                    });
                    adp.stderr?.on('data', (d) => {
                        const t = d.toString().trim();
                        if (t)
                            uiLog(t, 'error');
                    });
                    adp.on('exit', (code) => {
                        panel.webview.postMessage({ command: 'arciumDeployState', state: 'idle' });
                        if (code === 0)
                            uiLog('✓ arcium deploy succeeded! MXE is live on-chain.', 'success');
                        else
                            uiLog('✗ arcium deploy failed (exit ' + code + ')', 'error', 'arcium ' + args.join(' '));
                    });
                    break;
                }
                // ── ARCIUM STEP 5 ─────────────────────────────────────────────
                // init_comp_def — client-side only, no CLI command.
                // Runs a TypeScript script using @arcium-hq/client to call the
                // program's init_comp_def instruction on-chain, registering what
                // encrypted operations the MXE is authorized to perform.
                case 'arciumInitCompDef': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const scriptPath = (msg.scriptPath || '').trim();
                    const candidates = [
                        scriptPath,
                        path.join(root, 'scripts', 'init_comp_def.ts'),
                        path.join(root, 'scripts', 'init.ts'),
                        path.join(root, 'client', 'init.ts'),
                    ].filter(Boolean);
                    let found = '';
                    for (const c of candidates) {
                        if (c && fs.existsSync(c)) {
                            found = c;
                            break;
                        }
                    }
                    if (!found) {
                        uiLog('No init script found. Expected scripts/init_comp_def.ts', 'warn');
                        uiLog('Create that file using @arcium-hq/client to call your program\'s init_comp_def instruction.', 'info');
                        break;
                    }
                    const runCmd = 'npx ts-node "' + found + '"';
                    uiLog('Running init script: ' + found, 'info');
                    (0, child_process_1.exec)(runCmd, { cwd: root }, (err, stdout, stderr) => {
                        if (err)
                            uiLog('Init script failed: ' + stderr.trim(), 'error', runCmd);
                        else
                            uiLog('✓ Computation definition initialized: ' + stdout.trim(), 'success');
                    });
                    break;
                }
                case 'scaffold': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const srcDir = path.join(root, 'src');
                    if (!fs.existsSync(srcDir))
                        fs.mkdirSync(srcDir, { recursive: true });
                    fs.writeFileSync(path.join(srcDir, 'lib.rs'), getCircuitTemplate(msg.logic, msg.circuitType));
                    uiLog('✓ Circuit scaffolded to src/lib.rs', 'success');
                    break;
                }
                case 'install': {
                    if (!root) {
                        uiLog('No workspace open.', 'error');
                        break;
                    }
                    const pkgName = (msg.name || '').trim();
                    if (!pkgName) {
                        uiLog('Provide a package name.', 'error');
                        break;
                    }
                    const instCmd = msg.pkgType === 'npm' ? 'npm install ' + pkgName : 'cargo add ' + pkgName;
                    uiLog('Installing ' + pkgName + ' via ' + msg.pkgType + '...', 'info');
                    (0, child_process_1.exec)(instCmd, { cwd: root }, (err, _out, stderr) => {
                        if (err)
                            uiLog('Install failed: ' + stderr.trim(), 'error', instCmd);
                        else
                            uiLog('✓ ' + pkgName + ' installed.', 'success');
                    });
                    break;
                }
                case 'openTerminal': {
                    openInTerminal(msg.cmd, msg.name || 'Arcane Studio');
                    break;
                }
                case 'refresh':
                    await refreshStudio();
                    break;
            }
        });
        refreshStudio();
    });
    vscode.window.registerTreeDataProvider('arcane-actions', new ArcaneProvider());
    context.subscriptions.push(openDashboardCmd);
}
// ─── INSTALL COMMANDS ────────────────────────────────────────────────────────
function getInstallCommands(platform) {
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';
    return {
        Rust: isWin
            ? 'winget install Rustlang.Rustup'
            : "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && source \"$HOME/.cargo/env\"",
        Solana: isWin
            ? 'irm https://release.solana.com/stable/solana-install-init.ps1 | iex'
            : 'sh -c "$(curl -sSfL https://release.solana.com/stable/install)"',
        Arcium: 'cargo install arcium-cli',
        Anchor: 'cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && avm install latest && avm use latest',
        Node: isWin
            ? 'winget install OpenJS.NodeJS.LTS'
            : isMac
                ? 'brew install node'
                : 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs',
    };
}
// ─── CIRCUIT TEMPLATE ────────────────────────────────────────────────────────
function getCircuitTemplate(logic = 'my_circuit', circuitType = 'basic') {
    const fnName = logic.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `// ────────────────────────────────────────────────────────────
// Arcane Studio  ·  Generated Circuit
// Logic:   ${logic}
// Type:    ${circuitType}
// ────────────────────────────────────────────────────────────
// Place this file inside your encrypted-ixs/ directory
// (created by arcium init) — NOT in src/lib.rs

use arcis_imports::*;

#[circuit]
pub fn ${fnName}(
    // Define encrypted private inputs:
    // input_a: ArcisU64,
    // input_b: ArcisU64,
) -> ArcisU64 {
    // TODO: Implement confidential computation
    //
    // Example patterns:
    //   Arithmetic:   input_a + input_b
    //   Comparison:   input_a.gt(input_b)
    //
    // The return value is decrypted and forwarded to your
    // Solana program's callback instruction.
    todo!()
}

// ── Solana program callback  (add this to src/lib.rs) ─────────
//
// #[program]
// pub mod ${fnName}_program {
//     use super::*;
//
//     pub fn ${fnName}_callback(
//         ctx: Context<${fnName.charAt(0).toUpperCase() + fnName.slice(1)}Callback>,
//         result: u64,                    // decrypted result from Arcium
//     ) -> Result<()> {
//         msg!("Confidential result: {}", result);
//         // Store, emit event, or trigger on-chain logic here
//         Ok(())
//     }
// }
`;
}
// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
class ArcaneProvider {
    getTreeItem(e) { return e; }
    async getChildren() {
        const item = new vscode.TreeItem('Launch Arcane Studio', vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'arcane.openDashboard', title: 'Open' };
        item.iconPath = new vscode.ThemeIcon('rocket');
        return [item];
    }
}
// ─── WEBVIEW ─────────────────────────────────────────────────────────────────
function getWebviewContent(state, platform) {
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';
    const osLabel = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux';
    const osCls = isWin ? 'os-win' : isMac ? 'os-mac' : 'os-lin';
    const installCmds = getInstallCommands(platform);
    const installCmdsJson = JSON.stringify(installCmds);
    const TOOLS = ['Rust', 'Solana', 'Arcium', 'Anchor', 'Node'];
    const sel = (net) => state.lastNetwork === net ? ' selected' : '';
    const toolRows = TOOLS.map(t => `
        <div class="tool-row" id="tool-${t}">
          <span class="tool-name">${t}</span>
          <span class="tool-ver mono" id="ver-${t}">checking...</span>
          <span class="badge badge-checking" id="badge-${t}">…</span>
          <button class="btn btn-sm inst-btn" id="inst-${t}" style="display:none"
            onclick="installTool('${t}')">⬡ Install</button>
        </div>`).join('');
    const obSteps = [
        { id: 'rust', num: 1, title: 'Install Rust', toolKey: 'Rust',
            desc: 'The language Solana and Arcium programs are written in.' },
        { id: 'solana', num: 2, title: 'Install Solana CLI', toolKey: 'Solana',
            desc: 'CLI tools for deploying programs, managing wallets, and talking to the network.' },
        { id: 'arcium', num: 3, title: 'Install Arcium CLI', toolKey: 'Arcium',
            desc: 'The arcium CLI handles building circuits, deploying MXEs, and running tests.' },
        { id: 'anchor', num: 4, title: 'Install Anchor', toolKey: 'Anchor',
            desc: 'The Anchor framework for Solana — required by Arcium projects.' },
        { id: 'node', num: 5, title: 'Install Node.js', toolKey: 'Node',
            desc: 'Required for running TypeScript client scripts that initialize computation definitions.' },
        { id: 'wallet', num: 6, title: 'Create a Wallet', toolKey: '',
            desc: 'Generate a keypair — your identity on Solana. Fund it with SOL to pay for deployment.' },
        { id: 'funds', num: 7, title: 'Get Test SOL (Airdrop)', toolKey: '',
            desc: 'Airdrop free test SOL on localnet or devnet so you can deploy programs.' },
    ];
    const obHtml = obSteps.map(s => `
      <div class="ob-step" id="ob-${s.id}">
        <div class="ob-num" id="ob-num-${s.id}">${s.num}</div>
        <div class="ob-info">
          <div class="ob-title">${s.title}</div>
          <div class="ob-desc">${s.desc}</div>
          <div class="ob-cmd-row" id="ob-cmd-${s.id}">
            <code class="ob-code" id="ob-code-${s.id}"></code>
            <button class="btn btn-sm" onclick="copyInstall('${s.id}')">⎘ Copy</button>
            <button class="btn btn-sm btn-cyan" onclick="runInstall('${s.id}', '${s.title}')">⬡ Run in Terminal</button>
          </div>
        </div>
        <div class="ob-status"><span class="badge badge-checking" id="ob-badge-${s.id}">…</span></div>
      </div>`).join('');
    const pidSection = state.lastProgramId
        ? `<div class="mono small" id="settingsPid" style="color:var(--green);word-break:break-all;margin-bottom:8px;">${state.lastProgramId}</div>
           <button class="btn btn-sm" onclick="copyText(document.getElementById('settingsPid').textContent)">⎘ Copy ID</button>`
        : `<div class="mono small" id="settingsPid" style="color:var(--muted);">— No program deployed yet</div>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Arcane Studio</title>
<style>
:root{--bg:#07080d;--surface:#0c0e18;--lift:#10121f;--border:rgba(0,229,255,.1);--cyan:#00e5ff;--purple:#7b2fff;--green:#00ff9d;--red:#ff3366;--amber:#ffaa00;--dim:#2e3450;--muted:#5a6890;--text:#c0ccee;--bright:#eef1fb;--font:-apple-system,'Segoe UI Variable','Segoe UI',system-ui,sans-serif;--mono:'Cascadia Code','Fira Code','Consolas','Monaco',monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;background-image:linear-gradient(rgba(0,229,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,.025) 1px,transparent 1px);background-size:28px 28px}
.header{display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(10,12,20,.97);border-bottom:1px solid var(--border);flex-shrink:0}
.logo{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:var(--cyan);letter-spacing:.14em;text-transform:uppercase}
.logo-hex{width:18px;height:18px;background:var(--cyan);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)}
.hdivider{flex:1}
.os-pill{font-size:9px;padding:2px 8px;border-radius:10px;font-family:var(--mono);font-weight:700;text-transform:uppercase;white-space:nowrap}
.os-win{background:rgba(0,120,212,.12);color:#4da6ff;border:1px solid rgba(0,120,212,.3)}
.os-mac{background:rgba(255,255,255,.06);color:#c0c0c0;border:1px solid rgba(255,255,255,.15)}
.os-lin{background:rgba(255,170,0,.08);color:var(--amber);border:1px solid rgba(255,170,0,.25)}
.status-pill{display:flex;align-items:center;gap:5px;padding:3px 10px;background:var(--lift);border:1px solid var(--border);border-radius:20px;font-size:10px;font-family:var(--mono);color:var(--muted);white-space:nowrap;transition:all .2s}
.status-pill.live{border-color:rgba(0,255,157,.3);color:var(--green)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--dim);flex-shrink:0;transition:all .3s}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.dot.live{background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
.wallet-chip{display:flex;align-items:center;gap:7px;padding:4px 11px;background:var(--lift);border:1px solid var(--border);border-radius:20px;font-size:10px;font-family:var(--mono);cursor:pointer;transition:border-color .2s;user-select:none}
.wallet-chip:hover{border-color:var(--cyan)}
.waddr{color:var(--muted);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbal{color:var(--cyan);font-weight:500}
.net-badge{font-size:9px;padding:2px 8px;border-radius:10px;font-family:var(--mono);font-weight:700;text-transform:uppercase;white-space:nowrap}
.net-local{background:rgba(123,47,255,.12);color:#b08aff;border:1px solid rgba(123,47,255,.3)}
.net-devnet{background:rgba(0,229,255,.08);color:var(--cyan);border:1px solid rgba(0,229,255,.25)}
.net-testnet{background:rgba(255,170,0,.08);color:var(--amber);border:1px solid rgba(255,170,0,.25)}
.net-mainnet{background:rgba(0,255,157,.06);color:var(--green);border:1px solid rgba(0,255,157,.2)}
.tab-bar{display:flex;gap:2px;padding:8px 16px 0;background:rgba(10,12,20,.9);border-bottom:1px solid var(--border);flex-shrink:0}
.tab{padding:6px 13px;font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);cursor:pointer;border-radius:4px 4px 0 0;border:1px solid transparent;border-bottom:none;margin-bottom:-1px;transition:all .15s;user-select:none}
.tab:hover{color:var(--text);background:var(--lift)}
.tab.active{color:var(--cyan);background:var(--surface);border-color:var(--border);border-bottom-color:var(--surface)}
.content{flex:1;overflow-y:auto;padding:13px 16px;scrollbar-width:thin;scrollbar-color:var(--dim) transparent}
.content::-webkit-scrollbar{width:3px}
.content::-webkit-scrollbar-thumb{background:var(--dim);border-radius:3px}
.panel{display:none}.panel.active{display:block}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:11px}.s2{grid-column:span 2}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;position:relative;overflow:hidden;transition:border-color .2s}
.card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(0,229,255,.025) 0%,transparent 55%);pointer-events:none}
.card:hover{border-color:rgba(0,229,255,.2)}
.ctitle{font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:5px}
.ctitle-icon{color:var(--cyan)}
.tip{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:var(--dim);border-radius:50%;font-size:8px;font-weight:800;color:var(--muted);cursor:help;position:relative;vertical-align:middle;margin-left:3px;flex-shrink:0;font-family:var(--font)}
.tip:hover{background:rgba(0,229,255,.15);color:var(--cyan)}
.tip::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);min-width:210px;max-width:270px;background:#12152a;border:1px solid rgba(0,229,255,.2);border-radius:6px;padding:9px 11px;font-size:10.5px;font-weight:400;color:var(--text);white-space:normal;z-index:300;line-height:1.55;letter-spacing:0;pointer-events:none;opacity:0;transition:opacity .15s;font-family:var(--font);text-transform:none}
.tip:hover::after{opacity:1}
.tip::before{content:'';position:absolute;left:50%;bottom:calc(100% + 3px);transform:translateX(-50%);border:5px solid transparent;border-top-color:#12152a;opacity:0;transition:opacity .15s;pointer-events:none}
.tip:hover::before{opacity:1}
.tool-grid{display:flex;flex-direction:column;gap:4px}
.tool-row{display:flex;align-items:center;gap:9px;padding:7px 10px;background:var(--lift);border-radius:5px;border:1px solid transparent;transition:border-color .15s}
.tool-row:hover{border-color:var(--border)}
.tool-name{font-size:11.5px;font-weight:500;min-width:52px}
.tool-ver{font-size:10px;font-family:var(--mono);color:var(--muted);flex:1}
.badge{font-size:9px;font-weight:700;letter-spacing:.07em;padding:2px 7px;border-radius:10px;text-transform:uppercase}
.badge-ok{background:rgba(0,255,157,.08);color:var(--green);border:1px solid rgba(0,255,157,.25)}
.badge-missing{background:rgba(255,51,102,.08);color:var(--red);border:1px solid rgba(255,51,102,.25)}
.badge-checking{background:rgba(255,170,0,.08);color:var(--amber);border:1px solid rgba(255,170,0,.2)}
.badge-done{background:rgba(0,255,157,.08);color:var(--green);border:1px solid rgba(0,255,157,.3)}
.inst-btn{margin-left:auto;flex-shrink:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:7px 13px;font-family:var(--font);font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;border:1px solid var(--border);border-radius:5px;background:var(--lift);color:var(--text);cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:hover{border-color:var(--cyan);color:var(--cyan);background:rgba(0,229,255,.04)}
.btn:active{transform:scale(.97)}.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-sm{padding:4px 9px;font-size:9px}.btn-full{width:100%}
.btn-cyan{background:rgba(0,229,255,.07);border-color:rgba(0,229,255,.4);color:var(--cyan)}
.btn-cyan:hover{background:rgba(0,229,255,.14);box-shadow:0 0 12px rgba(0,229,255,.1)}
.btn-green{background:rgba(0,255,157,.06);border-color:rgba(0,255,157,.3);color:var(--green)}
.btn-green:hover{background:rgba(0,255,157,.12)}
.btn-red{background:rgba(255,51,102,.06);border-color:rgba(255,51,102,.3);color:var(--red)}
.btn-red:hover{background:rgba(255,51,102,.12)}
.btn-amber{background:rgba(255,170,0,.06);border-color:rgba(255,170,0,.3);color:var(--amber)}
.btn-amber:hover{background:rgba(255,170,0,.12)}
.btn-purple{background:rgba(123,47,255,.07);border-color:rgba(123,47,255,.4);color:#b08aff}
.btn-purple:hover{background:rgba(123,47,255,.14)}
.btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.field{margin-bottom:9px}
.label{display:block;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
input,textarea,select{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:7px 10px;font-family:var(--mono);font-size:11px;color:var(--text);outline:none;transition:border-color .15s;resize:vertical}
input:focus,textarea:focus,select:focus{border-color:var(--cyan);box-shadow:0 0 0 2px rgba(0,229,255,.06)}
select{cursor:pointer}
.irow{display:flex;gap:8px;align-items:flex-end}.irow .field{flex:1;margin:0}
.ob-intro{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:13px 14px;margin-bottom:11px;position:relative;overflow:hidden}
.ob-intro::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(0,229,255,.025) 0%,transparent 55%);pointer-events:none}
.ob-list{display:flex;flex-direction:column;gap:7px}
.ob-step{display:flex;align-items:flex-start;gap:12px;padding:12px 13px;background:var(--lift);border-radius:7px;border:1px solid transparent;transition:border-color .2s,background .2s}
.ob-step.ob-done{border-color:rgba(0,255,157,.15);background:rgba(0,255,157,.025)}
.ob-step.ob-missing{border-color:rgba(255,51,102,.1)}
.ob-num{width:24px;height:24px;border-radius:50%;background:var(--bg);border:1px solid var(--dim);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--muted);flex-shrink:0;margin-top:1px;transition:all .2s}
.ob-done .ob-num{background:rgba(0,255,157,.1);border-color:rgba(0,255,157,.4);color:var(--green)}
.ob-info{flex:1;min-width:0}
.ob-title{font-size:13px;font-weight:600;color:var(--bright);margin-bottom:3px}
.ob-desc{font-size:10.5px;color:var(--muted);line-height:1.5;margin-bottom:8px}
.ob-cmd-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:var(--bg);border-radius:5px;border:1px solid var(--border)}
.ob-code{font-family:var(--mono);font-size:10px;color:var(--cyan);flex:1;word-break:break-all;min-width:0}
.ob-done .ob-cmd-row{display:none}
.ob-status{flex-shrink:0;padding-top:2px}
.node-bar{display:flex;align-items:center;gap:9px;padding:9px 11px;background:var(--lift);border-radius:5px;border:1px solid transparent;margin-bottom:10px}
.node-bar.live{border-color:rgba(0,255,157,.2)}
.node-txt{font-size:11.5px;flex:1;color:var(--muted)}.node-txt.live{color:var(--green)}
.nbadge{font-size:9.5px;font-family:var(--mono);font-weight:600;color:var(--dim);letter-spacing:.08em}
.nbadge.live{color:var(--green)}
.airdrop-quick{display:none;gap:6px;margin-top:8px;flex-wrap:wrap}
.airdrop-quick.show{display:flex}.airdrop-quick .btn{flex:1}
.wval-big{font-size:21px;font-weight:600;color:var(--bright)}
.pid-box{display:none;margin-top:10px;padding:9px 12px;background:rgba(0,255,157,.03);border:1px solid rgba(0,255,157,.2);border-radius:5px}
.pid-box.show{display:block}
.pid-val{font-family:var(--mono);font-size:11px;color:var(--green);word-break:break-all}
.step-list{display:flex;flex-direction:column;gap:6px}
.step-item{display:flex;align-items:flex-start;gap:10px;padding:12px 13px;background:var(--lift);border-radius:6px;border:1px solid transparent;transition:border-color .15s}
.step-item:hover{border-color:var(--border)}
.step-num{width:22px;height:22px;border-radius:50%;background:var(--bg);border:1px solid var(--dim);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--muted);flex-shrink:0;margin-top:2px}
.step-info{flex:1;min-width:0}
.step-ttl{font-size:12px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:4px;margin-bottom:3px}
.step-cmd{font-size:10px;color:var(--cyan);font-family:var(--mono);margin-bottom:5px}
.step-plain{font-size:10.5px;color:var(--muted);line-height:1.55;margin-bottom:9px}
.step-actions{display:flex;gap:6px;flex-wrap:wrap}
.notice{padding:9px 12px;background:rgba(123,47,255,.06);border:1px solid rgba(123,47,255,.25);border-radius:6px;font-size:10.5px;color:#c0aaff;line-height:1.55;margin-bottom:11px}
.notice strong{color:#d4bfff}
.sep{border:none;border-top:1px solid var(--border);margin:10px 0}
.small{font-size:10.5px;color:var(--muted);line-height:1.55}.mono{font-family:var(--mono)}
.log-section{flex-shrink:0;border-top:1px solid var(--border);background:rgba(6,7,12,.98)}
.log-hdr{display:flex;align-items:center;gap:7px;padding:5px 15px;cursor:pointer;user-select:none;font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid transparent;transition:color .15s}
.log-hdr:hover{color:var(--text)}.log-hdr.open{border-bottom-color:var(--border)}
.log-actions{margin-left:auto;display:flex;gap:5px}
.log-body{height:140px;overflow-y:auto;padding:6px 15px;font-family:var(--mono);font-size:10.5px;line-height:1.65;scrollbar-width:thin;scrollbar-color:var(--dim) transparent}
.log-body.closed{display:none}
.log-body::-webkit-scrollbar{width:3px}.log-body::-webkit-scrollbar-thumb{background:var(--dim)}
.log-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:1px}
.log-line .ts{color:var(--dim);flex-shrink:0;font-size:9.5px}
.info .msg{color:#6880b8}.success .msg{color:var(--green)}.error .msg{color:var(--red)}.warn .msg{color:var(--amber)}
.log-term-btn{font-size:8.5px;padding:1px 7px;border-radius:4px;background:rgba(255,51,102,.08);border:1px solid rgba(255,51,102,.2);color:var(--red);cursor:pointer;font-family:var(--font);font-weight:600;letter-spacing:.05em;transition:all .15s;flex-shrink:0}
.log-term-btn:hover{background:rgba(255,51,102,.2)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{width:10px;height:10px;border-radius:50%;border:2px solid rgba(0,229,255,.2);border-top-color:var(--cyan);animation:spin .7s linear infinite;display:inline-block;flex-shrink:0}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.panel.active .card{animation:fadeUp .2s ease both}
.panel.active .card:nth-child(2){animation-delay:.04s}.panel.active .card:nth-child(3){animation-delay:.08s}.panel.active .card:nth-child(4){animation-delay:.12s}
.panel.active .ob-step{animation:fadeUp .18s ease both}
.panel.active .ob-step:nth-child(2){animation-delay:.04s}.panel.active .ob-step:nth-child(3){animation-delay:.08s}.panel.active .ob-step:nth-child(4){animation-delay:.12s}.panel.active .ob-step:nth-child(5){animation-delay:.16s}.panel.active .ob-step:nth-child(6){animation-delay:.20s}.panel.active .ob-step:nth-child(7){animation-delay:.24s}
.panel.active .step-item{animation:fadeUp .18s ease both}
.panel.active .step-item:nth-child(2){animation-delay:.04s}.panel.active .step-item:nth-child(3){animation-delay:.08s}.panel.active .step-item:nth-child(4){animation-delay:.12s}.panel.active .step-item:nth-child(5){animation-delay:.16s}
</style>
</head>
<body>

<div class="header">
  <div class="logo"><div class="logo-hex"></div>Arcane Studio</div>
  <span class="${osCls} os-pill">${osLabel}</span>
  <span id="netBadge" class="net-badge net-local">localnet</span>
  <div class="hdivider"></div>
  <div class="wallet-chip" title="Click to copy address" onclick="copyAddr()">
    <span class="waddr mono" id="hdrAddr">no wallet</span>
    <span class="wbal" id="hdrBal">—</span>
  </div>
  <div class="status-pill" id="nodePill">
    <div class="dot" id="nodeDotH"></div>
    <span id="nodeTextH">OFFLINE</span>
  </div>
</div>

<div class="tab-bar">
  <div class="tab active" onclick="tab('start',this)">★ Start Here</div>
  <div class="tab" onclick="tab('status',this)">◉ Status</div>
  <div class="tab" onclick="tab('build',this)">⬡ Build</div>
  <div class="tab" onclick="tab('deploy',this)">↑ Deploy</div>
  <div class="tab" onclick="tab('arcium',this)">⬡ Arcium</div>
  <div class="tab" onclick="tab('settings',this)">◈ Settings</div>
</div>

<div class="content">

  <!-- START HERE -->
  <div id="panel-start" class="panel active">
    <div class="ob-intro">
      <div class="ctitle"><span class="ctitle-icon">★</span> Welcome to Arcane Studio</div>
      <div class="small">Walks you through setup — from installing tools to your first confidential circuit. Running on <strong style="color:var(--cyan)">${osLabel}</strong>. All commands open in a VS Code terminal.</div>
    </div>
    <div class="ob-list">${obHtml}</div>
  </div>

  <!-- STATUS -->
  <div id="panel-status" class="panel">
    <div class="g2">
      <div class="card s2">
        <div class="ctitle"><span class="ctitle-icon">◎</span> Environment Check <span class="tip" data-tip="Checks all required tools are installed and reachable in PATH. MISSING = click Install to open a terminal with the correct install command for your OS.">?</span></div>
        <div class="tool-grid">${toolRows}</div>
        <div class="btn-row"><button class="btn btn-sm" onclick="send('checkSystem')">↻ Re-check</button></div>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">⬡</span> Validator Node <span class="tip" data-tip="Local Solana blockchain on your machine. Free, instant, resets on restart. No real money involved.">?</span></div>
        <div class="node-bar" id="nodeBar"><div class="dot" id="nodeDot2"></div><div class="node-txt" id="nodeTxt">Offline — not running</div><span class="nbadge" id="nodeBadge">OFFLINE</span></div>
        <button class="btn btn-full" id="toggleBtn" onclick="send('toggleNode')">▶ Start Validator</button>
        <div class="small" style="margin-top:7px;opacity:.55">solana-test-validator --reset</div>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">◈</span> Wallet <span class="tip" data-tip="Public key = address (safe to share). Private key = never share. SOL pays for deploying programs.">?</span></div>
        <div class="field"><span class="label">Address</span><div id="walletAddr" class="mono small" style="color:var(--cyan);word-break:break-all;line-height:1.5">—</div></div>
        <div class="field"><span class="label">Balance</span><div class="wval-big" id="walletBal">—</div></div>
        <div class="btn-row">
          <button class="btn btn-sm" onclick="send('refresh')">↻ Sync</button>
          <button class="btn btn-sm btn-amber" onclick="toggleAirdrop()">⚡ Airdrop</button>
        </div>
        <div class="airdrop-quick" id="airdropRow">
          <button class="btn btn-sm btn-amber" onclick="doAirdrop(1)">1 SOL</button>
          <button class="btn btn-sm btn-amber" onclick="doAirdrop(2)">2 SOL</button>
          <button class="btn btn-sm btn-amber" onclick="doAirdrop(5)">5 SOL</button>
          <button class="btn btn-sm" onclick="toggleAirdrop()">✕</button>
        </div>
      </div>
    </div>
  </div>

  <!-- BUILD -->
  <div id="panel-build" class="panel">
    <div class="g2">
      <div class="card s2">
        <div class="ctitle"><span class="ctitle-icon">⬡</span> Circuit Scaffold <span class="tip" data-tip="Generates starter Arcis code. Output goes in encrypted-ixs/ (created by arcium init). Arcis looks like Rust and compiles to circuit bytecode.">?</span></div>
        <div class="g2">
          <div class="field"><label class="label">Logic / Purpose</label><textarea id="scaffoldLogic" rows="3" placeholder="e.g. private voting, sealed auction, encrypted sum..."></textarea></div>
          <div class="field"><label class="label">Circuit Type</label>
            <select id="circuitType">
              <option value="basic">Basic</option><option value="aggregation">Aggregation</option>
              <option value="comparison">Comparison</option><option value="voting">Private Voting</option>
              <option value="auction">Sealed Bid Auction</option><option value="zkml">ZK-ML Inference</option>
            </select>
          </div>
        </div>
        <button class="btn btn-cyan" onclick="scaffold()">⬡ Generate Circuit Scaffold</button>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">⚙</span> Compile <span class="tip" data-tip="For Arcium projects use 'arcium build' in the Arcium tab — it compiles circuits too. cargo build-sbf is for plain Solana programs only.">?</span></div>
        <div class="small" style="margin-bottom:10px">For Arcium projects use <code class="mono" style="color:var(--cyan)">arcium build</code> (Arcium tab). This button is for plain Solana programs.</div>
        <button class="btn btn-cyan btn-full" id="buildBtn" onclick="send('build')">⚙ cargo build-sbf</button>
        <div class="btn-row">
          <button class="btn btn-sm" onclick="send('clippy')">🔍 Lint (clippy)</button>
          <button class="btn btn-sm btn-green" onclick="send('test')">✓ cargo test</button>
        </div>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">📦</span> Dependencies</div>
        <div class="irow"><div class="field"><label class="label">Package Name</label><input type="text" id="depName" placeholder="arcium-sdk  /  some-npm-pkg"></div></div>
        <div class="btn-row">
          <button class="btn btn-sm btn-cyan" onclick="install('cargo')">cargo add</button>
          <button class="btn btn-sm" onclick="install('npm')">npm install</button>
        </div>
        <hr class="sep">
        <div class="small" style="margin-bottom:6px;opacity:.65">Quick-add Arcium packages</div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-sm btn-purple" onclick="qi('arcium-sdk')">arcium-sdk</button>
          <button class="btn btn-sm btn-purple" onclick="qi('arcium-macros')">arcium-macros</button>
        </div>
      </div>
    </div>
  </div>

  <!-- DEPLOY -->
  <div id="panel-deploy" class="panel">
    <div class="g2">
      <div class="card s2">
        <div class="ctitle"><span class="ctitle-icon">↑</span> Deploy Solana Program <span class="tip" data-tip="For Arcium projects, prefer the Arcium tab — 'arcium deploy' also sets up your MXE in the same command. Use this for plain Solana deploys only.">?</span></div>
        <div class="field"><label class="label">.so File Path (leave blank to auto-detect in target/deploy)</label><input type="text" id="soPath" placeholder="target/deploy/my_program.so"></div>
        <button class="btn btn-green" onclick="deployProgram()">↑ solana program deploy</button>
        <div class="pid-box" id="pidBox">
          <span class="label" style="display:inline-block;margin-bottom:3px">Deployed Program ID</span>
          <div class="pid-val" id="pidVal"></div>
          <div class="btn-row" style="margin-top:7px"><button class="btn btn-sm" onclick="copyText(document.getElementById('pidVal').textContent)">⎘ Copy ID</button></div>
        </div>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">◎</span> Deployed Programs</div>
        <div class="small" style="margin-bottom:10px">List all programs deployed by your wallet on the current network.</div>
        <button class="btn btn-sm btn-cyan" onclick="send('showPrograms')">solana program show</button>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">◎</span> Network <span class="tip" data-tip="Localnet = your machine (free, instant). Devnet = public test network (free airdrop SOL). Mainnet = real money, permanent.">?</span></div>
        <div class="small" style="margin-bottom:9px">Switch the active Solana cluster.</div>
        <select id="networkSelect" onchange="send('setNetwork',{network:this.value})">
          <option value="localnet"${sel('localnet')}>Localnet — 127.0.0.1:8899</option>
          <option value="devnet"${sel('devnet')}>Devnet</option>
          <option value="testnet"${sel('testnet')}>Testnet</option>
          <option value="mainnet"${sel('mainnet')}>Mainnet-Beta ⚠</option>
        </select>
      </div>
    </div>
  </div>

  <!-- ARCIUM — correct 5-step workflow -->
  <div id="panel-arcium" class="panel">
    <div class="card">
      <div class="ctitle"><span class="ctitle-icon">⬡</span> Arcium Workflow — 5 steps to a live confidential circuit</div>
      <div class="notice"><strong>Run these steps in order.</strong> Steps 1–3 can be done without a funded wallet. Steps 4 and 5 require SOL on the target network.</div>
      <div class="step-list">

        <div class="step-item">
          <div class="step-num">1</div>
          <div class="step-info">
            <div class="step-ttl">Initialize Project <span class="tip" data-tip="Creates your Anchor workspace, Arcium.toml config, and the encrypted-ixs/ directory where Arcis circuit files live. No extra init steps needed after this.">?</span></div>
            <div class="step-cmd">arcium init &lt;project-name&gt;</div>
            <div class="step-plain">Creates <code class="mono" style="color:var(--cyan)">Arcium.toml</code> and <code class="mono" style="color:var(--cyan)">encrypted-ixs/</code>. This is the only initialization command — there is no separate init-arcis or config step.</div>
            <div class="irow" style="margin-bottom:9px">
              <div class="field" style="margin:0;flex:1"><label class="label">Project Name</label><input type="text" id="arciumProjectName" placeholder="my_arcium_project"></div>
            </div>
            <div class="step-actions"><button class="btn btn-sm btn-purple" onclick="arciumInit()">▶ Run</button></div>
          </div>
        </div>

        <div class="step-item">
          <div class="step-num">2</div>
          <div class="step-info">
            <div class="step-ttl">Build Circuits &amp; Program <span class="tip" data-tip="Compiles your Arcis circuits to bytecode and generates .idarc callback interface files, then builds the Solana program. Use this instead of cargo build-sbf for Arcium projects.">?</span></div>
            <div class="step-cmd">arcium build</div>
            <div class="step-plain">Compiles Arcis → bytecode + <code class="mono" style="color:var(--cyan)">.idarc</code> interface files, then builds the Solana program. Run after every circuit change.</div>
            <div class="step-actions">
              <button class="btn btn-sm btn-cyan" id="arciumBuildBtn" onclick="send('arciumBuild')">▶ arcium build</button>
              <button class="btn btn-sm" onclick="send('arciumTest')">✓ arcium test</button>
            </div>
          </div>
        </div>

        <div class="step-item">
          <div class="step-num">3</div>
          <div class="step-info">
            <div class="step-ttl">Test Locally <span class="tip" data-tip="Spins up a local MPC cluster and runs your TypeScript tests against it. Catches issues before deploying to devnet.">?</span></div>
            <div class="step-cmd">arcium test</div>
            <div class="step-plain">Runs TypeScript tests against a local MPC cluster. Verifies your circuits and callbacks work before spending SOL on a real deploy.</div>
            <div class="step-actions"><button class="btn btn-sm btn-green" onclick="send('arciumTest')">▶ arcium test</button></div>
          </div>
        </div>

        <div class="step-item">
          <div class="step-num">4</div>
          <div class="step-info">
            <div class="step-ttl">Deploy MXE <span class="tip" data-tip="One command that deploys your Solana program, initializes the MXE account on-chain, links it to an MPC cluster, creates key recovery material, and sets up the mempool automatically. Devnet cluster-offset = 456.">?</span></div>
            <div class="step-cmd">arcium deploy --cluster-offset 456 --recovery-set-size 4 --mempool-size Medium</div>
            <div class="step-plain">All-in-one: program + MXE + mempool in a single command. The mempool is created automatically — there is no separate create-mempool or fund-mxe command.</div>
            <div class="g2" style="margin-bottom:9px;gap:8px">
              <div class="field" style="margin:0"><label class="label">Cluster Offset <span class="tip" data-tip="Identifies the MPC cluster to use. Devnet = 456. Check Arcium docs for other networks.">?</span></label><input type="text" id="arciumClusterOffset" value="456" placeholder="456"></div>
              <div class="field" style="margin:0"><label class="label">Recovery Set Size <span class="tip" data-tip="Number of nodes in the key recovery set. Standard for devnet = 4.">?</span></label><input type="text" id="arciumRecoverySize" value="4" placeholder="4"></div>
              <div class="field" style="margin:0"><label class="label">Mempool Size <span class="tip" data-tip="Computation queue capacity. Medium is a safe default.">?</span></label>
                <select id="arciumMempoolSize"><option value="Small">Small</option><option value="Medium" selected>Medium</option><option value="Large">Large</option></select>
              </div>
              <div class="field" style="margin:0"><label class="label">RPC URL (optional)</label><input type="text" id="arciumRpcUrl" placeholder="https://api.devnet.solana.com"></div>
            </div>
            <div class="step-actions"><button class="btn btn-sm btn-green" id="arciumDeployBtn" onclick="arciumDeploy()">▶ arcium deploy</button></div>
            <div class="pid-box" id="arciumPidBox" style="margin-top:9px">
              <span class="label" style="display:inline-block;margin-bottom:3px">Program ID</span>
              <div class="pid-val" id="arciumPidVal"></div>
              <button class="btn btn-sm" style="margin-top:7px" onclick="copyText(document.getElementById('arciumPidVal').textContent)">⎘ Copy</button>
            </div>
          </div>
        </div>

        <div class="step-item">
          <div class="step-num">5</div>
          <div class="step-info">
            <div class="step-ttl">Initialize Computation Definition <span class="tip" data-tip="No arcium CLI command for this. You call your Solana program's init_comp_def instruction via a TypeScript script using @arcium-hq/client. This tells the Arcium network what encrypted operations your MXE can perform.">?</span></div>
            <div class="step-cmd">npx ts-node scripts/init_comp_def.ts  (client-side — no arcium CLI command)</div>
            <div class="step-plain">
              Call your program's <code class="mono" style="color:var(--cyan)">init_comp_def</code> instruction using the <code class="mono" style="color:var(--cyan)">@arcium-hq/client</code> TypeScript SDK.
              Create <code class="mono" style="color:var(--cyan)">scripts/init_comp_def.ts</code> — the studio will find it automatically.
              If circuits are too large for on-chain storage, upload the <code class="mono" style="color:var(--cyan)">.arcis</code> file to IPFS/S3 and use the <code class="mono" style="color:var(--cyan)">circuit_hash!</code> macro.
            </div>
            <div class="field" style="margin-bottom:9px"><label class="label">Script Path (auto-detects scripts/init_comp_def.ts)</label><input type="text" id="arciumInitScript" placeholder="scripts/init_comp_def.ts"></div>
            <div class="step-actions">
              <button class="btn btn-sm btn-amber" onclick="arciumInitCompDef()">▶ Run Init Script</button>
              <button class="btn btn-sm" onclick="sendTerminal('npm install @arcium-hq/client','Install Arcium SDK')">+ Install @arcium-hq/client</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- SETTINGS -->
  <div id="panel-settings" class="panel">
    <div class="g2">
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">◈</span> Keypair Management <span class="tip" data-tip="Public key = wallet address (safe to share). Private key = never share. CLI needs a keypair to sign every transaction.">?</span></div>
        <div class="small" style="margin-bottom:9px">Generate a fresh keypair in your workspace or point the CLI at an existing one.</div>
        <button class="btn btn-sm btn-cyan btn-full" onclick="send('generateKeypair')" style="margin-bottom:8px">Generate id.json in workspace</button>
        <hr class="sep">
        <div class="field"><label class="label">Custom Keypair Path</label><input type="text" id="kpPath" placeholder="~/.config/solana/id.json" value="${state.lastKeypairPath || ''}"></div>
        <button class="btn btn-sm btn-full" onclick="setKp()" style="margin-top:6px">Set Keypair</button>
      </div>
      <div class="card">
        <div class="ctitle"><span class="ctitle-icon">◎</span> RPC Endpoints</div>
        <div class="field"><label class="label">Localnet</label><input type="text" value="http://127.0.0.1:8899" readonly></div>
        <div class="field"><label class="label">Devnet</label><input type="text" value="https://api.devnet.solana.com" readonly></div>
        <div class="field"><label class="label">Testnet</label><input type="text" value="https://api.testnet.solana.com" readonly></div>
        <div class="field"><label class="label">Mainnet</label><input type="text" value="https://api.mainnet-beta.solana.com" readonly></div>
      </div>
      <div class="card s2">
        <div class="ctitle"><span class="ctitle-icon">◎</span> Last Deployed Program</div>
        <div class="small" style="margin-bottom:8px">Program ID from your most recent deployment — persisted across VS Code sessions.</div>
        ${pidSection}
      </div>
    </div>
  </div>

</div>

<div class="log-section">
  <div class="log-hdr open" id="logHdr" onclick="toggleLog()">
    <div class="dot live"></div>
    Terminal Output
    <span class="mono" id="logCnt" style="color:var(--dim);margin-left:4px">0</span>
    <div class="log-actions">
      <button class="btn btn-sm" style="padding:2px 8px;font-size:9px"
        onclick="event.stopPropagation();clearLog()">Clear</button>
    </div>
  </div>
  <div id="logBody" class="log-body"></div>
</div>

<script>
const vscode=acquireVsCodeApi();
var INSTALL_CMDS=${installCmdsJson};
var OB_CMDS={rust:INSTALL_CMDS['Rust'],solana:INSTALL_CMDS['Solana'],arcium:INSTALL_CMDS['Arcium'],anchor:INSTALL_CMDS['Anchor'],node:INSTALL_CMDS['Node'],wallet:'solana-keygen new --no-bip39-passphrase',funds:'solana airdrop 2'};
var TOOL_TO_OB={Rust:'rust',Solana:'solana',Arcium:'arcium',Anchor:'anchor',Node:'node'};
var logLines=0,logOpen=true;
function send(cmd,extra){extra=extra||{};vscode.postMessage(Object.assign({command:cmd},extra));}
function sendTerminal(cmd,name){send('openTerminal',{cmd:cmd,name:name||'Arcane Studio'});}
function tab(name,el){document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});document.getElementById('panel-'+name).classList.add('active');el.classList.add('active');}
function copyText(text){if(!text)return;try{navigator.clipboard.writeText(text);}catch(e){var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}appendLog('Copied to clipboard.','success');}
function copyAddr(){var a=document.getElementById('walletAddr').textContent;if(a&&a!=='—')copyText(a);}
function toggleLog(){logOpen=!logOpen;document.getElementById('logBody').classList.toggle('closed',!logOpen);document.getElementById('logHdr').classList.toggle('open',logOpen);}
function clearLog(){document.getElementById('logBody').innerHTML='';logLines=0;document.getElementById('logCnt').textContent='0';}
function appendLog(text,type,failCmd){
  type=type||'info';failCmd=failCmd||'';
  var body=document.getElementById('logBody');
  var ts=new Date().toLocaleTimeString('en-US',{hour12:false});
  var row=document.createElement('div');row.className='log-line '+type;
  var tsSpan=document.createElement('span');tsSpan.className='ts';tsSpan.textContent=ts;
  var msgSpan=document.createElement('span');msgSpan.className='msg';msgSpan.textContent=text;
  row.appendChild(tsSpan);row.appendChild(msgSpan);
  if(failCmd&&type==='error'){var btn=document.createElement('button');btn.className='log-term-btn';btn.textContent='Open in Terminal';(function(c){btn.addEventListener('click',function(){sendTerminal(c,'Arcane Terminal');});})(failCmd);row.appendChild(btn);}
  body.appendChild(row);body.scrollTop=body.scrollHeight;
  document.getElementById('logCnt').textContent=String(++logLines);
}
function toggleAirdrop(){document.getElementById('airdropRow').classList.toggle('show');}
function doAirdrop(n){send('airdrop',{amount:String(n)});document.getElementById('airdropRow').classList.remove('show');}
function scaffold(){send('scaffold',{logic:document.getElementById('scaffoldLogic').value.trim()||'my_circuit',circuitType:document.getElementById('circuitType').value});}
function install(pkgType){send('install',{pkgType:pkgType,name:document.getElementById('depName').value.trim()});}
function qi(name){document.getElementById('depName').value=name;install('cargo');}
function deployProgram(){send('deploy',{soPath:document.getElementById('soPath').value.trim()});}
function setKp(){send('setKeypair',{kpPath:document.getElementById('kpPath').value.trim()});}
function arciumInit(){send('arciumInit',{projectName:document.getElementById('arciumProjectName').value.trim()});}
function arciumDeploy(){
  var btn=document.getElementById('arciumDeployBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Deploying…';
  send('arciumDeploy',{clusterOffset:document.getElementById('arciumClusterOffset').value.trim(),recoverySize:document.getElementById('arciumRecoverySize').value.trim(),mempoolSize:document.getElementById('arciumMempoolSize').value,rpcUrl:document.getElementById('arciumRpcUrl').value.trim()});
}
function arciumInitCompDef(){send('arciumInitCompDef',{scriptPath:document.getElementById('arciumInitScript').value.trim()});}
(function initObCodes(){for(var id in OB_CMDS){var el=document.getElementById('ob-code-'+id);if(el)el.textContent=OB_CMDS[id];}})();
function copyInstall(obId){copyText(OB_CMDS[obId]||'');}
function runInstall(obId,title){var cmd=OB_CMDS[obId];if(cmd)sendTerminal(cmd,'Install: '+title);}
function installTool(toolName){var cmd=INSTALL_CMDS[toolName];if(cmd)sendTerminal(cmd,'Install '+toolName);}
function updateObStep(obId,status){
  var step=document.getElementById('ob-'+obId);var badge=document.getElementById('ob-badge-'+obId);var num=document.getElementById('ob-num-'+obId);
  if(!step)return;
  step.classList.remove('ob-done','ob-missing');
  if(status==='ok'||status==='done'){step.classList.add('ob-done');if(badge){badge.className='badge badge-done';badge.textContent='✓ Done';}if(num)num.textContent='✓';}
  else if(status==='missing'){step.classList.add('ob-missing');if(badge){badge.className='badge badge-missing';badge.textContent='Missing';}}
  else{if(badge){badge.className='badge badge-checking';badge.textContent='…';}}
}
window.addEventListener('message',function(event){
  var m=event.data;
  switch(m.command){
    case 'log': appendLog(m.text,m.type||'info',m.failCmd||''); break;
    case 'toolStatus':{
      var badge=document.getElementById('badge-'+m.name);
      var ver=document.getElementById('ver-'+m.name);
      var instBtn=document.getElementById('inst-'+m.name);
      if(badge){
        if(m.status==='ok'){badge.className='badge badge-ok';badge.textContent='OK';if(ver)ver.textContent=m.version;if(instBtn)instBtn.style.display='none';}
        else{badge.className='badge badge-missing';badge.textContent='MISSING';if(ver)ver.textContent='not found';if(instBtn)instBtn.style.display='';}
      }
      var obId=TOOL_TO_OB[m.name];if(obId)updateObStep(obId,m.status);
      break;
    }
    case 'sync':{
      var live=m.nodeStatus==='LIVE';
      var short=m.addr?m.addr.slice(0,6)+'…'+m.addr.slice(-4):'no wallet';
      var hasAddr=!!m.addr;var hasBal=m.bal&&m.bal!=='0 SOL'&&m.bal!=='0'&&m.bal!=='';
      document.getElementById('hdrAddr').textContent=short;document.getElementById('hdrBal').textContent=m.bal||'—';
      var pill=document.getElementById('nodePill');pill.className='status-pill'+(live?' live':'');
      document.getElementById('nodeTextH').textContent=m.nodeStatus;document.getElementById('nodeDotH').className='dot'+(live?' live':'');
      document.getElementById('walletAddr').textContent=m.addr||'—';document.getElementById('walletBal').textContent=m.bal||'—';
      var bar=document.getElementById('nodeBar');bar.className='node-bar'+(live?' live':'');
      document.getElementById('nodeDot2').className='dot'+(live?' live':'');
      document.getElementById('nodeTxt').className='node-txt'+(live?' live':'');document.getElementById('nodeTxt').textContent=live?'Running — local testnet LIVE':'Offline — not running';
      document.getElementById('nodeBadge').className='nbadge'+(live?' live':'');document.getElementById('nodeBadge').textContent=m.nodeStatus;
      var tb=document.getElementById('toggleBtn');tb.textContent=live?'⏹ Stop Validator':'▶ Start Validator';tb.className='btn btn-full '+(live?'btn-red':'');
      var net=m.network||'';var label='localnet',cls='net-local';
      if(net.indexOf('devnet')!==-1){label='devnet';cls='net-devnet';}else if(net.indexOf('testnet')!==-1){label='testnet';cls='net-testnet';}else if(net.indexOf('mainnet')!==-1){label='mainnet';cls='net-mainnet';}
      var nb=document.getElementById('netBadge');nb.textContent=label;nb.className='net-badge '+cls;
      updateObStep('wallet',hasAddr?'ok':'missing');updateObStep('funds',hasBal?'ok':(hasAddr?'missing':'checking'));
      break;
    }
    case 'programId':{
      document.getElementById('pidVal').textContent=m.id;document.getElementById('pidBox').classList.add('show');
      document.getElementById('arciumPidVal').textContent=m.id;document.getElementById('arciumPidBox').classList.add('show');
      var sp=document.getElementById('settingsPid');if(sp)sp.textContent=m.id;
      break;
    }
    case 'buildState':{
      var btn=document.getElementById('buildBtn');
      if(m.state==='building'){btn.disabled=true;btn.innerHTML='<span class="spin"></span> Building…';}
      else{btn.disabled=false;btn.textContent='⚙ cargo build-sbf';}
      break;
    }
    case 'arciumBuildState':{
      var abtn=document.getElementById('arciumBuildBtn');if(!abtn)break;
      if(m.state==='building'){abtn.disabled=true;abtn.innerHTML='<span class="spin"></span> Building…';}
      else{abtn.disabled=false;abtn.textContent='▶ arcium build';}
      break;
    }
    case 'arciumDeployState':{
      var adBtn=document.getElementById('arciumDeployBtn');if(!adBtn)break;
      if(m.state==='idle'){adBtn.disabled=false;adBtn.textContent='▶ arcium deploy';}
      break;
    }
  }
});
send('ready');
</script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map