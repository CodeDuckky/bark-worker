import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// All D1 writes use the isolated local database supplied by the Workers test pool.
it('responds to ping', async () => {
  const response = await exports.default.fetch('https://worker.test/ping');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({code: 200, message: 'pong'});
});
it('responds to the health probe', async () => {
  const response = await exports.default.fetch('https://worker.test/healthz');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('ok');
});
it('registers a device against local D1', async () => {
  const response = await exports.default.fetch('https://worker.test/register?devicetoken=local-test-token');
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.code).toBe(200);
  expect(result.data.device_key).toBeTruthy();
  expect(result.data.device_token).toBe('local-test-token');
});
it('responds to the upstream root health probe', async () => {
  const response = await exports.default.fetch('https://worker.test/');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('ok');
});
