'use strict';

const { hashPreviewPassword } = require('../lib/preview-auth');

async function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this script in an interactive VS Code terminal; hidden password input is not available in a piped terminal.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buffer) => {
      const chunk = buffer.toString('utf8');
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
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
  try {
    const first = await readHidden('Choose a private preview password (at least 14 characters): ');
    const second = await readHidden('Confirm preview password: ');
    if (first !== second) throw new Error('Passwords do not match.');
    const hash = await hashPreviewPassword(first);
    process.stdout.write('\nCopy this value into your hosting Environment settings as PREVIEW_PASSWORD_HASH.\n\n');
    process.stdout.write(`PREVIEW_PASSWORD_HASH=${hash}\n`);
    process.stdout.write('\nKeep the password private and share it separately from the URL. The hash should also remain in private hosting configuration.\n');
  } finally {
    // Do not retain password references longer than needed.
  }
}

main().catch((error) => {
  console.error(`Could not generate preview password hash: ${error.message}`);
  process.exitCode = 1;
});
