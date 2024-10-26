import { exec } from 'child_process';
import * as vscode from 'vscode';
import { getCollection, parseCodeScanResultForFile, clearCollectionForDocument } from './codescan';
import { copySqlFiles, emptyDirectory } from './fileUtils';
import { onReady as formattingOnReady } from './formatting';
import {
  ignoreDiagnostic,
  ignoreDiagnosticForFile,
  ignoreDiagnosticForProject,
  SqlClCodeActionProvider,
  showDocumentation,
} from './codeActions';

import { patchDbToolsCommon } from './patchSqlcl';
import {
  COMMAND_DISABLE,
  COMMAND_ENABLE,
  COMMAND_IGNORE_FILE,
  COMMAND_IGNORE_PROJECT,
  COMMAND_IGNORE_SINGLE,
  COMMAND_OPEN_DOCUMENTATION,
  COMMAND_SCAN_WORKSPACE,
  CONFIG_CHECK_ON_OPEN,
  CONFIG_CHECK_ON_SAVE,
  CONFIG_CHECK_ON_TYPE,
  CONFIG_ENABLE_FORMATTING,
  CONFIG_EXPERIMENTAL_PATCH_CODE_SCAN,
  CONFIG_SQLCL_PATH,
} from './constants';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const allowedFileTypes = ['plsql', 'sql', 'oraclesql', 'oracle_sql', 'oracle-sql'];
let globalTmpDir: string;
let proc: any;
let workspacePath = '';
const scanResultName = 'tmp.json';
let command = 'sql';

let config = vscode.workspace.getConfiguration();

let globalIgnoredRules: string[] = [];

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

const copyFileToTemp = (document: vscode.TextDocument) => {
  const originalPath = document.uri.fsPath;
  let relativePath = originalPath;
  let targetDir;
  let outOfWorkspaceFile = false;
  if (relativePath.includes(workspacePath)) {
    relativePath = originalPath.replace(workspacePath, '');
    relativePath = relativePath.substring(1);
    targetDir = path.dirname(path.join(globalTmpDir, relativePath));
  } else {
    outOfWorkspaceFile = true;
    targetDir = globalTmpDir;
  }
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const copyPath = path.join(targetDir, path.basename(originalPath));

  const text = document.getText();
  fs.writeFileSync(copyPath, text);
  return { relativePath, outOfWorkspaceFile };
};

