require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const bcrypt = require('bcryptjs');
const { getAdmin, saveAdmin, ensureDataFiles } = require('../lib/store');

async function main() {
  await ensureDataFiles();
  const existing = await getAdmin();
  const rl = readline.createInterface({ input, output });
  try {
    if (existing) {
      const answer = (await rl.question('An admin account already exists. Replace its username/password? Type REPLACE to continue: ')).trim();
      if (answer !== 'REPLACE') {
        console.log('No changes made.');
        return;
      }
    }
    const username = (await rl.question('Choose admin username (3–40 characters): ')).trim();
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
      throw new Error('Username must be 3–40 characters and contain only letters, numbers, dot, underscore, or hyphen.');
    }
    const password = await rl.question('Choose admin password (minimum 12 characters): ');
    if (password.length < 12) throw new Error('Password must be at least 12 characters.');
    if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('Password must not exceed 72 UTF-8 bytes.');
    const passwordHash = await bcrypt.hash(password, 12);
    await saveAdmin({ username, passwordHash, updatedAt: new Date().toISOString() });
    console.log(`Admin account saved for "${username}". Keep the backend/data/admin.json file private and backed up.`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Could not create admin: ${error.message}`);
  process.exitCode = 1;
});
