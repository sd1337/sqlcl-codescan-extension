import * as vscode from 'vscode';
import { getCollection } from './codescan';

const path = require('path');
const fs = require('fs');
const os = require('os');

type ShowWarning = <T extends string>(message: string,
  ...items: T[]
) => Thenable<T | undefined>;

let useTvdFormat = false;
let useArbori = false;
let arboriPath = '';
let formatRulePath: string | undefined = '';
let globalTmpDir = '';
let workspacePath = '';
let executeCommand: (command: string) => Promise<string>;
let outputChannel: vscode.OutputChannel;
let showWarning: ShowWarning;

const formatText = async function formatText(
  document: vscode.TextDocument,
  range?: vscode.Range,
): Promise<vscode.TextEdit[]> {
  const { fsPath } = document.uri;
  try {
    const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const rndName = Math.random().toString(36).substring(7);
    const tmpPath = path.join(globalTmpDir, 'tvd_tmp');
    if (!fs.existsSync(tmpPath)) {
      // create target directory
      fs.mkdirSync(tmpPath, { recursive: true });
    }
    const outPath = path.join(tmpPath, `${rndName}.sql`);
    const relativePath = fsPath.replace(workspacePath, '').substring(1);
    let formatSuccess = false;
    let whiteSpaces = '';
    if (!useTvdFormat) {
      outputChannel.appendLine(`Formatting file ${relativePath} using default formatter`);
      await executeCommand(`format file ${fsPath} ${outPath};`);
      formatSuccess = true;
    } else {
      outputChannel.appendLine(`Formatting file ${relativePath} using tvd formatter`);
      const inPath = path.join(tmpPath, `in_${rndName}.sql`);
      const text = document.getText(range);
      fs.writeFileSync(inPath, text);
      if (range) {
        const line = document.lineAt(range.start.line);
        whiteSpaces = line.text.match(/^\s*/)?.[0] || '';
      }
      let result: string = '';
      const args = ['tvdformat', `"${inPath}"`];
      if (useArbori) {
        args.push(`"arbori=${arboriPath}"`);
      }
      if (formatRulePath) {
        args.push(`"xml=${formatRulePath}"`);
      }
      result = await executeCommand(args.join(' '));
      if (result.indexOf('... done.') === -1) {
        const sanitized = result.replace(inPath, relativePath).replaceAll('\n\n', '\n');
        const matchedError = sanitized.match(/Syntax Error at line (\d+), column (\d+)\n\n([\s\S]+)\s... skipped/m);
        if (matchedError) {
          const [line, col, err] = matchedError.slice(1);
          let lineNum = parseInt(line, 10) - 2;
          let colNum = parseInt(col, 10);
          const errMessage = err.replace(/^\s+/m, '');
          if (range) {
            lineNum += range.start.line;
            colNum += range.start.character;
          }
          const foundLocal = document.getWordRangeAtPosition(
            new vscode.Position(lineNum, colNum),
          );
          const newRange = new vscode.Range(
            new vscode.Position(lineNum, colNum),
            new vscode.Position(
              lineNum,
              Math.max(1 + colNum, (foundLocal ? foundLocal.end.character : colNum)),
            ),
          );
          const diag = new vscode.Diagnostic(newRange, errMessage, vscode.DiagnosticSeverity.Error);
          const diagContext = getCollection();
          const getCurrent = diagContext.get(document.uri);
          const newCollection = [...getCurrent as [], diag];
          diagContext.set(document.uri, newCollection);
        } else {
          outputChannel.appendLine(sanitized);
        }
      } else {
        formatSuccess = true;
      }
      fs.copyFileSync(inPath, outPath);
      fs.unlinkSync(inPath);
    }
    const formatted = fs.readFileSync(outPath, 'utf8');
    if (!formatSuccess) {
      outputChannel.appendLine(`An error occured while formatting ${fsPath}`);
    } else {
      outputChannel.appendLine(`Formatted file ${relativePath}`);
    }
    fs.unlinkSync(outPath);
    // if (range) {
    //   // replace trailing new line
    //   formatted = whiteSpaces + formatted.replace(/\n$/, '');

    // }
    return [{
      range: range || new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(document.lineCount + 1, 0),
      ),
      newText: formatted,
    }];
  } catch (e) {
    outputChannel.appendLine(`An error occured while formatting ${fsPath}`);
    throw e;
  }
};

function resolveHome(filepath: string): string {
  if (filepath[0] === '~') {
    const homeDir = os.homedir();
    return path.join(homeDir, filepath.slice(1));
  }
  return filepath;
}

