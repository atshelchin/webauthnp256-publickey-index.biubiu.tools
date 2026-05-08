---
description: Use Deno instead of Node.js, Bun, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, deno.json"
alwaysApply: false
---

Default to using Deno instead of Node.js or Bun.

- Use `deno run <file>` instead of `node <file>` or `bun <file>`
- Use `deno test` instead of `jest` or `vitest` or `bun test`
- Use `deno task <script>` instead of `npm run <script>`
- Use `deno compile` to build standalone binaries
- Use `--env` flag to load .env files, or rely on systemd `EnvironmentFile`

## APIs

- `Deno.serve()` for HTTP servers. Don't use `express`.
- `@db/sqlite` (jsr) for SQLite. Don't use `better-sqlite3` or `bun:sqlite`.
- `Deno.readFile()` / `Deno.writeFile()` for file I/O.
- `Deno.mkdir()` / `Deno.remove()` for filesystem operations.
- `Deno.env.get()` for environment variables.
- `new Deno.Command()` for shell commands.
- `@std/encoding` for base64url/hex conversions.

## Dependencies

Managed via `deno.json` import map. Key dependencies:
- `@noble/curves` - P256 elliptic curve operations
- `@noble/hashes` - SHA256 hashing
- `s3-lite-client` - S3/R2 compatible object storage
- `@std/assert` - Test assertions

## Testing

Use `deno test` to run tests.

```ts#index.test.ts
import { assertEquals } from "@std/assert/";

Deno.test("hello world", () => {
  assertEquals(1, 1);
});
```

## Development

```sh
deno task dev    # Hot reload development
deno task test   # Run tests
deno task build  # Build binary
```
