const fs = require('fs');
const path = require('path');

export function emptyDirectory(directory: any) {
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

export function copySqlFiles(source: string, target: string) {
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
