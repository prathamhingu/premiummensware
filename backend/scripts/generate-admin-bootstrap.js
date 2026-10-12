'use strict';

const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');

async function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this script in an interactive VS Code terminal; hidden password input is not available in a piped terminal.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      try { input.setRawMode(false); } catch { /* terminal may already be closing */ }
      input.pause();
      process.stdout.write('\n');
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let username;
  try {
    username = (await rl.question('Choose production admin username (3–40 characters; letters, numbers, dot, underscore, hyphen): ')).trim();
  } finally {
    rl.close();
  }
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) throw new Error('Invalid username.');
  const password = await readHidden('Choose production admin password (12–72 UTF-8 bytes): ');
  const confirmation = await readHidden('Confirm admin password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) throw new Error('Admin password must be 12–72 UTF-8 bytes.');
  const hash = await bcrypt.hash(password, 12);
  process.stdout.write('\nAdd these values to the hosting Environment settings. On Render Free, keep them configured; on persistent storage, remove them after verifying the initial admin login.\n');
  process.stdout.write(`INITIAL_ADMIN_USERNAME=${username}\n`);
  process.stdout.write(`INITIAL_ADMIN_BCRYPT_HASH=${hash}\n`);
  process.stdout.write('\nFor Render Free, keep both INITIAL_ADMIN_* variables in the host settings so the account can be recreated after an ephemeral filesystem reset. On a persistent-storage deployment, remove them after verifying the first administrator login.\n');
}

main().catch((error) => {
  console.error(`Could not generate administrator bootstrap values: ${error.message}`);
  process.exitCode = 1;
});
