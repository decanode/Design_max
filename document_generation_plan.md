# Plan: Template-driven Documents, Review Comments and Word Export

**Status:** all phases are built (see the table in section 7 and `feature_process_guide.md` section 6). Open items: Phase 0 and the SAP template content need your Word files; a logo, Word comments in the export and per-section AI regeneration are not built.

**Decisions (from you):**
- **A. TUT** = Technical Unit Test, **CRC** = Code Review Checklist.
- **B. QA gate:** optional per project, **off by default**. A Project Admin can switch on "TUT and CRC must be approved before QA". Existing projects behave as today.
- **C. Live co-editing from the start.** This changes the editing design (see section 3, D9) and moves the editor ahead of review comments.
- **D. Template files:** still needed. They cannot be read from `C:\Users\...`; drop them into the project (for example `templates/sap/`). Until then Phase 1 uses a stand-in Word template with the same mechanism, so swapping in your real files is a data change, not a rewrite.

## 1. What you asked for

1. Generate the SAP documents from your Word templates: **TUT**, **TS**, **CRC**, and the **FS** in the same design as the TS.
2. Provide equivalent templates for the other technology stacks (.NET, Java, Node.js).
3. A **Document settings** tab where an admin changes the project name and other template attributes, including fonts and font sizes.
4. After a draft is generated, **consultants edit it online**, or **upload their own document and merge it** with the system template.
5. **Download as DOCX.**
6. Online **review comments** from Team Leads, with consultants editing accordingly, like Confluence.

## 2. What exists today (and why it is not enough)

FS and TS are Markdown text generated from the chat, versioned, diffed and approved through the L1…Ln workflows. That is good for plumbing but cannot carry a company-designed Word document: no cover page, headers and footers, styled tables, checklists, logos or fixed boilerplate. There is also no commenting, no upload, no Word export, and only FS/TS exist as document types.

## 3. The design, and why

**D1. Your real .docx is the master template.** The system never re-draws your design. It opens your Word file, keeps its cover page, headers, footers, styles and boilerplate, and fills in the content. This is the only way to stay faithful to a company template. Rejected alternatives: building Word files from scratch (never matches your design) and converting HTML to Word (loses styles and tables).

**D2. Content is stored as structured rich text, not Markdown.** A document is a list of *sections* (headings, paragraphs, lists, tables, images, checklists). Markdown cannot represent your tables and checklists; structured content can be edited online, diffed, commented on and exported to Word reliably. Existing Markdown FS/TS versions stay untouched and are converted when first opened.

**D3. One section map drives everything.** For each template I derive a definition: the ordered sections, which are fixed boilerplate, which are fill-in, what each should contain, and where its data comes from (chat, ticket, approved FS, SAP metadata). The same definition drives AI generation (section by section, not one big blob), the online editor (fixed text locked, fill-in areas editable), the Word export, the upload-and-merge mapping, and the comment anchors.

