// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { parseCodeScanResultForFile } from './codescan';
import { copySqlFiles, emptyDirectory } from './fileUtils';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let globalTmpDir: string;
let proc: any;
let workspacePath = '';

const config = vscode.workspace.getConfiguration();

const outputChannel = vscode.window.createOutputChannel('sqlcl codescan');
outputChannel.show(true);

const documentCallback = (document: vscode.TextDocument) => {
  if (document.languageId !== 'plsql' && document.languageId !== 'sql' && document.languageId !== 'oraclesql') { return; } // Only process JSON files
  const originalPath = document.uri.fsPath;

  let relativePath = document.uri.fsPath;
  relativePath = document.uri.fsPath.replace(workspacePath, '');
  relativePath = relativePath.substring(1);
  const targetDir = path.dirname(path.join(globalTmpDir, relativePath));
  if (!fs.existsSync(targetDir)) { // if target directory does not exist
    fs.mkdirSync(targetDir, { recursive: true }); // create it
  }

  const copyPath = path.join(targetDir, path.basename(originalPath));

  fs.copyFileSync(originalPath, copyPath);

  if (proc) {
    const options = ['-path .', '-format json', '-output tmp.json'];
    // const settingsPath = config.get('sqlclCodescan.settingsPath');
    // if (settingsPath) {
    //   const absPath = path.join(workspacePath, settingsPath);
    //   if (fs.existsSync(absPath)) {
    //     options.push(`-settings "${absPath}"`);
    //   } else {
    //     console.warn(`settings file ${absPath} does not exist`);
    //   }
    // }
    const joined = options.join(' ');
    proc.stdin.write(`codescan ${joined}\n`);
  }
};

if (config.get('sqlclCodescan.checkOnOpen')) {
  vscode.workspace.onDidOpenTextDocument(documentCallback);
}
if (config.get('sqlclCodescan.checkOnSave')) {
  vscode.workspace.onDidSaveTextDocument(documentCallback);
}

const callbacks: {
  [Key: string]: any;
} = {};

const executeCommand = async function executeCommand(commandString: string) {
  const rndName = Math.random().toString(36).substring(7);
  let cmd = commandString;
  cmd += `\nPRO ${rndName}\n`;
  return new Promise((resolve) => {
    callbacks[rndName] = resolve;
    proc.stdin.write(`${cmd}\n`);
  });
};

let useTvdFormat = false;
let useArbori = false;
let arboriPath = '';

