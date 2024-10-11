import * as vscode from 'vscode';

const path = require('path');

const config = vscode.workspace.getConfiguration();

const collection = vscode.languages.createDiagnosticCollection('codescanWarnings');

export function getCollection(): vscode.DiagnosticCollection {
  return collection;
}

export function getSeverity(ruleNo: string): vscode.DiagnosticSeverity {
  let severity = vscode.DiagnosticSeverity.Warning;
  const minor = vscode.DiagnosticSeverity.Information;
  const major = vscode.DiagnosticSeverity.Warning;
  const blocker = vscode.DiagnosticSeverity.Error;
  const critical = vscode.DiagnosticSeverity.Error;
  switch (ruleNo) {
    case 'G-1010':
    case 'G-1020':
    case 'G-1050':
    case 'G-1070':
    case 'G-2120':
    case 'G-2130':
    case 'G-2140':
    case 'G-2410':
    case 'G-2610':
    case 'G-3183':
    case 'G-4110':
    case 'G-4210':
    case 'G-4260':
    case 'G-4270':
    case 'G-4320':
    case 'G-4375':
    case 'G-4380':
    case 'G-4395':
    case 'G-6020':
    case 'G-7120':
    case 'G-7220':
    case 'G-7310':
    case 'G-7410':
    case 'G-7730':
    case 'G-8210':
      severity = minor;
      break;
    case 'G-1030':
    case 'G-1040':
    case 'G-2110':
    case 'G-2135':
    case 'G-2180':
    case 'G-2185':
    case 'G-2510':
    case 'G-3130':
    case 'G-3140':
    case 'G-3180':
    case 'G-4220':
    case 'G-4310':
    case 'G-4325':
    case 'G-4330':
    case 'G-4340':
    case 'G-4365':
    case 'G-4370':
    case 'G-4390':
    case 'G-5050':
    case 'G-5060':
    case 'G-6010':
    case 'G-7110':
    case 'G-7125':
    case 'G-7130':
    case 'G-7140':
    case 'G-7150':
    case 'G-7160':
    case 'G-7170':
    case 'G-7210':
    case 'G-7230':
    case 'G-7250':
    case 'G-7320':
    case 'G-7420':
    case 'G-7430':
    case 'G-7440':
    case 'G-7460':
    case 'G-7510':
    case 'G-7710':
    case 'G-8310':
    case 'G-9030':
      severity = major;
      break;
    case 'G-1060':
    case 'G-1080':
    case 'G-2145':
    case 'G-2150':
    case 'G-2170':
    case 'G-2190':
    case 'G-2310':
    case 'G-2320':
    case 'G-2340':
    case 'G-3110':
    case 'G-3120':
    case 'G-3145':
    case 'G-3160':
    case 'G-3170':
    case 'G-3182':
    case 'G-3185':
    case 'G-3190':
    case 'G-3195':
    case 'G-3310':
    case 'G-3320':
    case 'G-4120':
    case 'G-4130':
    case 'G-4140':
    case 'G-4150':
    case 'G-4350':
    case 'G-5030':
    case 'G-5070':
    case 'G-7330':
    case 'G-7450':
    case 'G-7720':
    case 'G-7910':
    case 'G-8410':
    case 'G-9010':
    case 'G-9020':
    case 'G-9040':
      severity = blocker;
      break;
    case 'G-2160':
    case 'G-2210':
    case 'G-2220':
    case 'G-2230':
    case 'G-3150':
    case 'G-3210':
    case 'G-3220':
    case 'G-4230':
    case 'G-4240':
    case 'G-4360':
    case 'G-4385':
    case 'G-5010':
    case 'G-5020':
    case 'G-5040':
    case 'G-5080':
    case 'G-7740':
    case 'G-7810':
    case 'G-8110':
    case 'G-8120':
    case 'G-8510':
      severity = critical;
      break;
    default:
      severity = vscode.DiagnosticSeverity.Error;
      break;
  }
  return severity;
}

export function parseCodeScanResultForFile(
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
    const diag = new vscode.Diagnostic(range, p.msg, getSeverity(p.ruleNo));
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

export function clearCollectionForDocument(uri: vscode.Uri) {
  collection.delete(uri);
}
