import * as vscode from 'vscode';
import * as fs from 'fs';
import { getCollection } from './codescan';

const collection = getCollection();

type DiagnosticCode = { value: string; target: vscode.Uri };

export class MyCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] | undefined {
    // Implement your code action logic here
    // Return an array of CodeAction objects
    const listOfDiagnostics = vscode.languages.getDiagnostics(document.uri);
    const diagnostic = listOfDiagnostics
      .find((diag) => diag.range.contains(range));

    if (diagnostic && diagnostic.code && typeof diagnostic.code === 'object') {
      const code = diagnostic.code as DiagnosticCode;
      return [
        {
          title: `Disable Rule "${code.value}" for this line`,
          command: {
            title: `Disable Rule "${code.value}" for this line`,
            command: 'sqlclCodescan.ignoreSingle',
            arguments: [document, diagnostic],
          },
          diagnostics: [diagnostic],
          isPreferred: true,
          kind: vscode.CodeActionKind.QuickFix,
        },
        {
          title: `Disable Rule "${code.value}" for this file`,
          command: {
            title: `Disable Rule "${code.value}" for this file`,
            command: 'sqlclCodescan.ignoreFile',
            arguments: [document, diagnostic],
          },
          diagnostics: [diagnostic],
          kind: vscode.CodeActionKind.QuickFix,
        },
        {
          title: `Disable Rule "${code.value}" for this project`,
          command: {
            title: `Disable Rule "${code.value}" for this project`,
            command: 'sqlclCodescan.ignoreProject',
            arguments: [diagnostic],
          },
          diagnostics: [diagnostic],
          kind: vscode.CodeActionKind.QuickFix,
        },
        {
          title: `Show documentation for "${code.value}"`,
          command: {
            title: `Show documentation for "${code.value}"`,
            command: 'sqlclCodescan.openDocumentation',
            arguments: [code.target],
          },
        },
      ];
    } return undefined;
  }
}

export function ignoreDiagnostic(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
  const startLine = diagnostic.range.start.line;
  const code = diagnostic.code as DiagnosticCode;

  const allDiagnosticInFile = vscode.languages.getDiagnostics(document.uri);
  const indexOfDiagnostic = allDiagnosticInFile.findIndex((diag) => diag === diagnostic);
  // remove the diagnostic from the list of diagnostics
  allDiagnosticInFile.splice(indexOfDiagnostic, 1);
  collection.delete(document.uri);
  collection.set(document.uri, allDiagnosticInFile);

  const line = document.lineAt(diagnostic.range.start.line);
  const leadingWhitespace = line.text.match(/^\s*/)?.[0] || '';

  const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const comment = `${leadingWhitespace}-- codescan-disable-next-line ${code.value}${lineEnding}`;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(startLine, 0), comment);
  vscode.workspace.applyEdit(edit);
}

export function ignoreDiagnosticForFile(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
) {
  const code = diagnostic.code as DiagnosticCode;
  const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  // check if the file already has a codescan-disable comment
  const existingComment = document.lineAt(0).text.match(/\/\*\s*codescan-disable\s*(.*)\*\//);
  const edit = new vscode.WorkspaceEdit();
  if (existingComment) {
    const ignoredRules = existingComment[1].split(' ').filter((p: string) => p);
    const newComment = `/* codescan-disable ${ignoredRules.join(' ')} ${code.value} */`;
    edit.replace(document.uri, new vscode.Range(0, 0, 0, existingComment[0].length), newComment);
  } else {
    const comment = `/* codescan-disable ${code.value} */${lineEnding}`;
    edit.insert(document.uri, new vscode.Position(0, 0), comment);
  }
  vscode.workspace.applyEdit(edit);
  const allDiagnosticInFile = vscode.languages.getDiagnostics(document.uri);
  const filteredDiagnostics = allDiagnosticInFile
    .filter((diag) => (diag.code as DiagnosticCode).value !== code.value);
  collection.delete(document.uri);
  collection.set(document.uri, filteredDiagnostics);
}

export function ignoreDiagnosticForProject(
  diagnostic: vscode.Diagnostic,
) {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }
  const ignoreFilePath = `${vscode.workspace.workspaceFolders[0].uri.fsPath}/.codescanignore`;
  // check if .codescanignore or .codescanrc.json exists in the workspace
  if (!fs.existsSync(ignoreFilePath)) {
    // create empty file
    fs.writeFileSync(ignoreFilePath, '');
  }

  const code = diagnostic.code as DiagnosticCode;
  // check if the rule is already in the file
  const fileContent = fs.readFileSync(ignoreFilePath, 'utf8').replace(/\r\n/g, '\n');
  const rules = fileContent.split('\n').filter((p: string) => p);
  if (rules.includes(code.value)) {
    return;
  }
  rules.push(code.value);
  fs.writeFileSync(ignoreFilePath, rules.join('\n'));
}

export function showDocumentation(uri: vscode.Uri) {
  // open uri in browser
  vscode.env.openExternal(uri);
}
