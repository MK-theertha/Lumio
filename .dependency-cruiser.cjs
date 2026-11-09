/** Enforces the module boundaries described in docs/architecture/01-system-architecture.md. */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'module-internals-are-private',
      comment: 'Other modules may only import a module through its index.ts.',
      severity: 'error',
      from: { path: '^apps/backend/src/modules/([^/]+)/' },
      to: {
        path: '^apps/backend/src/modules/',
        pathNot: [
          '^apps/backend/src/modules/$1/',
          '^apps/backend/src/modules/[^/]+/index[.]ts$',
          '^apps/backend/src/modules/platform/[^/]+/index[.]ts$',
        ],
      },
    },
    {
      name: 'platform-internals-are-private',
      severity: 'error',
      from: { path: '^apps/backend/src/modules/platform/([^/]+)/' },
      to: {
        path: '^apps/backend/src/modules/platform/',
        pathNot: [
          '^apps/backend/src/modules/platform/$1/',
          '^apps/backend/src/modules/platform/[^/]+/index[.]ts$',
        ],
      },
    },
    {
      name: 'worker-uses-public-surfaces',
      severity: 'error',
      from: { path: '^apps/worker/' },
      to: {
        path: '^apps/backend/src/modules/',
        pathNot: [
          '^apps/backend/src/modules/[^/]+/index\\.ts$',
          '^apps/backend/src/modules/platform/[^/]+/index\\.ts$',
        ],
      },
    },
    {
      name: 'calc-engine-is-pure',
      severity: 'error',
      from: { path: '^packages/calc-engine/' },
      to: { dependencyTypes: ['npm', 'core'], pathNot: 'decimal\\.js' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.tsx?$|/dist/)' },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js'] },
  },
};
