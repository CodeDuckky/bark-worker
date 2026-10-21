# Automatic deployment

Repository: https://github.com/CodeDuckky/bark-worker

Production Worker: `bark-worker`. The production branch is `master`.

Cloudflare Workers Builds is the deployment owner. Pushes and merges to
`master` first run `npm run check` and then `npx wrangler deploy`.
The repository root is `/`, Node.js is pinned to 22 in `.node-version`, and
non-production branch builds are disabled.

GitHub Actions runs the same checks on pushes and pull requests, without a
second deployment job. Dependabot checks npm dependencies and GitHub Actions
weekly and opens PRs. Updates require review and a merge; no auto-merge is set.

Bark keeps the existing `database` D1 binding and database `database_bark`, configured in `wrangler.jsonc`. `keep_vars` preserves production environment variables; upstream example variables are not applied over existing settings. Builds do not create databases, run remote schema migrations, or send push notifications. Tests use local isolated D1 and mocked APNs.

Upstream MCP migrations are retained for explicit administration. There is no `predeploy` migration hook: the Worker initializes the existing devices/authorization tables and the new MCP sessions table idempotently at runtime, while the Android inbox initializes its own table on demand. GitHub Actions checks feature branches before they are merged to `master`.

## Local checks

```sh
npm ci
npm run check
```

## Rollback

Restore a prior deployment in the existing Worker's Cloudflare Deployments
page, then revert the problem change on `master` to align the source.
Pre-automation deployment version: `4df62c9f-47d4-4018-b925-13bb680dbb1a`.

## Android inbox

The existing sender URL also saves messages for the configured Android receiver. Apple APNs delivery continues; a response with `android:true` confirms durable Android inbox storage, while `apple` reports the APNs result when attempted.

`GET /android/messages?after=<id>` requires a separate bearer receive token. Only its SHA-256 digest is stored in source; the installed personal Android app holds the token privately. Never use the public sender key as the receive credential. Responses are not cached, use ascending IDs and include a cursor for offline catch-up. The latest 1000 messages are retained.

On the first authorized inbox read or matching push, the Worker creates `android_messages` and its index idempotently using its existing D1 binding. No separate database-management API permission is needed. Existing device records remain unchanged. Android encrypted Bark payloads are currently unsupported and return an error. The Android app polls while its foreground receive service is enabled; Android sleep or network conditions may delay delivery.
