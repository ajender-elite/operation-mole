# Contributing to OM

Read [CLAUDE.md](CLAUDE.md) for commands, layout and domain rules, and [docs/](docs/README.md) for design. This file holds the TypeScript guidelines every change must follow, plus the few places where OM deliberately deviates.

## How OM applies these guidelines

`pnpm check` enforces most rules (typecheck, ESLint with `--max-warnings=0`, Prettier, tests). `pnpm test:coverage` enforces the coverage thresholds.

Deviations, each also documented where it applies:

| Guideline                                                         | OM                                                                                                                                                                                       | Why                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| §2 layout (`src/domain`, `services`, `adapters`, one package)     | A pnpm workspace: `apps/server`, `apps/web`, `packages/shared`. The server is grouped by feature (`compare/`, `git/`, `store/`, `config/`).                                              | It's an app with two runtimes and shared API types, not a library.                                                         |
| §2 unit tests next to the source                                  | Web and shared tests are co-located. Server tests live in `apps/server/test/`.                                                                                                           | Nearly all server tests are integration tests on real folders and real git repos (see [docs/testing.md](docs/testing.md)). |
| §3/§4 build to `dist/`, `tsconfig.build.json`, production runs JS | `noEmit` + `allowImportingTsExtensions`. The server runs its `.ts` with Node's type stripping, also in production. Vite bundles the web app. `@om/shared` is consumed as source.         | No build step to keep in sync. Revisit if the server needs to ship without its sources.                                    |
| §3 `exports`/`files`/library scripts                              | Packages are `private`; only `@om/shared` has `exports` (pointing at TS source).                                                                                                         | Nothing is published.                                                                                                      |
| §6 functions are camelCase                                        | In `.tsx`, functions and component-typed parameters may be PascalCase (ESLint override in `eslint.config.mjs`).                                                                          | React requires component names to start with a capital letter.                                                             |
| §7.4 `Result` for expected failures                               | `Result` (`apps/server/src/result.ts`) for config loading. Request handling throws `CompareInputError`/`NotFoundError`/`ConflictError`, which `app.ts` maps to 400/404/409 in one place. | One error mapping for every route, instead of unwrapping a `Result` in each.                                               |
| §11 no real I/O in unit tests                                     | Server tests use real temp folders and real git.                                                                                                                                         | The edge cases (symlinks, CRLF, permissions, git behavior) only show with the real thing.                                  |
| §5 `unicorn/no-array-for-each`                                    | `unicorn/no-for-each`                                                                                                                                                                    | Same rule, renamed in eslint-plugin-unicorn 80.                                                                            |

Not adopted yet (open work, not deviations): branded types for ids (§7.1), `AbortSignal` on clone, fetch, checkout and folder walks (§7.5; git analysis commands already take one), and `readonly` throughout public signatures (§7.3).

---

# TypeScript Contributing Guidelines

> Mandatory rules for every TypeScript project.
> "MUST" is enforced by tooling or is mandatory. "SHOULD" is the default; deviations need a documented reason in code.

---

## 1. Toolchain Baseline

| Concern            | Choice                                   | Notes                                                           |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| Runtime            | Node.js 26 LTS                           | Pinned via `.nvmrc` + `engines`                                 |
| Language           | TypeScript 6.0.x (pinned, exact)         | Move to 7.x once typescript-eslint supports it                  |
| Package manager    | pnpm (pinned in `packageManager`)        | Single lockfile, strict `node_modules`, fast on all OSes        |
| Lint               | ESLint (flat config) + typescript-eslint | Type-aware rules (`strictTypeChecked`)                          |
| Format             | Prettier                                 | ESLint never formats; `eslint-config-prettier` disables clashes |
| Test               | Vitest                                   | Native TS/ESM, built-in coverage                                |
| Run TS directly    | Node.js native type stripping            | `node file.ts`; production runs compiled JS                     |
| Runtime validation | zod                                      | All external input (env, files, network, CLI args)              |

Rules:

- MUST pin `typescript` to an exact version (no `^`).
- The lockfile `pnpm-lock.yaml` is mandatory. Clean installs MUST use `pnpm install --frozen-lockfile`.
- MUST NOT mix package managers. Use pnpm only; never `npm install` or `yarn`.
- SHOULD prefer the Node standard library (`node:fs/promises`, `node:path`, `node:util`, `fetch`, `AbortController`, `structuredClone`) over third-party packages.
- New dependencies MUST be actively maintained, widely adopted, typed (bundled types or `@types/*`), and ESM-compatible.

