// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { exec } from 'child_process';
import * as vscode from 'vscode';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

let globalTmpDir: string;
let proc: any;
let workspacePath = '';

const config = vscode.workspace.getConfiguration();

function emptyDirectory(directory: any) {
  fs.readdirSync(directory).forEach((file: any) => {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      emptyDirectory(fullPath);
      fs.rmdirSync(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  });
}
function copySqlFiles(source: string, target: string) {
  // if source is a directory
  if (fs.statSync(source).isDirectory()) {
    // get all items in the directory
    const items = fs.readdirSync(source);

    // if the target directory does not exis
    if (!fs.existsSync(target)) {
      // create target directory
      fs.mkdirSync(target, { recursive: true });
    }

    // iterate over the directory items
    items.forEach((item: any) => {
      // call the function for each item (could be a file or directory)
      copySqlFiles(path.join(source, item), path.join(target, item));
    });
  } else if (source.endsWith('.sql')) {
    // copy the file
    fs.copyFileSync(source, target);
  }
}

const collection = vscode.languages.createDiagnosticCollection('codescanWarnings');

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
function parseCodeScanResultForFile(
  cwd: string,
  fname: string,
  file: any,
  document: vscode.TextDocument,
) {
  const uri = vscode.Uri.file(path.join(cwd, fname));
  const mapped = file.issues.map((p: any) => {
    const { col, line } = p;
    const foundLocal = document.getWordRangeAtPosition(new vscode.Position(line, col + 1));
    const range = new vscode.Range(
      new vscode.Position(line, col),
      new vscode.Position(line, Math.max(1 + col, (foundLocal ? foundLocal.end.character : col))),
    );
    const diag = new vscode.Diagnostic(range, p.msg);
    let intermediateUrl: string;
    const partialError = p.ruleNo.substr(2, 2);
    switch (partialError) {
      case '10':
        intermediateUrl = '1-general';
        break;
      case '21':
        intermediateUrl = '2-variables-and-types/1-general';
        break;
      case '22':
        intermediateUrl = '2-variables-and-types/2-numeric-data-types';
        break;
      case '23':
        intermediateUrl = '2-variables-and-types/3-character-data-types';
        break;
      case '24':
        intermediateUrl = '2-variables-and-types/4-boolean-data-types';
        break;
      case '25':
        intermediateUrl = '2-variables-and-types/5-large-objects';
        break;
      case '26':
        intermediateUrl = '2-variables-and-types/6-cursor-variables';
        break;
      case '31':
        intermediateUrl = '3-dml-and-sql/1-general';
        break;
      case '32':
        intermediateUrl = '3-dml-and-sql/2-bulk-operations';
        break;
      case '33':
        intermediateUrl = '3-dml-and-sql/3-transaction-control';
        break;
      case '41':
        intermediateUrl = '4-control-structures/1-cursor';
        break;
      case '42':
        intermediateUrl = '4-control-structures/2-case-if-decode-nvl-nvl2-coalesce';
        break;
      case '43':
        intermediateUrl = '4-control-structures/3-flow-control';
        break;
      case '50':
        intermediateUrl = '5-exception-handling';
        break;
      case '60':
        intermediateUrl = '6-dynamic-sql';
        break;
      case '71':
        intermediateUrl = '7-stored-objects/1-general';
        break;
      case '72':
        intermediateUrl = '7-stored-objects/2-packages';
        break;
      case '73':
        intermediateUrl = '7-stored-objects/3-procedures';
        break;
      case '74':
        intermediateUrl = '7-stored-objects/4-functions';
        break;
      case '75':
        intermediateUrl = '7-stored-objects/5-oracle-supplied-packages';
        break;
      case '77':
        intermediateUrl = '7-stored-objects/7-triggers';
        break;
      case '78':
        intermediateUrl = '7-stored-objects/8-sequences';
        break;
      case '79':
        intermediateUrl = '7-stored-objects/9-sql-macros';
        break;
      case '81':
        intermediateUrl = '8-patterns/1-checking-the-number-of-rows';
        break;
      case '82':
        intermediateUrl = '8-patterns/2-access-objects-of-foreign-application-schemas';
        break;
      case '83':
        intermediateUrl = '8-patterns/3-validating-input-parameter-size';
        break;
      case '84':
        intermediateUrl = '8-patterns/4-ensure-single-execution-at-a-time-of-a-program-unit';
        break;
      case '85':
        intermediateUrl = '8-patterns/5-use-dbms-application-info-package-to-follow-progress-of-a-process';
        break;
      case '90':
        intermediateUrl = '9-function-usage';
        break;
      default:
        intermediateUrl = '';
        break;
    }
    if (p.ruleNo === 'G-2135') {
      diag.tags = [vscode.DiagnosticTag.Unnecessary];
    }
    diag.code = {
      value: p.ruleNo,
      target: vscode.Uri.parse(`${config.get('sqlclCodescan.websiteInfo')}${intermediateUrl}/${p.ruleNo.toLowerCase()}/`),
    };
    return diag;
  });
  collection.delete(uri);
  collection.set(uri, mapped);
}

const load = async function load() {
  if (vscode.workspace?.workspaceFolders?.length) {
    workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  const hashFromWorkspacePath = crypto.createHash('sha1').update(workspacePath).digest('hex').substring(0, 8);
  globalTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sqlcl-codescan-tmp-${hashFromWorkspacePath}`));
  let command = 'sql';
  const configPath = config.get('sqlclCodescan.sqlClPath');
  if (configPath) {
    command = configPath as string;
  }
  const foundRightVersion = await new Promise((resolve) => {
    exec(`${command} -V`, (error, stdout) => {
      if (error) {
        vscode.window.showErrorMessage(`SQLcl Codescan: ${error.message}`);
        resolve(false);
        return;
      }
      const match = stdout.match(/Build:\s+(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      const [, major] = match || [];
      if (parseInt(major, 10) < 23) {
        vscode.window.showErrorMessage('SQLcl Codescan: SQLcl version must be version 23 or higher');
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
  if (!foundRightVersion) {
    return;
  }

  proc = spawn(`${command} /nolog`, { cwd: globalTmpDir, shell: true });
  vscode.workspace.openTextDocument();
  proc.stdout.on('data', (data: any) => {
    console.log(`stdout: ${data}`);
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
  });
  proc.stderr.on('data', (data: any) => {
    console.log(`stderr: ${data}`);
  });
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
