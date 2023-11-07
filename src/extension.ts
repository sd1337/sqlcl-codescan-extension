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
const scanResultName = 'tmp.json';

const config = vscode.workspace.getConfiguration();

const outputChannel = vscode.window.createOutputChannel('sqlcl codescan');
outputChannel.show(true);

const writeInput = (str: string) => {
  if (proc) {
    proc.stdin.write(str);
  }
};

const copyFileSync = async (source: string, destination: string) => {
  fs.copyFileSync(source, destination);
  const fd = fs.openSync(destination, 'r');
  const buffer = Buffer.alloc(3);
  await fs.read(fd, buffer, 0, 3, 0, () => {});
  const hasBom = buffer.toString().charCodeAt(0) === 0xFEFF;
  fs.close(fd, () => {});
  if (hasBom) {
    const newContent = fs.readFileSync(destination, 'utf8');
    fs.writeFileSync(destination, newContent.substring(1));
  }
};

const callbacks: {
  [Key: string]: any;
} = {};

const executeCommand = async function executeCommand(commandString: string) {
  const rndName = Math.random().toString(36).substring(7);
  let cmd = commandString;
  cmd += `\nPRO ${rndName}\n`;
  return new Promise((resolve) => {
    callbacks[rndName] = resolve;
    writeInput(`${cmd}\n`);
  });
};

const documentCallback = async (document: vscode.TextDocument) => {
  if (document.languageId !== 'plsql' && document.languageId !== 'sql' && document.languageId !== 'oraclesql') { return; }
  const originalPath = document.uri.fsPath;

  let relativePath = document.uri.fsPath;
  relativePath = document.uri.fsPath.replace(workspacePath, '');
  relativePath = relativePath.substring(1);
  const targetDir = path.dirname(path.join(globalTmpDir, relativePath));
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const copyPath = path.join(targetDir, path.basename(originalPath));

  copyFileSync(originalPath, copyPath);
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
      // outputChannel.appendLine(str);
      try {
        const warnings = JSON.parse(fs.readFileSync(path.resolve(path.join(globalTmpDir, scanResultName)), 'utf8'));
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
    }
  }
};

if (config.get('sqlclCodescan.checkOnOpen')) {
  vscode.workspace.onDidOpenTextDocument(documentCallback);
}
if (config.get('sqlclCodescan.checkOnSave')) {
  vscode.workspace.onDidSaveTextDocument(documentCallback);
}

let useTvdFormat = false;
let useArbori = false;
let arboriPath = '';

const load = async function load() {
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
    // if (fs.existsSync(path.join(globalTmpDir, scanResultName))) {
    //   outputChannel.appendLine(str);
    //   try {
    //     const warnings = JSON.parse(
    // fs.readFileSync(path.resolve(path.join(globalTmpDir, scanResultName)), 'utf8'));
    //     warnings.forEach((p: any) => {
    //       const fname = p.file.replace(/^.\//, '');
    //       const uri = vscode.Uri.file(path.join(workspacePath, fname));
    //       vscode.workspace.openTextDocument(uri).then((doc) => {
    //         parseCodeScanResultForFile(workspacePath, fname, p, doc);
    //       });
    //     });
    //   } catch (e) {
    //     outputChannel.appendLine(`An error occured while parsing ${scanResultName}`);
    //   } finally {
    //     emptyDirectory(globalTmpDir, 'tvd_tmp');
    //   }
    // }
    buffer += data.toString();
    const matched = buffer.toString().match(/(.+)\n(.+)\n$/m);
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

  if (formattingEnabled) {
    vscode.languages.registerDocumentFormattingEditProvider(['plsql', 'sql', 'oraclesql'], {
      async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
      ): Promise<vscode.TextEdit[]> {
        const { fsPath } = document.uri;
        try {
          const rndName = Math.random().toString(36).substring(7);
          const tmpPath = path.join(globalTmpDir, 'tvd_tmp');
          if (!fs.existsSync(tmpPath)) {
            // create target directory
            fs.mkdirSync(tmpPath, { recursive: true });
          }
          const outPath = path.join(tmpPath, `${rndName}.sql`);
          const relativePath = fsPath.replace(workspacePath, '').substring(1);
          if (!useTvdFormat) {
            outputChannel.appendLine(`Formatting file ${relativePath} using default formatter`);
            await executeCommand(`format file ${fsPath} ${outPath};`);
          } else {
            outputChannel.appendLine(`Formatting file ${relativePath} using tvd formatter`);
            const inPath = path.join(tmpPath, `in_${rndName}.sql`);
            copyFileSync(fsPath, inPath);
            if (!useArbori) {
              await executeCommand(`tvdformat ${inPath}`);
            } else {
              await executeCommand(`tvdformat ${inPath} arbori=${arboriPath}`);
            }
            fs.copyFileSync(inPath, outPath);
            fs.unlinkSync(inPath);
          }
          const formatted = fs.readFileSync(outPath, 'utf8');
          outputChannel.appendLine(`Formatted file ${relativePath}`);
          fs.unlinkSync(outPath);
          // debugger;
          return [{
            range: new vscode.Range(
              new vscode.Position(0, 0),
              new vscode.Position(document.lineCount + 1, 0),
            ),
            newText: formatted,
          }];
        } catch (e) {
          outputChannel.appendLine(`An error occured while formatting ${fsPath}`);
          throw e;
        }
      },
    });
    vscode.languages.registerDocumentRangeFormattingEditProvider(['plsql', 'sql', 'oraclesql'], {
      async provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
      ): Promise<vscode.TextEdit[]> {
        const tmpText = document.getText(range);
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
}

export function deactivate() {
  unload();
}
