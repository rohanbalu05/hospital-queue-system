/**
 * dependency-cruiser rules (report Table 14 layout; PLAN.md "Dependency rules").
 * Rules are path-based, so they tolerate packages that do not exist yet.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-src-is-pure',
      comment:
        'packages/domain/src imports nothing outside itself: no node builtins, no npm packages, no other workspaces (D-004).',
      severity: 'error',
      from: { path: '^packages/domain/src/' },
      to: { pathNot: '^packages/domain/src/' },
    },
    {
      name: 'domain-tests-stay-in-domain',
      comment: 'Domain tests may use vitest and fast-check, but never other workspaces.',
      severity: 'error',
      from: { path: '^packages/domain/test/' },
      to: { path: '^(apps|packages/(?!domain/))' },
    },
    {
      name: 'apps-never-import-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'web-imports-only-contracts',
      comment: 'apps/web may import @hqms/contracts among workspaces; never api, worker, db or domain.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^(packages/(db|domain)/|apps/(api|worker)/)' },
    },
    {
      name: 'packages-never-import-apps',
      comment: 'packages/db, packages/contracts and packages/domain never import apps/*.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'contracts-is-a-leaf',
      comment: 'contracts depends on no other workspace package.',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/(db|domain)/' },
    },
    {
      name: 'db-no-domain',
      comment: 'db may use contracts only (PLAN package map).',
      severity: 'error',
      from: { path: '^packages/db/' },
      to: { path: '^packages/domain/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|build|coverage|node_modules|var|playwright-report)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
