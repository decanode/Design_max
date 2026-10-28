import type { LlmClient } from '../chat/llm.js';
import { stackInstruction, type StackPolicy } from '../stacks.js';

import type { DocKind } from './kinds.js';
import { CRC_CHECKS, outline, outlineInstruction, type StackKey } from './outlines.js';
export type { DocKind };
export interface DocContext {
  title: string;
  summary: string;
  transcript: string[];            // customer lines from the intake chat
  entities?: { businessObjects?: string[]; vendors?: string[]; materialTypes?: string[] };
  fs?: string;                     // approved FS (TS, TUT, CRC)
  ts?: string;                     // approved TS (TUT, CRC)
  knowledge?: string[];            // similar tickets / SAP / Git snippets from the vector store
  policy?: StackPolicy | null;     // the project's allowed technology stacks (null = unrestricted)
  stackKey?: StackKey;             // which technology's outline to follow
}
export interface DocGenerator { generate(kind: DocKind, ctx: DocContext): Promise<string> }

const list = (xs?: string[]) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- _None identified_');

/** Deterministic skeleton for dev/offline use. It structures what the customer said; it does not invent requirements. */
export class TemplateGenerator implements DocGenerator {
  async generate(kind: DocKind, c: DocContext) {
    if (kind === 'FS') return `# Functional Specification: ${c.title}

> Draft generated from the intake chat (offline template). Consultant to complete and review before approval.${c.policy ? `\n> Technology scope: ${c.policy.allowed.map((s) => s.name).join(', ')}` : ''}

## 1. Business Requirement
${c.summary}

## 2. Customer Statements
${c.transcript.map((t) => `> ${t}`).join('\n\n') || '_No transcript available (migrated ticket)._'}

## 3. Scope
**Business objects**
${list(c.entities?.businessObjects)}

**Vendors**
${list(c.entities?.vendors)}

**Material types**
${list(c.entities?.materialTypes)}

## 4. Functional Requirements
_To be completed by the consultant._

## 5. Acceptance Criteria
_To be completed by the consultant._

## 6. Open Questions
_None recorded._
`;
    if (kind === 'TUT') return tutTemplate(c);
    if (kind === 'CRC') return crcTemplate(c);
    const sections = outline(c.stackKey ?? 'generic', 'TS').map((o, i) => {
      const body = o.title === 'Reuse of Existing Assets' ? list(c.knowledge) : o.title === 'Technical Objects'
        ? '| Object | Type | Purpose | New / changed |\n| --- | --- | --- | --- |\n| _To be completed_ | | | |' : `_To be completed by the developer._`;
      return `## ${i + 1}. ${o.title}\n${body}\n`;
    }).join('\n');
    return `# Technical Specification: ${c.title}

> Draft generated from the approved Functional Specification (offline template). Developer to complete and review before approval.${c.policy ? `\n> Technology scope: ${c.policy.allowed.map((s) => s.name).join(', ')}` : ''}

## Source Functional Specification
${c.fs ? c.fs.split('\n').map((l) => `> ${l}`).join('\n') : '_Not available._'}

${sections}`;
  }
}

/** Lines under a Markdown heading (matched by text) up to the next heading. */
function section(md: string | undefined, heading: RegExp): string[] {
  if (!md) return [];
  const lines = md.split('\n'); const out: string[] = []; let on = false;
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) { on = heading.test(l); continue; }
    if (on && l.trim()) out.push(l.replace(/^[-*>\s\d.)]+/, '').trim());
  }
  return out.filter((l) => l && !/^_.*_$/.test(l));
}

/** Test cases traced from the FS acceptance criteria, so every criterion is covered by at least one case. */
function tutTemplate(c: DocContext) {
  const criteria = section(c.fs, /acceptance/i);
  const rows = (criteria.length ? criteria : ['_No acceptance criteria were recorded in the Functional Specification._']).map((cr, i) =>
    `| TC-${String(i + 1).padStart(2, '0')} | ${cr} | _Steps to be completed_ | ${cr} | AC-${i + 1} | Not run |`);
  return `# Technical Unit Test: ${c.title}

> Draft generated from the Functional Specification (offline template). Developer to complete the steps and record results.${c.policy ? `\n> Technology scope: ${c.policy.allowed.map((s) => s.name).join(', ')}` : ''}

## 1. Scope
${c.summary}

## 2. Test Cases
| ID | Scenario | Steps | Expected result | Traces to | Result |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## 3. Test Data
_To be completed by the developer._

## 4. Defects Found
_None recorded._

## 5. Sign-off
_Tester name, date and outcome to be completed._
`;
}

