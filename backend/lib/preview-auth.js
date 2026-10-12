'use strict';

const crypto = require('node:crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_PASSWORD_BYTES = 1024;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) return reject(error);
      resolve(key);
    });
  });
}

function parsePreviewPasswordHash(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Keep parameters bounded; the application only accepts hashes produced by our generator.
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { N, r, p, salt, key };
}

function isValidPreviewPasswordHash(value) {
  return Boolean(parsePreviewPasswordHash(value));
}

async function hashPreviewPassword(password) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string.');
  if (Buffer.byteLength(password, 'utf8') < 14) throw new Error('Preview password must be at least 14 UTF-8 bytes long.');
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) throw new Error('Preview password is too long.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPreviewPassword(password, encodedHash) {
  const parsed = parsePreviewPasswordHash(encodedHash);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;
  const derived = await scryptAsync(password, parsed.salt, parsed.key.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM
  });
  return derived.length === parsed.key.length && crypto.timingSafeEqual(derived, parsed.key);
}

module.exports = {
  hashPreviewPassword,
  verifyPreviewPassword,
  isValidPreviewPasswordHash,
  parsePreviewPasswordHash
};
