import type { DocKind } from './kinds.js';

export type StackKey = 'sap' | 'dotnet' | 'java' | 'node' | 'generic';
export interface Outline { title: string; hint: string }

/** What a Technical Specification covers, per technology. The same outline drives the offline draft and the AI's instructions. */
const TS: Record<StackKey, Outline[]> = {
  sap: [
    { title: 'Technical Objects', hint: 'Table of every ABAP object: name, type (report, class, function module, CDS view, enhancement, table), purpose, new or changed.' },
    { title: 'Technical Design', hint: 'Program flow, classes and methods, selection screen, data selection logic.' },
    { title: 'Data Dictionary', hint: 'Tables, structures, domains and data elements touched or created, with key fields.' },
    { title: 'Authorizations', hint: 'Authorization objects and AUTHORITY-CHECK points; roles that need changes.' },
    { title: 'Interfaces & Enhancements', hint: 'IDocs, RFCs, OData/APIs, BAdIs, user exits and their calling context.' },
    { title: 'Transports & Deployment', hint: 'Transport requests, order of import, manual post-steps, client-specific settings.' },
    { title: 'Reuse of Existing Assets', hint: 'Existing objects reused and why; say so if none fit.' },
    { title: 'Test Approach', hint: 'Unit-test scope (see the Technical Unit Test), test data, regression areas.' },
  ],
  dotnet: [
    { title: 'Technical Objects', hint: 'Table of projects, classes, controllers, services, entities and migrations: name, type, purpose, new or changed.' },
    { title: 'Solution Structure', hint: 'Projects and layers affected, dependencies, where new code lives.' },
    { title: 'APIs & Contracts', hint: 'Endpoints, request/response models, versioning, error contract.' },
    { title: 'Data & Migrations', hint: 'Entities, EF Core migrations, indexes, data fixes.' },
    { title: 'Configuration & Security', hint: 'appsettings, secrets, authentication/authorization policies.' },
    { title: 'Packages & Dependencies', hint: 'NuGet packages added or upgraded and why.' },
    { title: 'Build & Deployment', hint: 'Pipeline changes, environments, rollout and rollback.' },
    { title: 'Test Approach', hint: 'Unit and integration tests, test data, regression areas.' },
  ],
  java: [
    { title: 'Technical Objects', hint: 'Table of modules, packages, classes, beans, entities and migrations: name, type, purpose, new or changed.' },
    { title: 'Module & Package Structure', hint: 'Modules and layers affected, dependency direction, where new code lives.' },
    { title: 'APIs & Contracts', hint: 'REST/messaging contracts, DTOs, versioning, error handling.' },
    { title: 'Data & Migrations', hint: 'JPA entities, Flyway/Liquibase scripts, indexes, data fixes.' },
    { title: 'Configuration & Security', hint: 'Properties, profiles, secrets, security configuration.' },
    { title: 'Dependencies', hint: 'Maven/Gradle dependencies added or upgraded and why.' },
    { title: 'Build & Deployment', hint: 'Pipeline changes, containers, rollout and rollback.' },
    { title: 'Test Approach', hint: 'Unit and integration tests, test data, regression areas.' },
  ],
  node: [
    { title: 'Technical Objects', hint: 'Table of modules, routes, services, schemas and migrations: name, type, purpose, new or changed.' },
    { title: 'Application Structure', hint: 'Modules and layers affected, where new code lives, shared types.' },
    { title: 'APIs & Contracts', hint: 'Routes, request/response schemas, validation, error contract.' },
    { title: 'Data & Migrations', hint: 'Schema changes, migrations, indexes, data fixes.' },
    { title: 'Configuration & Security', hint: 'Environment variables, secrets, authentication/authorization.' },
    { title: 'Packages & Dependencies', hint: 'npm packages added or upgraded and why; licence and audit notes.' },
    { title: 'Build & Deployment', hint: 'Pipeline changes, containers, rollout and rollback.' },
    { title: 'Test Approach', hint: 'Unit and integration tests, test data, regression areas.' },
  ],
  generic: [
    { title: 'Technical Objects', hint: 'Table of components, interfaces and data structures: name, type, purpose, new or changed.' },
    { title: 'Technical Design', hint: 'How the solution works: components, flow, key decisions.' },
    { title: 'Data & Interfaces', hint: 'Data stores and structures, inbound and outbound interfaces.' },
    { title: 'Security & Configuration', hint: 'Access control, secrets, configuration.' },
    { title: 'Build & Deployment', hint: 'Release steps, environments, rollback.' },
    { title: 'Reuse of Existing Assets', hint: 'Existing assets reused and why; say so if none fit.' },
    { title: 'Test Approach', hint: 'Test scope, test data, regression areas.' },
  ],
};

