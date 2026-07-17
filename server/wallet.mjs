import { getAddress, verifyMessage } from 'ethers';
import { randomToken } from './security.mjs';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function normalizeWalletAddress(address) {
  try { return getAddress(String(address || '')); }
  catch { throw new Error('A valid EVM wallet address is required.'); }
}

export function createWalletChallenge({ origin, address, chainId, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const normalizedAddress = normalizeWalletAddress(address);
  const numericChainId = Number(chainId);
  if (!Number.isInteger(numericChainId) || numericChainId <= 0) throw new Error('A valid EVM chain ID is required.');
  const parsedOrigin = new URL(origin);
  const domain = parsedOrigin.host;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = now + ttlMs;
  const expirationTime = new Date(expiresAt).toISOString();
  const nonce = randomToken(16);
  const message = `${parsedOrigin.protocol}//${domain} wants you to sign in with your Ethereum account:\n${normalizedAddress}\n\nSign in to Vector trading cockpit.\n\nURI: ${parsedOrigin.origin}\nVersion: 1\nChain ID: ${numericChainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
  return { nonce, address: normalizedAddress, chainId: numericChainId, message, issuedAt, expiresAt };
}

export function verifyWalletChallenge({ record, address, chainId, message, signature, now = Date.now() }) {
  if (!record || record.consumed) throw new Error('Wallet challenge is invalid or already used.');
  if (now > record.expiresAt) throw new Error('Wallet challenge has expired.');
  const normalizedAddress = normalizeWalletAddress(address);
  if (normalizedAddress !== record.address) throw new Error('Wallet address does not match the challenge.');
  if (Number(chainId) !== record.chainId) throw new Error('Wallet chain changed during sign-in.');
  if (message !== record.message) throw new Error('Signed message does not match the challenge.');
  const recoveredAddress = normalizeWalletAddress(verifyMessage(message, signature));
  if (recoveredAddress !== normalizedAddress) throw new Error('Wallet signature could not be verified.');
  return { address: normalizedAddress, chainId: record.chainId };
}
