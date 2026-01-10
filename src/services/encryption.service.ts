/**
 * API Key Encryption Service
 * 
 * Provides encryption/decryption for sensitive data like API keys
 * using AES-256-GCM encryption with unique IVs per encryption
 */

import * as crypto from 'crypto';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// Get encryption key from environment or generate a warning
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    // In development, use a derived key (NOT for production)
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Encryption] WARNING: Using derived encryption key. Set ENCRYPTION_KEY env var for production.');
      return crypto.scryptSync('dev-encryption-key', 'salt', 32);
    }
    throw new Error('ENCRYPTION_KEY environment variable is required for production');
  }
  
  // Key should be a 64-character hex string (32 bytes)
  if (key.length === 64) {
    return Buffer.from(key, 'hex');
  }
  
  // If key is not hex, derive it
  return crypto.scryptSync(key, 'qa-platform-salt', 32);
}

let encryptionKey: Buffer | null = null;

function getKey(): Buffer {
  if (!encryptionKey) {
    encryptionKey = getEncryptionKey();
  }
  return encryptionKey;
}

/**
 * Encrypt a plaintext string
 * Returns: base64 encoded string containing IV + AuthTag + Ciphertext
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Combine IV + AuthTag + Encrypted data
  const combined = Buffer.concat([
    iv,
    authTag,
    Buffer.from(encrypted, 'hex')
  ]);
  
  return combined.toString('base64');
}

/**
 * Decrypt an encrypted string
 * Input: base64 encoded string containing IV + AuthTag + Ciphertext
 */
export function decrypt(encryptedData: string): string {
  if (!encryptedData) return encryptedData;
  
  try {
    const key = getKey();
    const combined = Buffer.from(encryptedData, 'base64');
    
    // Extract IV, AuthTag, and Ciphertext
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  } catch (error) {
    // If decryption fails, the data might be unencrypted (legacy)
    // Return as-is for backward compatibility during migration
    console.warn('[Encryption] Decryption failed, returning original data (may be unencrypted legacy data)');
    return encryptedData;
  }
}

/**
 * Check if a string appears to be encrypted
 * (base64 encoded with minimum length for IV + AuthTag + some data)
 */
export function isEncrypted(data: string): boolean {
  if (!data) return false;
  
  // Minimum length: IV (16) + AuthTag (16) + at least 1 byte = 33 bytes = 44 base64 chars
  if (data.length < 44) return false;
  
  // Check if it's valid base64
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  if (!base64Regex.test(data)) return false;
  
  try {
    const decoded = Buffer.from(data, 'base64');
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Mask an API key for display (show only last 4 characters)
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return '****';
  return `****${apiKey.slice(-4)}`;
}

/**
 * Encrypt if not already encrypted
 */
export function ensureEncrypted(data: string): string {
  if (isEncrypted(data)) {
    return data;
  }
  return encrypt(data);
}

/**
 * Hash sensitive data for comparison (one-way)
 */
export function hashSensitiveData(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export const encryptionService = {
  encrypt,
  decrypt,
  isEncrypted,
  maskApiKey,
  ensureEncrypted,
  hashSensitiveData,
};

export default encryptionService;