---

## 2. Project Scaffolding

```
<project-root>/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── scripts/                 # Project automation, written in TS (never bash/PowerShell)
├── src/
│   ├── index.ts             # Public entry point (exports only, no logic)
│   ├── config/              # Env/config loading + zod schemas
│   ├── domain/              # Pure types and business logic, no I/O
│   ├── services/            # Orchestration, I/O, side effects
│   ├── adapters/            # External systems (fs, http, db, cli)
│   └── utils/               # Small, generic, pure helpers
├── test/                    # Integration / e2e tests
├── .editorconfig
├── .env.example
├── .nvmrc
├── .prettierrc.json
├── .prettierignore
├── eslint.config.mjs
├── package.json
├── tsconfig.json            # Editor + type-check (includes tests, scripts)
├── tsconfig.build.json      # Emit only src/
├── vitest.config.ts
├── README.md
└── CONTRIBUTING.md
```

Rules:

- Unit tests MUST live next to the source file: `parse-config.ts` → `parse-config.test.ts`.
- `domain/` MUST NOT import from `services/` or `adapters/` (dependencies point inward).
- MUST NOT create catch-all files (`helpers.ts`, `misc.ts`, `common.ts`). Name files by what they do.
- Barrel files (`index.ts` re-exports) are allowed ONLY at the package's public entry point.

---

## 3. package.json

```json
{
  "name": "@scope/project-name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@<exact-version>",
  "engines": { "node": ">=26" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "pnpm clean && tsc -p tsconfig.build.json",
    "clean": "node scripts/clean.ts",
    "dev": "node --watch src/index.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix",
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test"
  }
}
```

Rules:

- `"type": "module"` is mandatory. No CommonJS in new code.
- Scripts MUST be cross-platform. Sequencing with `&&` is fine; anything else is not: no `rm -rf`, `cp`, `export VAR=`, pipes, or single-quoted globs. Put non-trivial logic in `scripts/*.ts`.
- `pnpm check` MUST pass with zero errors and zero warnings.

---

## 4. tsconfig (Strictest Practical Setting)

`tsconfig.json`

```jsonc
{
  "compilerOptions": {
    /* Language & runtime */
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],

    /* Strictness */
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    /* Module hygiene */
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "rewriteRelativeImportExtensions": true,

    /* Output */
    "rootDir": ".",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmitOnError": true,
    "newLine": "lf",
    "skipLibCheck": true,
  },
  "include": ["src", "test", "scripts", "*.ts"],
  "exclude": ["dist", "node_modules", "coverage"],
}
```

`tsconfig.build.json`

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"],
}
```

Rules:

- MUST NOT use deprecated/legacy options: `baseUrl`, `moduleResolution: node`/`node10`, `target: es5`, `module: amd`/`umd`/`system`.
- MUST NOT use import aliases (`paths` or `package.json` `imports`). Use relative imports; if a path climbs more than two levels, restructure the modules.
- Relative imports MUST include the `.ts` extension (`import { x } from './parse-config.ts'`); `rewriteRelativeImportExtensions` emits `.js`.
- `erasableSyntaxOnly` forbids syntax that Node cannot strip: `enum`, runtime `namespace`, constructor parameter properties, and `import x = require()`. Use the alternatives in §7.1 and §7.2.
- MUST NOT disable any strict flag.

---

## 5. ESLint (Flat Config)

The configuration lives in [`eslint.config.mjs`](eslint.config.mjs). It follows this template, plus React (hooks, refresh) and the `.tsx` naming override described above.

```js
// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', '**/*.generated.ts']),

  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { unicorn },
    rules: {
      /* Type safety */
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /* Imports */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../../../*'], message: 'Import path too deep; restructure the modules.' },
          ],
        },
      ],

      /* Style that affects correctness */
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/array-type': [
        'error',
        { default: 'array-simple', readonly: 'array-simple' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/no-for-each': 'error', // `no-array-for-each` before eslint-plugin-unicorn 80
      'unicorn/prefer-structured-clone': 'error',

      /* Naming (see §6). More specific selectors override 'default'. */
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        {
          selector: 'variable',
          modifiers: ['const', 'global'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
        },
        {
          selector: 'variable',
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: ['is', 'has', 'can', 'should', 'did', 'will'],
        },
        {
          selector: 'parameter',
          modifiers: ['unused'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'typeParameter',
          format: ['PascalCase'],
          custom: { regex: '^(T|T[A-Z][A-Za-z]+)$', match: true },
        },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
      ],
    },
  },

  /* Plain JS/config files: no type-aware rules */
  { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },

  /* Tests: relax rules that hurt test readability */
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  prettier, // MUST be last
);
```

Dependencies (single line so it works in bash, zsh, PowerShell, and cmd):

```
pnpm add zod
pnpm add -D typescript@<exact-6.0.x> @types/node@26 eslint @eslint/js typescript-eslint eslint-plugin-unicorn eslint-config-prettier prettier vitest @vitest/coverage-v8
```

Rules:

- `--max-warnings=0`: warnings are treated as errors.
- `eslint-disable` MUST target a single rule on a single line and carry a reason:
  `// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- third-party lib has no types`
