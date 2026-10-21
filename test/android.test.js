import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('requires a separate credential to read the Android inbox', async () => {
  for (const headers of [{}, {Authorization: 'Bearer invalid-token'}]) {
    const response = await exports.default.fetch('https://worker.test/android/messages', {headers});
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({error:'Unauthorized'});
  }
});

it('does not accept writes to the Android receive endpoint', async () => {
  const response = await exports.default.fetch('https://worker.test/android/messages', {method:'POST'});
  expect(response.status).toBe(405);
});
