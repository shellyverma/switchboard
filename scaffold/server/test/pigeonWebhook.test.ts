import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyPigeonSignature } from '../src/pigeonWebhook.js';

const secret = 'test-secret';
const nowSeconds = 1_800_000_000;

function signatureFor(body: Buffer, timestamp: number): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test('accepts a signature calculated over the exact raw body', () => {
  const body = Buffer.from('{"text":"hello"}');

  assert.equal(verifyPigeonSignature(body, signatureFor(body, nowSeconds), secret, nowSeconds), true);
});

test('rejects a signature when the raw body changes', () => {
  const signedBody = Buffer.from('{"text":"hello"}');
  const receivedBody = Buffer.from('{"text": "hello"}');

  assert.equal(
    verifyPigeonSignature(receivedBody, signatureFor(signedBody, nowSeconds), secret, nowSeconds),
    false,
  );
});

test('rejects malformed, stale, and too-far-in-the-future signatures', () => {
  const body = Buffer.from('{}');

  assert.equal(verifyPigeonSignature(body, undefined, secret, nowSeconds), false);
  assert.equal(verifyPigeonSignature(body, 't=bad,v1=bad', secret, nowSeconds), false);
  assert.equal(
    verifyPigeonSignature(body, signatureFor(body, nowSeconds - 301), secret, nowSeconds),
    false,
  );
  assert.equal(
    verifyPigeonSignature(body, signatureFor(body, nowSeconds + 301), secret, nowSeconds),
    false,
  );
});