const onReady = async function onReady(
  pOutputChannel: vscode.OutputChannel,
  config: vscode.WorkspaceConfiguration,
  pWorkspacePath: string,
  pGlobalTmpDir: string,
  pExecuteCommand: (command: string) => Promise<string>,
  pShowWarning: ShowWarning,
  context: vscode.ExtensionContext,
  allowedFileTypes: string[],
) {
  outputChannel = pOutputChannel;
  workspacePath = pWorkspacePath;
  globalTmpDir = pGlobalTmpDir;
  executeCommand = pExecuteCommand;
  showWarning = pShowWarning;

  pOutputChannel.appendLine('Formatting enabled');
  formatRulePath = config.get('sqlclCodescan.formattingRulePath');
  if (formatRulePath) {
    formatRulePath = resolveHome(formatRulePath);
    if (!path.isAbsolute(formatRulePath)) {
      formatRulePath = path.join(pWorkspacePath, formatRulePath);
    }
    const stat = fs.statSync(formatRulePath);
    if (stat.isDirectory()) {
      formatRulePath = path.join(formatRulePath, 'trivadis_advanced_format.xml');
    }
    executeCommand(`format RULES ${formatRulePath};`);
    pOutputChannel.appendLine(`Using formatting rules from ${formatRulePath}`);
  }
  let tvdFormatterPath: string | undefined = config.get('sqlclCodescan.tvdFormatterPath');
  let arboriPathLocal: string | undefined = config.get('sqlclCodescan.tvdArboriPath');
  if (tvdFormatterPath) {
    tvdFormatterPath = resolveHome(tvdFormatterPath);
    if (!path.isAbsolute(tvdFormatterPath)) {
      tvdFormatterPath = path.join(pWorkspacePath, tvdFormatterPath);
    }
    const tvdFormatterExists = fs.existsSync(tvdFormatterPath);
    if (!tvdFormatterExists) {
      showWarning(`Tvd Formatter Path is set but "${tvdFormatterPath}" does not exist. Tvd Formatter Path will be ignored.`);
      tvdFormatterPath = '';
    } else {
      const stat = fs.statSync(tvdFormatterPath);
      if (stat.isDirectory()) {
        tvdFormatterPath = path.join(tvdFormatterPath, 'format.js');
      }
    }
  }
  if (arboriPathLocal) {
    arboriPathLocal = resolveHome(arboriPathLocal);
    if (!path.isAbsolute(arboriPathLocal)) {
      arboriPathLocal = path.join(pWorkspacePath, arboriPathLocal);
    }
    const arboriPathExists = fs.existsSync(arboriPathLocal);
    if (!arboriPathExists) {
      showWarning(`Tvd Arbori Path is set but "${arboriPathLocal}" does not exist. Tvd Arbori Path will be ignored.`);
      arboriPathLocal = '';
    }
  }
  if (!tvdFormatterPath && arboriPathLocal) {
    showWarning('Tvd Arbori Path is set but Tvd Formatter Path is not set. Tvd Arbori Path will be ignored.');
  }
  if (tvdFormatterPath) {
    pOutputChannel.appendLine(`Using tvd formatter from ${tvdFormatterPath}`);
    useTvdFormat = true;
    let customRules = null;
    if (!path.isAbsolute(tvdFormatterPath)) {
      customRules = path.join(workspacePath, tvdFormatterPath);
    } else {
      customRules = tvdFormatterPath;
    }
    const result = await executeCommand(`script "${customRules}" --register`);
    if (result.indexOf('tvdformat registered as SQLcl command.') === -1) {
      if (result.indexOf('!ScriptCommand') !== -1) {
        showWarning('Failed to register tvdformat as SQLcl command. Make sure you are using a JDK with Nashorn support.', 'Select Java Home')
          .then((selected) => {
            if (selected === 'Select Java Home') {
              vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Java Home',
              }).then((uri) => {
                if (uri && uri[0]) {
                  const javaHome = uri[0].fsPath;
                  let sqlClPath: string | undefined = config.get('sqlclCodescan.sqlClPath');

                  if (sqlClPath && sqlClPath.match(/JAVA_HOME/)) {
                    sqlClPath = sqlClPath.replace(/JAVA_HOME="[^"]+"\s+/, '')
                      .replace(/JAVA_HOME=\S+\s+/, '');
                  }
                  if (!sqlClPath) {
                    sqlClPath = 'sql';
                  }
                  config.update('sqlclCodescan.sqlClPath', `JAVA_HOME=${javaHome} ${sqlClPath}`, vscode.ConfigurationTarget.Global);
                }
              });
            }
          });
      } else {
        showWarning('Failed to register tvdformat as SQLcl command. Please make sure the path to the tvd formatter is correct.');
      }
    }
    if (arboriPathLocal) {
      pOutputChannel.appendLine(`Using arbori advanced formatting script from ${arboriPathLocal}`);
      useArbori = true;
      if (!path.isAbsolute(arboriPathLocal)) {
        arboriPath = path.join(workspacePath, arboriPathLocal);
      } else {
        arboriPath = arboriPathLocal as string;
      }
    }
  }

  const formattingProvider = vscode.languages
    .registerDocumentFormattingEditProvider(allowedFileTypes, {
      provideDocumentFormattingEdits: (document: vscode.TextDocument) => formatText(document),
    });
  const rangeFormattingProvider = vscode.languages
    .registerDocumentRangeFormattingEditProvider(allowedFileTypes, {
      provideDocumentRangeFormattingEdits:
      (document: vscode.TextDocument, range: vscode.Range) => formatText(document, range),
    });
  context.subscriptions.push(formattingProvider, rangeFormattingProvider);
};

export {
  onReady,
  formatText,
};
