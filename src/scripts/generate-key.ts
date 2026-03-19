import { randomBytes, createHash } from 'node:crypto';

const keyHex = randomBytes(32).toString('hex');
const fingerprint = createHash('sha256').update(keyHex).digest('hex').slice(0, 16);

console.log(`Key: ${keyHex}`);
console.log(`Fingerprint: ${fingerprint}`);
console.log(`\nAdd to keys.json: {"key":"${keyHex}"}`);