- MUST NOT use `eslint-plugin-prettier`. Prettier runs as a separate tool.

---

## 6. Naming Rules

| Element                        | Convention                          | Example                                    |
| ------------------------------ | ----------------------------------- | ------------------------------------------ |
| Files & directories            | kebab-case                          | `user-session.ts`, `http-client/`          |
| Test files                     | `<name>.test.ts`                    | `user-session.test.ts`                     |
| Types, classes                 | PascalCase, noun                    | `UserSession`, `RetryPolicy`               |
| Functions, methods             | camelCase, verb-first               | `parseConfig()`, `fetchUser()`             |
| Variables, parameters          | camelCase, noun                     | `retryCount`, `sessionId`                  |
| Booleans                       | `is/has/can/should/did/will` prefix | `isEnabled`, `hasAccess`                   |
| Module-level true constants    | UPPER_SNAKE_CASE                    | `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT_MS`    |
| Const lookup objects & schemas | PascalCase                          | `LogLevel.Error`, `ConfigSchema`           |
| Generic type parameters        | `T` or `T` + PascalCase             | `T`, `TKey`, `TValue`, `TResult`           |
| Async functions                | Verb describing the result          | `loadManifest()` (NOT `loadManifestAsync`) |
| Callback props / options       | `on` + Event                        | `onClose`                                  |
| Handler implementations        | `handle` + Event                    | `handleClose`                              |
| Units                          | Suffix with unit                    | `timeoutMs`, `sizeBytes`, `rateHz`         |

Rules:

- No `I` prefix for interfaces, no `T` prefix for type aliases, no Hungarian notation.
- No abbreviations except universally known ones (`id`, `url`, `http`, `json`, `io`). Acronyms are words: `HttpClient`, `parseJson`, `userId` (NOT `HTTPClient`, `parseJSON`).
- Collections are plural: `users`; maps are named `<value>By<Key>`: `sessionsById`.
- Names describe intent, not type: `activeUsers`, not `userArray`.
- File name = primary export in kebab-case: `RetryPolicy` → `retry-policy.ts`.

---

## 7. Language & Typing Practices

### 7.1 Types

- Prefer `type` aliases. Use `interface` only when declaration merging is required (e.g., augmenting third-party types), with a targeted `eslint-disable` for `consistent-type-definitions` and a reason.
- MUST NOT use `any`. Use `unknown` and narrow it.
- MUST NOT use non-null `!` or type-assertion casts (`value as Foo`) in production code. `as const` is allowed. Use `satisfies` to check shape without widening:
  ```ts
  const defaults = { timeoutMs: 5_000, retries: 3 } satisfies ClientOptions;
  ```
- Exported functions MUST have explicit parameter and return types.
- Replace constructor parameter properties with explicit field declarations assigned in the constructor.
- Model state with discriminated unions, not a bag of optional fields:
  ```ts
  type FetchState<T> =
    | { readonly status: 'idle' }
    | { readonly status: 'loading' }
    | { readonly status: 'success'; readonly data: T }
    | { readonly status: 'error'; readonly error: Error };
  ```
