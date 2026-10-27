import type { LlmClient } from '../chat/observer.js';

export type DocKind = 'FS' | 'TS';
export interface DocContext {
  title: string;
  summary: string;
  transcript: string[];            // customer lines from the intake chat
  entities?: { businessObjects?: string[]; vendors?: string[]; materialTypes?: string[] };
  fs?: string;                     // approved FS (TS only)
  knowledge?: string[];            // similar tickets / SAP / Git snippets from the vector store
}
export interface DocGenerator { generate(kind: DocKind, ctx: DocContext): Promise<string> }

const list = (xs?: string[]) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- _None identified_');

/** Deterministic skeleton for dev/offline use. It structures what the customer said; it does not invent requirements. */
export class TemplateGenerator implements DocGenerator {
  async generate(kind: DocKind, c: DocContext) {
    if (kind === 'FS') return `# Functional Specification: ${c.title}

> Draft generated from the intake chat (offline template). Consultant to complete and review before approval.

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
    return `# Technical Specification: ${c.title}

> Draft generated from the approved Functional Specification (offline template). Developer to complete and review before approval.

## 1. Source Functional Specification
${c.fs ? c.fs.split('\n').map((l) => `> ${l}`).join('\n') : '_Not available._'}

## 2. Related Existing Assets
${list(c.knowledge)}

## 3. Technical Design
_To be completed by the developer._

## 4. Data & Interfaces
_To be completed by the developer._

## 5. Test Approach
_To be completed by the developer._
`;
  }
}

const SYS: Record<DocKind, string> = {
  FS: 'You are a senior SAP/enterprise functional consultant. Write a Functional Specification in Markdown from the ticket and chat. Sections: Business Requirement, Scope, Functional Requirements, Acceptance Criteria, Open Questions. Use ONLY facts present in the input; list anything unclear under Open Questions instead of guessing. Output Markdown only.',
  TS: 'You are a senior technical architect. Write a Technical Specification in Markdown from the approved Functional Specification. Sections: Design, Data & Interfaces, Reuse of Existing Assets, Test Approach. Reference the listed existing assets only where they genuinely fit, and say so when none do. Do not invent systems, tables or APIs absent from the input. Output Markdown only.',
};

export class LlmGenerator implements DocGenerator {
  constructor(private llm: LlmClient) {}
  async generate(kind: DocKind, c: DocContext) {
    const user = [
      `Title: ${c.title}`, `Summary: ${c.summary}`,
      c.transcript.length ? `Customer statements:\n${c.transcript.join('\n')}` : '',
      c.fs ? `Approved Functional Specification:\n${c.fs}` : '',
      c.knowledge?.length ? `Existing assets (vector search):\n${c.knowledge.join('\n---\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const md = (await this.llm.complete(SYS[kind], user)).trim();
    if (!md) throw new Error('LLM returned an empty document');
    return md;
  }
}
