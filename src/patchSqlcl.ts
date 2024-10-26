import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { Extract } from 'unzipper';

const path = require('path');
// const unzipper = require('unzipper');
const https = require('https');
const fs = require('fs');

export function checkSqlClVersion() {
  return true;
}

async function downloadFile(urlString: string, dest: string, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlString);
    const request = https.get(parsedUrl, (response: any) => {
      const { statusCode } = response;

      // Check if we need to follow redirects
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        if (maxRedirects > 0) {
          // Follow the redirect
          const redirectUrl = new URL(response.headers.location, parsedUrl);
          downloadFile(redirectUrl.href, dest, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error('Too many redirects'));
        }
      } else if (statusCode === 200) {
        // Write the file data to destination
        const file = fs.createWriteStream(dest);
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      } else {
        reject(new Error(`Failed to download file: ${statusCode}`));
      }
    });

    request.on('error', (err: any) => {
      reject(err);
    });
  });
}

async function downloadJdCli(extensionPath: string, output: (message: string) => void) {
  const downloadUrl = 'https://github.com/intoolswetrust/jd-cli/releases/download/jd-cli-1.2.0/jd-cli-1.2.0-dist.zip';
  const tempFolder = path.join(extensionPath, 'temp');
  const tempZip = path.join(extensionPath, 'temp.zip');
  await downloadFile(downloadUrl, tempZip);
  return new Promise<void>((resolve, reject) => {
    fs.createReadStream(tempZip)
      .pipe(Extract({ path: tempFolder }))
      .on('close', () => {
        fs.unlinkSync(tempZip);
        // move jd-cli.jar to parent folder and delete temp folder
        const jarPath = path.join(tempFolder, '/jd-cli.jar');
        fs.renameSync(jarPath, path.join(extensionPath, '/jd-cli.jar'));
        fs.rmSync(tempFolder, { recursive: true });
        output('Download and extraction complete!');
        resolve();
      })
      .on('error', (err: any) => {
        output(`Error during extraction: ${err}`);
        reject(err);
      });
  });
}

function getJavaPath(sqlClPath: string) {
  const inSqlClPath = sqlClPath.match(/JAVA_HOME=(".+"|[a-zA-Z0-9-_.\\/]+)/);
  if (inSqlClPath) {
    return `${inSqlClPath[1]}/bin`;
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      return `${javaHome}/bin`;
    }
    // if linux or mac, use readlink to get the actual path
    const actualPath = execSync('readlink -f $(which java)').toString().trim();
    return actualPath;
  }
  let actualSqlClPath = sqlClPath;
  // check if folder jdk exists in ../../jdk
  if (sqlClPath === 'sql' || sqlClPath === '') {
    actualSqlClPath = execSync('where sql.exe').toString().trim();
  }

  const jdkPath = path.join(actualSqlClPath, '../', '../../jdk');
  if (fs.existsSync(jdkPath)) {
    if (fs.existsSync(path.join(jdkPath, 'jre'))) {
      return path.join(jdkPath, 'jre', 'bin');
    }
    return path.join(jdkPath, 'bin');
  }

  const actualPath = execSync('where java').toString().trim();
  return actualPath;
}

export async function patchDbToolsCommon(
  context: vscode.ExtensionContext,
  sqlClPath: string,
  output: (message: string) => void,
) {
  try {
  // check if sqlClPath is empty or just "sql" and the call which/where to find the sqlcl directory
  // remove a leading JAVA_HOME= expression
    let sqlClDirectory;
    {
      const tempPath = sqlClPath.replace(/JAVA_HOME=(".+"|[a-zA-Z0-9-_.\\/]+)\s+/, '').replace(/-[a-zA-Z0-9]+/, '');
      if (tempPath === '' || tempPath === 'sql') {
        let actualPath;

        if (process.platform === 'linux' || process.platform === 'darwin') {
          actualPath = execSync('which sql').toString().trim();
        } else {
          actualPath = execSync('where sql.exe').toString().trim();
        }
        // now go two levels up to get the sqlcl directory
        sqlClDirectory = path.join(actualPath, '../../');
      } else {
        sqlClDirectory = path.join(tempPath, '../../');
      }
    }
    // check if bak file exists and if so skip the patch
    if (fs.existsSync(path.join(sqlClDirectory, 'lib/dbtools-common.jar.bak'))) {
      output('Patched dbtools-common.jar already exists. Skipping patching.');
      return;
    }

    const javaPath = getJavaPath(sqlClPath);
    const javaExecutable = path.join(javaPath, 'java');
    const jarExecutable = path.join(javaPath, 'jar');
    const javaCExecutable = path.join(javaPath, 'javac');
    const originalJarPath = path.join(sqlClDirectory, 'lib/dbtools-common.jar');
    const tempDir = path.join(context.extensionPath, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    // check if jd-cli exists else download it
    const jdCliJarPath = path.join(context.extensionPath, 'jd-cli.jar');
    if (!fs.existsSync(jdCliJarPath)) {
      output('Downloading jd-cli...');
      await downloadJdCli(context.extensionPath, output);
    }
    output('Decompiling dbtools-common.jar...');
    const decompileCommand = `${javaExecutable} -jar ${jdCliJarPath} -od ${tempDir} ${originalJarPath}`;
    execSync(decompileCommand);

    const codeScanJavaPath = 'oracle/dbtools/raptor/newscriptrunner/commands/CodeScan.java';
    const codeScanJavaClassPath = 'oracle/dbtools/raptor/newscriptrunner/commands/CodeScan.class';

    output('Patching CodeScan.java and removing unique error filter...');
    const codeScanPath = path.join(tempDir, codeScanJavaPath);
    const codeScan = fs.readFileSync(codeScanPath, 'utf8');
    const patchedCodeScan = codeScan.replace(/^.*report = Issue\.filterUnique\(report\);.*$/m, '');
    fs.writeFileSync(codeScanPath, patchedCodeScan);

    output('Recompiling CodeScan.java...');
    // recompile the class
    const recompileCommand = `${javaCExecutable} -g -cp "${path.join(sqlClDirectory, 'lib')}/*" "${codeScanPath}"`;
    execSync(recompileCommand, { cwd: tempDir });

    output('Unpacking dbtools-common.jar...');
    // unpack original jar
    const unpackCommand = `${jarExecutable} xf ${originalJarPath}`;
    const binPath = path.join(context.extensionPath, 'bin');
    if (!fs.existsSync(binPath)) {
      fs.mkdirSync(binPath);
    }
    execSync(unpackCommand, { cwd: binPath });

    // copy patched class to the original jar
    fs.copyFileSync(
      path.join(tempDir, codeScanJavaClassPath),
      path.join(binPath, codeScanJavaClassPath),
    );

    output('Packing patched dbtools-common.jar...');
    // repack the jar
    const repackCommand = `${jarExecutable} cf dbtools-common.jar *`;
    execSync(repackCommand, { cwd: binPath });
    fs.renameSync(originalJarPath, `${originalJarPath}.bak`);
    fs.renameSync(path.join(binPath, 'dbtools-common.jar'), originalJarPath);
    fs.rmSync(binPath, { recursive: true });
    fs.rmSync(tempDir, { recursive: true });
  } catch (err) {
    output(`Error during patching: ${err}`);
  }
}
