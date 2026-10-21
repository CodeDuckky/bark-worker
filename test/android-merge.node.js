import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sender = 'AndroidMergeTestSender'
const receiver = 'android-merge-test-receiver'
const hash = value => createHash('sha256').update(value).digest('hex')
const source = await readFile(new URL('../main.js', import.meta.url), 'utf8')
const configPattern = /const androidConfig = \{[^\n]+\};/
assert.equal([...source.matchAll(new RegExp(configPattern.source, 'g'))].length, 1)
const testSource = source.replace(configPattern, `const androidConfig = ${JSON.stringify({
    keyHash: hash(sender), receiveHash: hash(receiver),
})};`)
let instance = 0

class FakeD1 {
    constructor(devices = []) {
        this.devices = new Map(devices)
        this.messages = []
        this.nextID = 1
    }

    exec(query) {
        assert.match(query, /^CREATE TABLE IF NOT EXISTS /)
        return Promise.resolve({ count: 1 })
    }

    prepare(query) {
        const statement = bindings => ({
            bind: (...values) => statement(values),
            run: async () => this.execute(query, bindings),
            all: async () => this.execute(query, bindings),
        })
        return statement([])
    }

    execute(query, bindings) {
        if (/^CREATE (TABLE|INDEX) IF NOT EXISTS android_messages/.test(query)) {
            return { results: [] }
        }
        if (query.startsWith('INSERT INTO android_messages')) {
            const [key_hash, payload, created_at] = bindings
            this.messages.push({ id: this.nextID++, key_hash, payload, created_at })
            return { results: [], success: true }
        }
        if (query.startsWith('DELETE FROM android_messages')) {
            const [key] = bindings
            const keep = new Set(this.messages.filter(row => row.key_hash === key)
                .slice(-1000).map(row => row.id))
            this.messages = this.messages.filter(row => row.key_hash !== key || keep.has(row.id))
            return { results: [] }
        }
        if (query.startsWith('SELECT id,payload,created_at FROM android_messages')) {
            const [key, after] = bindings
            return { results: this.messages.filter(row => row.key_hash === key && row.id > after)
                .sort((a, b) => a.id - b.id).slice(0, 100) }
        }
        if (query.startsWith('SELECT `token` FROM `devices`')) {
            const [key] = bindings
            return { results: this.devices.has(key) ? [{ token: this.devices.get(key) }] : [] }
        }
        if (query.startsWith('SELECT `token`, `time` FROM `authorization`')) {
            // Avoid signing with any production APNs key; all outbound traffic is mocked.
            return { results: [{ token: 'test-only-apns-authorization',
                time: String(Math.floor(Date.now() / 1000)) }] }
        }
        if (query.startsWith('INSERT INTO `devices`')) {
            this.devices.set(bindings[0], bindings[1])
            return { results: [] }
        }
        if (query.startsWith('DELETE FROM `sessions`')) return { results: [] }
        throw new Error(`Unexpected fake D1 query: ${query}`)
    }
}

async function fixture(t, devices = [], apnsStatus = 200) {
    // Unique module identity isolates the worker's token/schema caches for every test.
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(testSource).toString('base64')}#${++instance}`)
    const database = new FakeD1(devices)
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(new URL(url).hostname, 'api.push.apple.com')
        calls.push({ url, headers: init.headers, payload: JSON.parse(init.body) })
        if (apnsStatus === 'throw') throw new Error('simulated APNs network failure')
        return new Response(apnsStatus === 200 ? null : JSON.stringify({ reason: 'ServiceUnavailable' }),
            { status: apnsStatus })
    })
    async function request(path, init = {}) {
        const pending = []
        const response = await worker.fetch(new Request(`https://worker.example${path}`, init),
            { database, ROOT_PATH: '/', ALLOW_NEW_DEVICE: 'false' },
            { waitUntil: promise => pending.push(promise) })
        await Promise.all(pending)
        return response
    }
    return {
        database, calls, request,
        push: payload => request('/push', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: sender, ...payload }),
        }),
        receive: (after = 0, credential = receiver) => request(`/android/messages?after=${after}`, {
            headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
        }),
    }
}

test('receive requires its own Bearer credential and validates cursor and method', async t => {
    const f = await fixture(t)
    for (const credential of [null, 'wrong-receiver', sender]) {
        assert.equal((await f.receive(0, credential)).status, 401)
    }
    for (const cursor of ['-1', '1.5', 'NaN', '9007199254740992']) {
        assert.equal((await f.receive(cursor)).status, 400)
    }
    assert.equal((await f.request('/android/messages', { method: 'POST' })).status, 405)
    const response = await f.receive()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { messages: [], cursor: 0 })
})