- Enforce exhaustiveness:
  ```ts
  function assertNever(value: never): never {
    throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
  }
  ```
- Use branded types for IDs and units so they cannot be mixed up:
  ```ts
  declare const brand: unique symbol;
  type Brand<T, TName extends string> = T & { readonly [brand]: TName };
  type UserId = Brand<string, 'UserId'>;
  type Milliseconds = Brand<number, 'Milliseconds'>;
  ```
  Create branded values only inside a validating constructor function (e.g., `toUserId(raw: string): Result<UserId>`). This is the single permitted place for an `as` cast in production code.

### 7.2 Enums → const objects

```ts
export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
```

### 7.3 Immutability

- Default to `readonly` properties and read-only collections in public signatures: `readonly T[]` for simple element types, `ReadonlyArray<A | B>` for complex ones, `ReadonlyMap`, `ReadonlySet`.
- Never mutate function arguments. Return new values (`toSorted`, `toReversed`, `with`, spread).
- `const` by default; `let` only when reassignment is required; never `var`.

### 7.4 Error handling

- Only throw `Error` subclasses. Set `cause` when wrapping:
  ```ts
  throw new ConfigError('Failed to read config', { cause: error });
  ```
- Use a `Result` type for expected failures (validation, parsing, not-found); throw only for programmer errors and truly exceptional conditions:
  ```ts
  type Result<T, E = Error> =
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
  ```
- `catch (error)` variables are `unknown`; narrow with `error instanceof Error`.
- Never swallow errors silently. Every `catch` must rethrow, return a `Result`, or log with context.

### 7.5 Async

- No floating promises. Every promise is `await`ed, returned, or explicitly `void`ed with a comment.
- Use `Promise.all` / `Promise.allSettled` for independent work; never `await` in a loop when parallel execution is safe.
- Long-running or I/O operations MUST accept an `AbortSignal`.
- No callback-style APIs in new code; use `node:fs/promises`, `node:timers/promises`, etc.

### 7.6 Validation at boundaries

- All untrusted data (env vars, JSON files, HTTP bodies, CLI args) MUST be parsed with a zod schema. Types are derived from the schema:
  ```ts
  const ConfigSchema = z.object({ port: z.coerce.number().int().positive() });
  type Config = z.infer<typeof ConfigSchema>;
  ```
- Inside the boundary, trust the types; do not re-validate.

### 7.7 Modules

- Named exports only. No `default` exports (exception: config files whose tool requires them).
- One primary concept per file; keep files under ~300 lines.
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
- No circular imports.

---

## 8. Cross-Platform Rules (Linux, macOS, Windows)

- Paths: ALWAYS use `node:path` (`path.join`, `path.resolve`). Never concatenate with `/` or `\`.
- Module-relative paths: use `import.meta.dirname` / `import.meta.filename`, not `__dirname`.
- File URLs: convert with `fileURLToPath` / `pathToFileURL` from `node:url`.
- Line endings: LF everywhere (enforced by `.editorconfig`, Prettier `endOfLine: "lf"`, tsconfig `newLine: "lf"`). Use `os.EOL` only for console/terminal output.
- Case sensitivity: macOS/Windows file systems are case-insensitive by default, Linux is not. Kebab-case filenames + `forceConsistentCasingInFileNames` prevent "works on my machine" bugs.
- No shell assumptions: no bash, PowerShell, `rm`, `cp`, `which`, `/tmp`. Use `fs.rm(path, { recursive: true, force: true })`, `fs.cp`, `os.tmpdir()`, `os.homedir()`.
- Child processes: use `execFile`/`spawn` with an args array; never build command strings. On Windows, `.cmd`/`.bat` shims (e.g., `pnpm`, `npx`) cannot be spawned without a shell; prefer invoking `process.execPath` with the target `.js` script, or use a vetted wrapper library.
- Env vars: read through the validated config module only; never set env vars inline in package scripts.
- File names MUST avoid characters invalid on Windows (`< > : " / \ | ? *`) and reserved names (`con`, `nul`, `aux`, `prn`, `com1`, `lpt1`, ...).
- Keep path depth modest; avoid deeply nested generated directories (Windows path-length limits).
- Tests MUST NOT depend on path separators, line endings, timezone, or locale; set `TZ`/locale explicitly where needed.
- `pnpm check` and `pnpm build` MUST pass on Linux, macOS, and Windows.

