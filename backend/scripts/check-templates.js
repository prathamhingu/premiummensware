'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ejs = require('ejs');
const root = path.join(__dirname, '..', '..', 'frontend', 'views');

async function walk(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ejs')) result.push(full);
  }
  return result;
}

(async () => {
  const files = await walk(root);
  for (const file of files) {
    ejs.compile(await fs.readFile(file, 'utf8'), { filename: file });
  }
  console.log(`EJS syntax checks passed for ${files.length} templates.`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