test('durable receive paginates 100 messages without replay or another target leaking', async t => {
    const f = await fixture(t)
    for (let index = 0; index < 101; index++) {
        assert.equal((await f.push({ body: `message ${index}` })).status, 200)
    }
    f.database.execute('INSERT INTO android_messages', [hash('different-target'),
        JSON.stringify({ body: 'private other target' }), Date.now()])
    const first = await (await f.receive()).json()
    assert.equal(first.messages.length, 100)
    assert.deepEqual(first.messages.map(message => message.body),
        Array.from({ length: 100 }, (_, index) => `message ${index}`))
    assert.equal(first.cursor, first.messages.at(-1).id)
    assert.ok(first.messages.every(message => Number.isSafeInteger(message.createdAt)))
    const second = await (await f.receive(first.cursor)).json()
    assert.equal(second.messages.length, 1)
    assert.equal(second.messages[0].body, 'message 100')
    assert.ok(second.cursor > first.cursor)
    assert.deepEqual(await (await f.receive(second.cursor)).json(),
        { messages: [], cursor: second.cursor })
    assert.equal(f.calls.length, 0)
})

test('JSON preserves percent sequences and literal plus signs in the Android inbox', async t => {
    const f = await fixture(t)
    const payload = { title: '100% + %2F', subtitle: '%25 + literal',
        body: 'A+B / %E4%B8%AD / %2B / %invalid', group: 'group+%20',
        url: 'https://example.com/?q=a+b&literal=%252F' }
    assert.equal((await f.push(payload)).status, 200)
    const { messages } = await (await f.receive()).json()
    assert.equal(messages.length, 1)
    for (const [key, value] of Object.entries(payload)) assert.equal(messages[0][key], value)
})

test('GET path text is decoded once before entering the Android inbox', async t => {
    const f = await fixture(t)
    const title = '中文 + literal %2F'
    const body = '100% / A+B / %2520'
    const response = await f.request(`/${sender}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`)
    assert.equal(response.status, 200)
    const { messages } = await (await f.receive()).json()
    assert.equal(messages[0].title, title)
    assert.equal(messages[0].body, body)
})

for (const [label, devices] of [['missing', []], ['invalid empty', [[sender, '']]]]) {
    test(`Android-only delivery succeeds with ${label} Apple token`, async t => {
        const f = await fixture(t, devices)
        const response = await f.push({ body: 'Android only' })
        assert.equal(response.status, 200)
        assert.equal((await response.json()).android, true)
        assert.equal(f.calls.length, 0)
        assert.equal((await (await f.receive()).json()).messages[0].body, 'Android only')
    })
}

for (const failure of [503, 'throw']) {
    test(`APNs ${failure} preserves durable Android delivery and reports partial success`, async t => {
        const f = await fixture(t, [[sender, 'apple-test-token']], failure)
        const response = await f.push({ title: 'durable', body: 'survives APNs failure', id: 'collapse-test' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { code: 200, message: 'success', android: true, apple: false })
        assert.equal(f.calls.length, 1)
        assert.equal(f.calls[0].headers['apns-collapse-id'], 'collapse-test')
        assert.equal(f.calls[0].headers['apns-push-type'], 'alert')
        assert.equal(f.calls[0].payload.aps.alert.body, 'survives APNs failure')
        assert.equal((await (await f.receive()).json()).messages[0].body, 'survives APNs failure')
    })
}

test('multi-device push delivers Android and Apple independently and reports missing target', async t => {
    const apple = 'AppleMergeTestTarget'
    const missing = 'MissingMergeTestTarget'
    const f = await fixture(t, [[apple, 'other-apple-test-token']])
    const response = await f.push({ device_keys: [sender, apple, missing], body: 'batch delivery' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.deepEqual(result.data.map(({ device_key, code }) => [device_key, code]),
        [[sender, 200], [apple, 200], [missing, 400]])
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].payload.aps.alert.body, 'batch delivery')
    const { messages } = await (await f.receive()).json()
    assert.equal(messages.length, 1)
    assert.equal(messages[0].body, 'batch delivery')
})

test('encrypted Android payload is rejected without persisting ciphertext or calling APNs', async t => {
    const f = await fixture(t, [[sender, 'apple-test-token']])
    assert.equal((await f.push({ ciphertext: 'test-ciphertext', iv: 'test-iv' })).status, 503)
    assert.equal(f.database.messages.length, 0)
    assert.equal(f.calls.length, 0)
})
