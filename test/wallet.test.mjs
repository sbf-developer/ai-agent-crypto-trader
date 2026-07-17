import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createWalletChallenge, verifyWalletChallenge } from '../server/wallet.mjs';

test('wallet challenge verifies a real EVM signature', async () => {
  const wallet = Wallet.createRandom();
  const challenge = createWalletChallenge({ origin: 'http://localhost:4173', address: wallet.address, chainId: 1, now: 1700000000000 });
  const signature = await wallet.signMessage(challenge.message);
  const verified = verifyWalletChallenge({ record: { ...challenge, consumed: false }, address: wallet.address, chainId: 1, message: challenge.message, signature, now: 1700000001000 });
  assert.equal(verified.address, wallet.address);
  assert.equal(verified.chainId, 1);
});

test('wallet challenge rejects a tampered message', async () => {
  const wallet = Wallet.createRandom();
  const challenge = createWalletChallenge({ origin: 'http://localhost:4173', address: wallet.address, chainId: 1 });
  const signature = await wallet.signMessage(challenge.message);
  assert.throws(() => verifyWalletChallenge({ record: { ...challenge, consumed: false }, address: wallet.address, chainId: 1, message: `${challenge.message}!`, signature }), /match/);
});

test('wallet challenge rejects replay and expiry', async () => {
  const wallet = Wallet.createRandom();
  const challenge = createWalletChallenge({ origin: 'http://localhost:4173', address: wallet.address, chainId: 1, now: 1700000000000, ttlMs: 1000 });
  const signature = await wallet.signMessage(challenge.message);
  assert.throws(() => verifyWalletChallenge({ record: { ...challenge, consumed: false }, address: wallet.address, chainId: 1, message: challenge.message, signature, now: 1700000001001 }), /expired/);
  assert.throws(() => verifyWalletChallenge({ record: { ...challenge, consumed: true }, address: wallet.address, chainId: 1, message: challenge.message, signature }), /already used/);
});