---

## 9. Data Structure Selection

| Need                           | Use                                                | Avoid                             |
| ------------------------------ | -------------------------------------------------- | --------------------------------- |
| Dynamic key → value lookup     | `Map<K, V>`                                        | Plain object as dictionary        |
| Membership test / uniqueness   | `Set<T>`                                           | `array.includes()` in hot paths   |
| Fixed, known keys              | `type` / object literal                            | `Map`                             |
| Exhaustive key → value table   | `Record<Union, V>` with `satisfies`                | `Record<string, V>`               |
| Ordered list                   | `readonly T[]`                                     | Sparse arrays, `new Array(n)`     |
| Fixed-length heterogeneous     | Named tuple `[start: number, end: number]`         | Unnamed tuples in public APIs     |
| Cache keyed by object lifetime | `WeakMap<object, V>`                               | `Map` (keeps keys alive)          |
| Binary data                    | `Uint8Array` / `ArrayBuffer`                       | `Buffer` in platform-neutral code |
| Deep copy                      | `structuredClone()`                                | `JSON.parse(JSON.stringify())`    |
| Large integers / exact IDs     | `bigint` or `string`                               | `number` beyond 2^53              |
| Timestamps                     | `number` (epoch ms); ISO-8601 string at boundaries | Local-time strings                |

Rules:

- `Record<string, V>` index access yields `V | undefined` (`noUncheckedIndexedAccess`). Handle it; do not assert it away.
- Prefer `Object.groupBy` / `Map.groupBy` over hand-rolled reducers.
- Choose structures by access pattern: O(1) lookups via `Map`/`Set`, not O(n) array scans.

---

## 10. Formatting & Editor

`.prettierrc.json`

```json
{
  "printWidth": 100,
  "singleQuote": true,
  "trailingComma": "all",
  "semi": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

`.prettierignore`

```
dist/
coverage/
pnpm-lock.yaml
```

`.editorconfig`

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.vscode/settings.json`

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" },
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "files.eol": "\n"
}
```

`.vscode/extensions.json`: recommend `dbaeumer.vscode-eslint`, `esbenp.prettier-vscode`, `editorconfig.editorconfig`, `vitest.explorer`.

---

## 11. Testing

- Framework: Vitest. Unit tests are co-located with source; integration tests live in `test/`.
- Import test APIs explicitly (`import { describe, it, expect } from 'vitest'`); do not enable globals.
- Name tests by behavior: `it('returns an error when the manifest is missing')`.
- Arrange / Act / Assert structure; one behavior per test.
- No real network, clock, or randomness in unit tests: inject dependencies, use `vi.useFakeTimers()`, seed randomness.
- Use `fs.mkdtemp(path.join(os.tmpdir(), 'prefix-'))` for filesystem tests; always clean up.
- Coverage thresholds (enforced in `vitest.config.ts`): lines 80%, branches 80% for `src/`.
- Type-level tests use `expectTypeOf` for public generic APIs.

---

## 12. Security & Hygiene

- No secrets in the source tree. `.env.example` documents required variables; real values come from the environment.
- Run `pnpm audit --prod` regularly; resolve high/critical findings before release.
- Prefer dependencies with provenance; review install scripts of new packages (pnpm runs only explicitly approved build scripts).
- Never use `eval` or `new Function`, and never build shell commands from strings.
- Logs MUST NOT include tokens, passwords, or PII.

---

## 13. Documentation

- Every exported symbol has a TSDoc comment: purpose, params, return, thrown errors, and an example if non-obvious.
- Comments explain _why_, not _what_. Delete commented-out code.
- `TODO` format: `// TODO(<owner>): <action>`.
- README covers: purpose, prerequisites, setup (`pnpm install`), commands, architecture overview.

---

## 14. Code Quality Checklist

- [ ] `pnpm check` passes
- [ ] No `any`, `!`, or `as` casts in production code (except `as const` and brand constructors, §7.1)
- [ ] No `eslint-disable` without a reason
- [ ] New/changed behavior is covered by tests
- [ ] Names follow §6; files are kebab-case
- [ ] No OS-specific paths, shells, or line-ending assumptions
- [ ] TSDoc updated for public API changes