const load = async function load() {
  if (vscode.workspace?.workspaceFolders?.length) {
    workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  // globalTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcl-codescan'));
  let command = 'sql';
  const configPath = config.get('sqlclCodescan.sqlClPath');
  if (configPath) {
    command = configPath as string;
  }
  outputChannel.appendLine(`Using sqlcl command: ${command}`);
  const foundRightVersion = await new Promise((resolve) => {
    exec(`${command} -V`, (error, stdout) => {
      if (error) {
        vscode.window.showErrorMessage(`SQLcl Codescan: ${error.message}`);
        resolve(false);
        return;
      }
      const match = stdout.match(/Build:\s+(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      const [, major, minor, patch, build, revision] = match || [];

      outputChannel.appendLine(`SQLcl version: ${major}.${minor}.${patch}.${build}.${revision}`);
      if (parseInt(major, 10) + (parseInt(minor, 10) / 10) < 23.3) {
        vscode.window.showErrorMessage('SQLcl Codescan: SQLcl version must be version 23.3 or higher');
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
  if (!foundRightVersion) {
    return;
  }
  const formattingEnabled = config.get('sqlclCodescan.enableFormatting');

  proc = spawn(`${command} /nolog`, { cwd: globalTmpDir, shell: true });

  let ready = false;
  const onReady = () => {
    if (formattingEnabled) {
      outputChannel.appendLine('Formatting enabled');
      const formatRulePath = config.get('sqlclCodescan.formattingRulePath');
      if (formatRulePath) {
        const formatPath = path.join(workspacePath, 'trivadis_advanced_format.xml');
        executeCommand(`format RULES ${formatPath};`);
        outputChannel.appendLine(`Using formatting rules from ${formatRulePath}`);
      }
      const tvdFormatterPath = config.get('sqlclCodescan.tvdFormatterPath');
      if (tvdFormatterPath) {
        outputChannel.appendLine(`Using tvd formatter from ${tvdFormatterPath}`);
        useTvdFormat = true;
        const customRules = path.join(workspacePath, tvdFormatterPath);
        executeCommand(`script ${customRules} --register`);
        const arboriPathLocal = config.get('sqlclCodescan.tvdArboriPath');
        if (arboriPathLocal) {
          outputChannel.appendLine(`Using arbori advanced formatting script from ${arboriPathLocal}`);
          useArbori = true;
          arboriPath = path.join(workspacePath, arboriPathLocal);
        }
      }
    }
  };
  proc.stdout.on('data', (data: any) => {
    console.log(`stdout: ${data}`);
    const str = data.toString();
    if (!ready && (str.indexOf('SQL>') > -1)) {
      ready = true;
      onReady();
    }
    if (!ready) {
      return;
    }
    if (fs.existsSync(path.join(globalTmpDir, 'tmp.json'))) {
      const warnings = JSON.parse(fs.readFileSync(path.resolve(path.join(globalTmpDir, 'tmp.json')), 'utf8'));
      warnings.forEach((p: any) => {
        const fname = p.file.replace(/^.\//, '');
        const uri = vscode.Uri.file(path.join(workspacePath, fname));
        console.log(`adding warning to ${fname}`);
        vscode.workspace.openTextDocument(uri).then((doc) => {
          parseCodeScanResultForFile(workspacePath, fname, p, doc);
        });
      });
      emptyDirectory(globalTmpDir);
    }
    const dataStr: string = data.toString().replace(/\n$/, '');
    const cb = callbacks[dataStr];
    if (cb) {
      cb();
      delete callbacks[dataStr];
    }
  });
  proc.stderr.on('data', (data: any) => {
    console.log(`stderr: ${data}`);
    const str = data.toString();
    if (!ready && (str.indexOf('SQL>') > -1)) {
      ready = true;
      onReady();
    }
  });

  if (formattingEnabled) {
    vscode.languages.registerDocumentFormattingEditProvider(['plsql', 'sql', 'oraclesql'], {
      async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
      ): Promise<vscode.TextEdit[]> {
        const { fsPath } = document.uri;
        // const fullSourcePath = path.join(workspacePath, fsPath);
        const rndName = Math.random().toString(36).substring(7);
        const outPath = path.join(globalTmpDir, `${rndName}.sql`);
        if (!useTvdFormat) {
          await executeCommand(`format file ${fsPath} ${outPath};`);
        } else {
          const inPath = path.join(globalTmpDir, `in_${rndName}.sql`);
          fs.copyFileSync(fsPath, inPath);
          if (!useArbori) {
            await executeCommand(`tvdformat ${inPath}`);
          } else {
            await executeCommand(`tvdformat ${inPath} arbori=${arboriPath}`);
          }
          fs.copyFileSync(inPath, outPath);
          fs.unlinkSync(inPath);
        }
        const formatted = fs.readFileSync(outPath, 'utf8');
        fs.unlinkSync(outPath);
        // debugger;
        return [{
          range: new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(document.lineCount + 1, 0),
          ),
          newText: formatted,
        }];
      },
    });
    vscode.languages.registerDocumentRangeFormattingEditProvider(['plsql', 'sql', 'oraclesql'], {
      async provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
      ): Promise<vscode.TextEdit[]> {
        const tmpText = document.getText(range);
        // const fullSourcePath = path.join(workspacePath, fsPath);
        const rndName = Math.random().toString(36).substring(7);
        const inPath = path.join(globalTmpDir, `in_${rndName}.sql`);
        const outPath = path.join(globalTmpDir, `${rndName}.sql`);
        fs.writeFileSync(inPath, tmpText);
        if (!useTvdFormat) {
          await executeCommand(`format file ${inPath} ${outPath};`);
        } else {
          if (!useArbori) {
            await executeCommand(`tvdformat ${inPath}`);
          } else {
            await executeCommand(`tvdformat ${inPath} arbori=${arboriPath}`);
          }
          fs.copyFileSync(inPath, outPath);
          fs.unlinkSync(inPath);
        }
        const formatted = fs.readFileSync(outPath, 'utf8');
        fs.unlinkSync(inPath);
        fs.unlinkSync(outPath);
        return [{
          range,
          newText: formatted,
        }];
      },
    });
  }
};

const unload = function unload() {
  if (proc) {
    proc.stdin.end();
  }
  if (fs.existsSync(globalTmpDir)) {
    fs.rm(globalTmpDir, { recursive: true });
  }
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "sqlcl-codescan" is now active!');
  if (context.storageUri) {
    if (!fs.existsSync(context.storageUri.fsPath)) {
      // create target directory
      fs.mkdirSync(context.storageUri.fsPath, { recursive: true });
    }
    globalTmpDir = context.storageUri.fsPath;
  } else {
    globalTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcl-codescan'));
  }
  load();
  const disposable = vscode.commands.registerCommand('sqlclCodescan.enable', () => {
    load();
  });
  const unloadCommand = vscode.commands.registerCommand('sqlclCodescan.disable', () => {
    unload();
  });
  const scanWorkspace = vscode.commands.registerCommand('sqlclCodescan.scanWorkspace', () => {
    if (proc) {
      copySqlFiles(workspacePath, globalTmpDir);
      const options = ['-path .', '-format json', '-output tmp.json'];
      //   const settingsPath = config.get('sqlclCodescan.settingsPath');
      //   if (settingsPath) {
      //     const absPath = path.join(workspacePath, settingsPath);
      //     if (fs.existsSync(absPath)) {
      //       options.push(`-settings "${absPath}"`);
      //     } else {
      //       console.warn(`settings file ${absPath} does not exist`);
      //     }
      //   }
      const joined = options.join(' ');
      proc.stdin.write(`codescan ${joined}\n`);
    }
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(scanWorkspace);
  context.subscriptions.push(unloadCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {
  unload();
}