const FS: Outline[] = [
  { title: 'Business Requirement', hint: 'What the business needs and why.' },
  { title: 'Customer Statements', hint: 'What the customer said in the intake chat, quoted.' },
  { title: 'Scope', hint: 'Business objects, vendors, material types and other things in and out of scope.' },
  { title: 'Functional Requirements', hint: 'Numbered requirements, each testable.' },
  { title: 'Acceptance Criteria', hint: 'Numbered criteria, each verifiable; these become the unit-test cases.' },
  { title: 'Open Questions', hint: 'Anything unclear instead of guessing.' },
];

/** Extra review checks per technology, added to the general Code Review Checklist. */
export const CRC_CHECKS: Record<StackKey, string[]> = {
  sap: ['AUTHORITY-CHECK present before reading or changing protected data', 'No SELECT inside loops; FOR ALL ENTRIES guarded against empty tables', 'No hard-coded client, plant or company code; customizing used', 'ATC / code inspector run with no priority 1–2 findings', 'Locks (ENQUEUE) released; COMMIT WORK only where intended', 'Transport contains only the intended objects and is in the right order'],
  dotnet: ['async/await used end to end; no .Result or .Wait()', 'IDisposable resources disposed (using); HttpClient reused via factory', 'Dependency injection lifetimes correct', 'Nullable reference warnings addressed', 'EF Core queries translate to SQL (no client-side evaluation); migration reviewed', 'Secrets come from configuration, not code'],
  java: ['Resources closed (try-with-resources); no null returns where Optional fits', 'Transactions scoped correctly; no N+1 queries', 'Thread-safety of shared state reviewed', 'Exceptions not swallowed; logging without personal data', 'Dependencies pinned; no known vulnerable versions', 'Secrets come from configuration, not code'],
  node: ['Promises awaited; errors in async code handled', 'Input validated at the boundary', 'No unsafe eval, shell exec or unsanitised paths', 'npm audit clean; new packages justified and licensed', 'Environment variables validated at start-up', 'Secrets come from configuration, not code'],
  generic: [],
};

export const outline = (stack: StackKey, kind: DocKind): Outline[] =>
  kind === 'FS' ? FS : kind === 'TS' ? TS[stack] : kind === 'TUT'
    ? [{ title: 'Scope', hint: 'What is tested.' }, { title: 'Test Cases', hint: 'Table: ID, Scenario, Steps, Expected result, Traces to, Result. Every acceptance criterion is covered.' }, { title: 'Test Data', hint: 'Data and prerequisites.' }, { title: 'Defects Found', hint: 'Defects raised during testing.' }, { title: 'Sign-off', hint: 'Tester, date and outcome.' }]
    : [{ title: 'Objects Under Review', hint: 'The objects from the Technical Specification.' }, { title: 'Checklist', hint: 'Table: #, Check, Result, Comment. General checks plus checks for this technology.' }, { title: 'Findings', hint: 'Review findings.' }, { title: 'Review Outcome', hint: 'Reviewer, date and outcome.' }];

export const outlineInstruction = (stack: StackKey, kind: DocKind) =>
  `Use exactly these numbered sections, in this order, and no others:\n${outline(stack, kind).map((o, i) => `${i + 1}. ${o.title}: ${o.hint}`).join('\n')}`;
