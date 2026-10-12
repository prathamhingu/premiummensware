'use strict';

const session = require('express-session');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class FileSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.directory = options.directory || path.join(__dirname, '..', 'data', 'sessions');
    this.ttlMs = options.ttlMs || 8 * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanupExpired().catch((error) => console.error('Session cleanup failed:', error.message)), 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  fileFor(sid) {
    return path.join(this.directory, `${crypto.createHash('sha256').update(String(sid)).digest('hex')}.json`);
  }

  expiryFor(sess) {
    const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    if (Number.isFinite(cookieExpires)) return cookieExpires;
    const maxAge = Number(sess?.cookie?.originalMaxAge);
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs);
  }

  async write(sid, sess) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.fileFor(sid);
    const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ expiresAt: this.expiryFor(sess), session: sess }), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file).catch(async (error) => { await fs.unlink(temp).catch(() => {}); throw error; });
  }

  get(sid, callback) {
    fs.readFile(this.fileFor(sid), 'utf8').then(async (raw) => {
      const record = JSON.parse(raw);
      if (!record || !record.session || Number(record.expiresAt) <= Date.now()) {
        await fs.unlink(this.fileFor(sid)).catch(() => {});
        return callback(null, null);
      }
      callback(null, record.session);
    }).catch((error) => callback(error.code === 'ENOENT' ? null : error, null));
  }

  set(sid, sess, callback = () => {}) {
    this.write(sid, sess).then(() => callback(null)).catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    this.write(sid, sess).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    fs.unlink(this.fileFor(sid)).then(() => callback(null)).catch((error) => callback(error.code === 'ENOENT' ? null : error));
  }

  async cleanupExpired() {
    await fs.mkdir(this.directory, { recursive: true });
    const names = await fs.readdir(this.directory).catch(() => []);
    const now = Date.now();
    await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const file = path.join(this.directory, name);
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!record?.session || Number(record.expiresAt) <= now) await fs.unlink(file).catch(() => {});
      } catch {
        await fs.unlink(file).catch(() => {});
      }
    }));
  }
}

module.exports = FileSessionStore;