**D4. Exported Word files carry hidden section tags.** Each section is wrapped in a Word content control labelled with its section ID. When someone downloads, edits offline and uploads again, the system maps every section back exactly. Documents without tags (someone's own file) fall back to matching by headings.

**D5. Comments are separate from versions.** A comment thread is anchored to a text range by an ID stored in the content, so it moves with the text when people edit. Saving a new version does not lose comments. Deleted anchors show as "orphaned" with the quoted text instead of vanishing.

**D6. Document types become configurable.** Today the database hard-codes FS and TS. Types (FS, TS, TUT, CRC, and later others) become data, and the approval-workflow engine works for any type. Only FS and TS are mandatory phase gates today; whether TUT and CRC gate the move to QA is your choice (decision B below).

**D7. Settings layer like this:** platform defaults → stack template → project settings → one document. Each layer overrides only what it sets.

**D9. Live co-editing changes how a document is stored.** Several people typing at once needs a shared, conflict-free document (a CRDT, using Yjs), not "save and warn on conflict". So each document has two layers: a **live working draft** that everyone edits together (cursors, instant merging, comments anchored inside it), and **immutable versions** that are snapshots of the draft. A version is created when someone clicks *Save version*, automatically when approval is requested (the approvers always review an exact snapshot), and as periodic checkpoints. Approvals, diffs, version history and the Word export all keep working on versions exactly as today. The live-editing server is a small addition next to the existing chat server; access to it is checked with the same session and project rules. The old "someone saved first, reload" conflict case disappears for rich documents.

**D8. Security carries over.** New tables are isolated per project by the same database row-level security. Exports respect ticket-field access (a role that cannot read the customer name does not get it in the header). Uploads are treated as hostile files.

## 4. How it fits together

```
 Template library (platform)          Project settings
 .docx + section map  ───┐            fonts, sizes, name, logo,
 per stack × doc type    │            numbering, header/footer
                         ▼                    │
 chat / ticket / FS / SAP data ──► AI fills each section (stack-limited)
                         │
                         ▼
        Structured document (versions, immutable)
        │          │             │              │
   online editor  comments    upload & merge   approval workflow
   (consultants)  (leads)     (own .docx)      (L1…Ln, existing)
        │
        ▼
   DOCX export = your template + content + settings + approval table
```

## 5. What gets added

**Template library (Super Admin, Platform → Document templates).** Upload or replace a template .docx for a stack and document type; versioned; preview of its section map. SAP gets your three templates plus an FS built in the TS design. For .NET, Java and Node.js I derive matching templates from the SAP design: same cover, styles and layout, with stack-appropriate sections (for example SAP TS covers ABAP objects, transactions, authorizations and transports; a .NET TS covers solution structure, APIs, packages, configuration, migrations and pipelines).

**Document settings tab (Project settings → Documents).** Project name and client name shown on documents; logo; header and footer text; document-number format (for example `{PROJECT}-{TICKET}-TS`); body and heading fonts and sizes within an allowed range; confidentiality line; which template set the project uses (defaults from its allowed technology). A live preview shows the change before saving.

**Generated front matter.** Version, status and date; author, reviewers and approvers pulled from the real approval timeline (so the signature table is never typed by hand); the revision-history table built from the saved versions.

**Editing.** A rich editor with tables, lists, images and checklists. Fixed boilerplate is locked; fill-in sections are editable. Consultants edit, versions are saved as today, with conflict protection. Section-level **Regenerate** reruns the AI for one section only.

**Upload and merge.** A consultant uploads a .docx. The system reads it safely, matches its sections to the template (by hidden tags, then headings, optionally AI-assisted), and shows a **merge screen**: their section on one side, the system draft on the other, with a choice per section (keep system, use theirs, append, or edit by hand). Unmatched content goes into an "Additional sections" area rather than being dropped. Nothing is saved until they confirm, and the result becomes a normal new version with a diff against the previous one.

**Review comments (Confluence style).**
- A reviewer selects text and adds a comment; threads support replies, @mentions, resolve and reopen. There are also section-level and general comments.
- A Lead requests a review; the consultant sees a "changes requested" list, edits, marks comments addressed, and the Lead resolves them.
- Optional project rule: **approval cannot be requested while comments are open.**
- Review requests and replies notify people in the app and by email (local Mailbox now, Microsoft 365 later).
- Option: export Word with the open comments included as real Word comments, and import Word comments back on upload.
- Live co-editing (several people typing at once) is possible on the same foundation as a later stage (see decision C).

**Download.** Any version downloads as DOCX with the project's settings applied; downloads are logged.

## 6. Data model additions (all with project isolation)

`document_types`; `doc_templates` (stack, type, version, file, section map; platform-owned and shared); `project_doc_settings`; extend `documents` with the structured content and a format marker; `doc_comments` and replies; `doc_reviews`; `doc_exports` (who downloaded what); `doc_uploads` (original file kept for audit). The approval tables and workflow definitions switch from fixed "FS/TS" to document types.

## 7. Phases (revised for live co-editing)

| # | Phase | What you can do at the end | Proof |
|---|---|---|---|
| 0 | **Template intake.** Analyse your Word files, extract section maps | Agree what each document contains | Section map reviewed by you (needs the files) |
| 1 | **Foundation (done).** Structured content, Word export engine with a stand-in template, front matter (approval table, revision table), download | Download any FS or TS as DOCX | Structure checks that the file is valid and styles, headers, tables and links survive |
| 2 | **Document types and templates (done, except your real SAP files).** FS/TS/TUT/CRC as data, template library, SAP templates from your files, optional QA gate | Full SAP document set per ticket | Per-type tests, gate tests |
| 3 | **AI by section (done; per-section regenerate not built).** Section-based generation per template, stack limits, per-section regenerate; TUT traced from FS acceptance criteria, CRC from the TS object list | Generate each document | Section tests, scope tests |
| 4 | **Editor with live co-editing (done).** Rich editor, working draft shared in real time, versions as snapshots, locked boilerplate | Several consultants edit one document together | Multi-user browser tests, offline/reconnect tests |
| 5 | **Document settings (done, except logo).** Project name, branding, fonts, sizes, numbering, live preview | Admin restyles all documents | Settings-layering tests, golden exports |
| 6 | **Review comments (done, except Word comments in export).** Anchored threads inside the live draft, mentions, resolve, review rounds, notifications, approval gate, Word comments option | Lead comments, consultants fix, Lead resolves | Cross-role browser tests, anchor-drift tests |
| 7 | **Upload and merge (done).** Safe parser, section mapper, merge screen, round-trip via section tags | Merge your own document | Round-trip and hostile-file tests |
| 8 | **Other stacks and hardening (outlines done; Word designs wait for templates).** .NET, Java, Node.js template sets; accessibility, performance, security review | Same flow for every stack | Full regression, security tests |

Each phase ends with tests, a visual check, and an update to `feature_process_guide.md`.

## 8. New dependencies (kept small)

Server: a ZIP/XML library to open and fill Word packages (PizZip, fast-xml-parser) and a .docx reader for uploads (mammoth). Web: a rich-text editor framework (Tiptap on ProseMirror) with table and image support. For live co-editing: Yjs with its Tiptap binding and a small sync server beside the existing chat server. CI only: LibreOffice to render exported files and catch corruption.

## 9. Risks and how they are handled

| Risk | Handling |
|---|---|
| Template has features that are hard to fill (merged cells, nested tables, fields, text boxes) | Phase 0 inspection before any build; fill-in areas are mapped to simple regions; anything exotic stays as fixed boilerplate |
| Fonts differ on a reader's machine | Settings offer a safe-font list; the document falls back as Word normally does |
| Generated Word file opens with a repair prompt | Structure tests plus rendering in CI; golden files of known-good output |
| AI invents content | Section-by-section prompts, "open questions" instead of guesses, stack limits, always human-reviewed |
| Merge picks wrong sections | Nothing saves without confirmation; every merge is a normal reversible version |
| Hostile uploads (macros, zip bombs, external references) | Reject macro-enabled and encrypted files, size and entry limits, no external entities, strip embedded objects, never execute content |
| Comments drifting when text changes | Anchors stored in the content itself; orphaned comments are kept and shown |

## 10. Still needed from you

The three SAP template files (and, if they exist, templates for other stacks). Add the placeholders listed in Platform → Documents to each (at minimum `{{BODY}}`) and upload them there, or copy them into the project (for example `templates/sap/`) and I will prepare and load them. Until then documents use the built-in stand-in design.