const scanTempDirectory = async (
  outputMessage: string,
  outOfWorkspaceFile: boolean,
  singleFileUri: vscode.Uri = vscode.Uri.file(''),
) => {
  if (proc) {
    const options = ['-path .', '-format json', `-output ${scanResultName}`];
    const joined = options.join(' ');
    if (fs.existsSync(path.join(globalTmpDir, scanResultName))) {
      fs.unlinkSync(path.join(globalTmpDir, scanResultName));
    }
    outputChannel.appendLine(outputMessage);
    const output = await executeCommand(`codescan ${joined}`) as string;
    outputChannel.append(output);
    if (fs.existsSync(path.join(globalTmpDir, scanResultName))) {
      if (output.indexOf(' 0 total distinct warnings') === -1) {
        try {
          const content = fs.readFileSync(path.resolve(path.join(globalTmpDir, scanResultName)), 'utf8');
          const warnings = JSON.parse(content);
          warnings.forEach((p: any) => {
            const fname = p.file.replace(/^.\//, '');
            let uri;
            if (!outOfWorkspaceFile) {
              uri = vscode.Uri.file(path.join(workspacePath, fname));
            } else {
              uri = singleFileUri || vscode.Uri.file(p.file);
            }
            vscode.workspace.openTextDocument(uri).then((doc) => {
              parseCodeScanResultForFile(p, doc, globalIgnoredRules);
            });
          });
        } catch (e) {
          outputChannel.appendLine(`An error occured while parsing ${scanResultName}`);
        } finally {
          emptyDirectory(globalTmpDir, 'tvd_tmp');
        }
      } else {
        const collection = getCollection();
        collection.delete(singleFileUri);
      }
    }
  }
};

const documentCallback = async (document: vscode.TextDocument) => {
  if (!allowedFileTypes.includes(document.languageId)) {
    return;
  }
  // const originalPath = document.uri.fsPath;
  const { relativePath, outOfWorkspaceFile } = copyFileToTemp(document);
  scanTempDirectory(`Scanning file ${relativePath}`, outOfWorkspaceFile, document.uri);
};

if (config.get(CONFIG_CHECK_ON_OPEN)) {
  vscode.workspace.onDidOpenTextDocument(documentCallback);
}
if (config.get(CONFIG_CHECK_ON_SAVE)) {
  vscode.workspace.onDidSaveTextDocument(documentCallback);
}

vscode.workspace.onDidCloseTextDocument((document) => {
  if (!allowedFileTypes.includes(document.languageId)) {
    return;
  }
  clearCollectionForDocument(document.uri);
});

if (config.get(CONFIG_CHECK_ON_TYPE)) {
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

export function showWarning<T extends string>(
  message: string,
  ...items: T[]
): Thenable<T | undefined> {
  if (!items.length) {
    outputChannel.appendLine(`WARNING: ${message}`);

    vscode.window.showWarningMessage(message, 'Open Output Channel').then((selectedAction) => {
      if (selectedAction && selectedAction === 'Open Output Channel') {
        outputChannel.show();
      }
    });
  } else {
    return vscode.window.showWarningMessage(message, ...['Open Output Channel' as T, ...items]).then((selectedAction) => {
      if (selectedAction && selectedAction === 'Open Output Channel') {
        outputChannel.show();
      }
      return Promise.resolve(selectedAction);
    });
  }
  return Promise.resolve(undefined);
}

const updateIgnoredRules = function updateIgnoredRules() {
  if (fs.existsSync(path.join(workspacePath, '.codescanignore'))) {
    globalIgnoredRules = fs.readFileSync(path.join(workspacePath, '.codescanignore'), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((p: string) => p);
  }
};

const load = async function load(context: vscode.ExtensionContext) {
  if (vscode.workspace?.workspaceFolders?.length) {
    workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  updateIgnoredRules();
  const configPath = config.get(CONFIG_SQLCL_PATH);
  if (configPath) {
    command = configPath as string;
  }
  const experimentalPatchEnabled = config.get(CONFIG_EXPERIMENTAL_PATCH_CODE_SCAN);
  if (experimentalPatchEnabled) {
    await patchDbToolsCommon(context, configPath as string, outputChannel.appendLine);
  }
  outputChannel.appendLine(`Using sqlcl command: ${command}`);
  const foundRightVersion = await new Promise((resolve) => {
    exec(`${command} -V`, async (error, stdout) => {
      if (error) {
        if (error.message.includes('not found') || error.message.includes('No such file or directory')) {
          const sqlclPath = await config.get(CONFIG_SQLCL_PATH);
          vscode.window.showErrorMessage('SQLcl Codescan: sqlcl command not found, '
            + 'make sure it is in your PATH or set the correct path in the settings', 'Open Settings', 'Choose sqlcl file', 'Download').then((selectedAction) => {
            if (selectedAction) {
              switch (selectedAction) {
                case 'Open Settings':
                  vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SQLCL_PATH);
                  break;
                case 'Choose sqlcl file':
                  // Open a file dialog to let the user select a file
                  vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    openLabel: 'Select sqlcl executable',
                    defaultUri: sqlclPath ? vscode.Uri.file(path.dirname(sqlclPath)) : undefined,
                    filters: {
                      'All files': ['*'],
                    },
                  }).then((fileUri) => {
                    if (fileUri && fileUri[0]) {
                      config.update(
                        CONFIG_SQLCL_PATH,
                        fileUri[0].path,
                        vscode.ConfigurationTarget.Global,
                      );
                    }
                  });
                  break;
                case 'Download':
                  vscode.env.openExternal(vscode.Uri.parse('https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/'));
                  break;
                default:
                  break;
              }
            }
          });
        } else {
          vscode.window.showErrorMessage(`SQLcl Codescan: ${error.message}`, 'Open Settings').then((selectedAction) => {
            if (selectedAction) {
              vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SQLCL_PATH);
            }
          });
        }
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
  const formattingEnabled = config.get(CONFIG_ENABLE_FORMATTING);

  proc = spawn(`${command} /nolog`, { cwd: globalTmpDir, shell: true });

  let ready = false;
  const onReady = () => {
    writeInput('set define off\nset history off\n');
    const openDocuments = vscode.workspace.textDocuments
      .filter((p) => allowedFileTypes.includes(p.languageId));
    openDocuments.forEach((doc) => {
      copyFileToTemp(doc);
    });
    scanTempDirectory('Scanning workspace', false);

    if (formattingEnabled) {
      formattingOnReady(
        outputChannel,
        config,
        workspacePath,
        globalTmpDir,
        executeCommand,
        showWarning,
        context,
        allowedFileTypes,
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
    buffer += str.replaceAll('SQL> ', '');
    const matched = buffer.toString().match(/(.+)\n?\$\$(.+)\n$/m);
    if (matched) {
      const [, , dataStr] = matched;
      const cb = callbacks[dataStr];
      if (cb) {
        cb(buffer.replace(new RegExp(`\\$\\$${dataStr}\n$`), ''));
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
  const disposable = vscode.commands.registerCommand(COMMAND_ENABLE, () => {
    load(context);
  });
  const unloadCommand = vscode.commands.registerCommand(COMMAND_DISABLE, () => {
    unload();
  });
  const scanWorkspace = vscode.commands.registerCommand(COMMAND_SCAN_WORKSPACE, () => {
    if (proc) {
      copySqlFiles(workspacePath, globalTmpDir);
      const options = ['-path .', '-format json', `-output ${scanResultName}`];
      const joined = options.join(' ');
      executeCommand(`codescan ${joined}`);
    }
  });

  const codeActionProvider = new SqlClCodeActionProvider();
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    ['plsql', 'sql', 'oraclesql', 'oracle_sql', 'oracle-sql'],
    codeActionProvider,
  ));

  vscode.commands.registerCommand(COMMAND_IGNORE_SINGLE, ignoreDiagnostic);
  vscode.commands.registerCommand(COMMAND_IGNORE_FILE, ignoreDiagnosticForFile);
  vscode.commands.registerCommand(COMMAND_IGNORE_PROJECT, (diagnostic: vscode.Diagnostic) => {
    ignoreDiagnosticForProject(diagnostic);
    updateIgnoredRules();
  });
  vscode.commands.registerCommand(COMMAND_OPEN_DOCUMENTATION, showDocumentation);

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
      });
      const sqlclPath = config.get(CONFIG_SQLCL_PATH);
      if (sqlclPath !== command) {
        command = sqlclPath as string;
        load(context);
      }
      outputChannel.appendLine('Configuration changed');
      const formattingEnabled = config.get(CONFIG_ENABLE_FORMATTING);
      if (formattingEnabled) {
        formattingOnReady(
          outputChannel,
          config,
          workspacePath,
          globalTmpDir,
          executeCommand,
          showWarning,
          context,
          allowedFileTypes,
        );
      }
    }
  });
}

export function deactivate() {
  unload();
}
