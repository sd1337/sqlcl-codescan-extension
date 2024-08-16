import { exec } from 'child_process';
import * as vscode from 'vscode';
import { getCollection, parseCodeScanResultForFile } from './codescan';
import { copySqlFiles, emptyDirectory } from './fileUtils';
import { onReady as formattingOnReady } from './formatting';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let globalTmpDir: string;
let proc: any;
let workspacePath = '';
const scanResultName = 'tmp.json';

let config = vscode.workspace.getConfiguration();

const outputChannel = vscode.window.createOutputChannel('sqlcl codescan');
outputChannel.show(true);

const writeInput = (str: string) => {
  if (proc) {
    proc.stdin.write(str);
  }
};

const callbacks: {
  [Key: string]: any;
} = {};

const executeCommand = async function executeCommand(commandString: string): Promise<string> {
  const rndName = Math.random().toString(36).substring(7);
  let cmd = commandString;
  cmd += `\nPRO $$${rndName}\n`;
  return new Promise((resolve) => {
    callbacks[rndName] = resolve;
    writeInput(`${cmd}\n`);
  });
};

const documentCallback = async (document: vscode.TextDocument) => {
  if (document.languageId !== 'plsql' && document.languageId !== 'sql' && document.languageId !== 'oraclesql' && document.languageId !== 'oracle_sql') { return; }
  const originalPath = document.uri.fsPath;

  let relativePath = document.uri.fsPath;
  relativePath = document.uri.fsPath.replace(workspacePath, '');
  relativePath = relativePath.substring(1);
  const targetDir = path.dirname(path.join(globalTmpDir, relativePath));
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const copyPath = path.join(targetDir, path.basename(originalPath));

  const text = document.getText();
  fs.writeFileSync(copyPath, text);
  if (proc) {
    const options = ['-path .', '-format json', `-output ${scanResultName}`];
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
    if (fs.existsSync(path.join(globalTmpDir, scanResultName))) {
      fs.unlinkSync(path.join(globalTmpDir, scanResultName));
    }
    outputChannel.appendLine(`Scanning file ${relativePath}`);
    const output = await executeCommand(`codescan ${joined}`) as string;
    outputChannel.append(output);
    if (fs.existsSync(path.join(globalTmpDir, scanResultName))) {
      if (output.indexOf('0 total distinct warnings') === -1) {
        try {
          const content = fs.readFileSync(path.resolve(path.join(globalTmpDir, scanResultName)), 'utf8');
          const warnings = JSON.parse(content);
          warnings.forEach((p: any) => {
            const fname = p.file.replace(/^.\//, '');
            const uri = vscode.Uri.file(path.join(workspacePath, fname));
            vscode.workspace.openTextDocument(uri).then((doc) => {
              parseCodeScanResultForFile(workspacePath, fname, p, doc);
            });
          });
        } catch (e) {
          outputChannel.appendLine(`An error occured while parsing ${scanResultName}`);
        } finally {
          emptyDirectory(globalTmpDir, 'tvd_tmp');
        }
      } else {
        const collection = getCollection();
        collection.delete(document.uri);
      }
    }
  }
};

if (config.get('sqlclCodescan.checkOnOpen')) {
  vscode.workspace.onDidOpenTextDocument(documentCallback);
}
if (config.get('sqlclCodescan.checkOnSave')) {
  vscode.workspace.onDidSaveTextDocument(documentCallback);
}

if (config.get('sqlclCodescan.checkOnType')) {
  let timeoutId: NodeJS.Timeout;
  vscode.workspace.onDidChangeTextDocument((event) => {
    // debounce here using setTimeout
    if (event.contentChanges.length > 0
      && event.contentChanges.filter((p) => p.text.trim()).length > 0) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => documentCallback(event.document), 500);
    }
  });
}

export function showWarning(message: string) {
  outputChannel.appendLine(`WARNING: ${message}`);
  vscode.window.showWarningMessage(message, 'Open Output Channel').then((selectedAction) => {
    if (selectedAction && selectedAction === 'Open Output Channel') {
      outputChannel.show();
    }
  });
}

const load = async function load(context: vscode.ExtensionContext) {
  if (vscode.workspace?.workspaceFolders?.length) {
    workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
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
      formattingOnReady(
        outputChannel,
        config,
        workspacePath,
        globalTmpDir,
        executeCommand,
        showWarning,
        context,
      );
    }
  };
  let buffer = '';
  proc.stdout.on('data', (data: any) => {
    const str = data.toString();
    if (!ready && (str.indexOf('SQL>') > -1)) {
      ready = true;
      onReady();
    }
    if (!ready) {
      return;
    }
    buffer += data.toString().replaceAll('SQL> ', '');
    const matched = buffer.toString().match(/(.+)\n\$\$(.+)\n$/m);
    if (matched) {
      const [, , dataStr] = matched;
      const cb = callbacks[dataStr];
      if (cb) {
        cb(buffer.replace(/.+\n$/, ''));
        delete callbacks[dataStr];
        buffer = '';
      }
    }
  });
  proc.stderr.on('data', (data: any) => {
    const str = data.toString();
    if (!ready && (str.indexOf('SQL>') > -1)) {
      ready = true;
      onReady();
    }
  });
};

const unload = function unload() {
  outputChannel.appendLine('Unloading Sqlcl Codescan');
  if (proc) {
    proc.stdin.end();
  }
  if (fs.existsSync(globalTmpDir)) {
    fs.rm(globalTmpDir, { recursive: true });
  }
};

export function activate(context: vscode.ExtensionContext) {
  if (context.storageUri) {
    if (!fs.existsSync(context.storageUri.fsPath)) {
      // create target directory
      fs.mkdirSync(context.storageUri.fsPath, { recursive: true });
    }
    globalTmpDir = context.storageUri.fsPath;
  } else {
    globalTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcl-codescan'));
  }
  emptyDirectory(globalTmpDir);
  load(context);
  const disposable = vscode.commands.registerCommand('sqlclCodescan.enable', () => {
    load(context);
  });
  const unloadCommand = vscode.commands.registerCommand('sqlclCodescan.disable', () => {
    unload();
  });
  const scanWorkspace = vscode.commands.registerCommand('sqlclCodescan.scanWorkspace', () => {
    if (proc) {
      copySqlFiles(workspacePath, globalTmpDir);
      const options = ['-path .', '-format json', `-output ${scanResultName}`];
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
      executeCommand(`codescan ${joined}`);
    }
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(scanWorkspace);
  context.subscriptions.push(unloadCommand);

  vscode.workspace.onDidChangeConfiguration(async (event) => {
    config = vscode.workspace.getConfiguration();
    if (event.affectsConfiguration('sqlclCodescan')) {
      context.subscriptions.forEach((d) => {
        if (d !== disposable && d !== scanWorkspace && d !== unloadCommand) {
          d.dispose();
        }
        // debugger;
      });
      outputChannel.appendLine('Configuration changed');
      const formattingEnabled = config.get('sqlclCodescan.enableFormatting');
      if (formattingEnabled) {
        formattingOnReady(
          outputChannel,
          config,
          workspacePath,
          globalTmpDir,
          executeCommand,
          showWarning,
          context,
        );
      }
    }
  });
}

export function deactivate() {
  unload();
}