const CHECKS_BY_TYPE: [RegExp, string[]][] = [
  [/report|alv/i, ['Selection screen validated and authorization-checked', 'Large result sets handled (no unbounded SELECT)', 'Output formatting and totals verified']],
  [/interface|api|idoc|proxy|service/i, ['Error handling and retry behaviour defined', 'Payload validated; no secrets in logs', 'Idempotency considered']],
  [/table|ddic|structure|data/i, ['Keys, indexes and field types reviewed', 'Data migration impact assessed']],
  [/enhancement|badi|user.?exit|extension/i, ['Standard behaviour is not broken for other callers', 'Switch / feature toggle in place']],
];
const GENERAL_CHECKS = [
  'Naming conventions followed', 'No hard-coded values, credentials or system IDs', 'Authorization checks present where data is read or changed',
  'Error and exception handling implemented, with meaningful messages', 'Performance reviewed (loops, database access)', 'Code is commented where logic is not obvious',
  'Unit tests completed and attached (see TUT)', 'Transport / deployment package contains only intended objects',
];

/** Checklist built from the general items plus extra items for each kind of technical object named in the TS. */
function crcTemplate(c: DocContext) {
  const objects = section(c.ts, /technical object|object|design/i).slice(0, 12);
  const extra = CHECKS_BY_TYPE.filter(([re]) => objects.some((o) => re.test(o)) || re.test(c.ts ?? '')).flatMap(([, items]) => items);
  const rows = [...GENERAL_CHECKS, ...CRC_CHECKS[c.stackKey ?? 'generic'], ...extra].map((it, i) => `| ${i + 1} | ${it} | Pending | |`);
  const objRows = objects.length ? objects.map((o) => `- ${o}`).join('\n') : '- _No technical objects were listed in the Technical Specification._';
  return `# Code Review Checklist: ${c.title}

> Draft generated from the Technical Specification (offline template). Reviewer to mark each item.${c.policy ? `\n> Technology scope: ${c.policy.allowed.map((s) => s.name).join(', ')}` : ''}

## 1. Objects Under Review
${objRows}

## 2. Checklist
| # | Check | Result | Comment |
| --- | --- | --- | --- |
${rows.join('\n')}

## 3. Findings
_None recorded._

## 4. Review Outcome
_Reviewer name, date and outcome to be completed._
`;
}

const SYS: Record<DocKind, string> = {
  FS: 'You are a senior SAP/enterprise functional consultant. Write a Functional Specification in Markdown from the ticket and chat. Sections: Business Requirement, Scope, Functional Requirements, Acceptance Criteria, Open Questions. Use ONLY facts present in the input; list anything unclear under Open Questions instead of guessing. Output Markdown only.',
  TS: 'You are a senior technical architect. Write a Technical Specification in Markdown from the approved Functional Specification. Sections: Design, Data & Interfaces, Reuse of Existing Assets, Test Approach. Reference the listed existing assets only where they genuinely fit, and say so when none do. Do not invent systems, tables or APIs absent from the input. Output Markdown only.',
  TUT: 'You are a senior QA engineer. Write a Technical Unit Test document in Markdown from the Functional Specification (and Technical Specification if given). Sections: Scope, Test Cases (a Markdown table with ID, Scenario, Steps, Expected result, Traces to, Result), Test Data, Defects Found, Sign-off. Every acceptance criterion must be covered by at least one test case and referenced in Traces to. Do not invent features. Output Markdown only.',
  CRC: 'You are a senior code reviewer. Write a Code Review Checklist in Markdown from the Technical Specification. Sections: Objects Under Review, Checklist (a Markdown table with #, Check, Result, Comment, Result set to Pending), Findings, Review Outcome. Include general checks plus checks specific to each technical object type named in the specification. Do not invent objects. Output Markdown only.',
};

export class LlmGenerator implements DocGenerator {
  constructor(private llm: LlmClient) {}
  async generate(kind: DocKind, c: DocContext) {
    const user = [
      `Title: ${c.title}`, `Summary: ${c.summary}`,
      c.transcript.length ? `Customer statements:\n${c.transcript.join('\n')}` : '',
      c.fs ? `Approved Functional Specification:\n${c.fs}` : '',
      c.ts ? `Approved Technical Specification:\n${c.ts}` : '',
      c.knowledge?.length ? `Existing assets (vector search):\n${c.knowledge.join('\n---\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const md = (await this.llm.complete([SYS[kind], outlineInstruction(c.stackKey ?? 'generic', kind), stackInstruction(c.policy ?? null, 'document')].filter(Boolean).join('\n\n'), user)).trim();
    if (!md) throw new Error('LLM returned an empty document');
    return md;
  }
}
