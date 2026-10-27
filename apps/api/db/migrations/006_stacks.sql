-- Technology stacks and per-project allowed stacks. A project with no stacks is unrestricted.
CREATE TABLE tech_stacks (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',      -- shown to the AI as guidance on what this stack covers
  keywords    TEXT[] NOT NULL DEFAULT '{}',  -- terms that signal this stack (used for the server-side scope check)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tech_stacks (name, description, keywords) VALUES
  ('SAP', 'SAP ERP / S/4HANA: ABAP, Fiori/UI5, CDS views, BAPIs, IDocs, enhancements, standard transactions and configuration.',
     ARRAY['sap','abap','fiori','sapui5','cds view','bapi','idoc','s/4hana','s4hana','netweaver','smartforms','sap gui','rfc','badi','alv','hana']),
  ('.NET', 'Microsoft .NET: C#, ASP.NET Core, Entity Framework, Blazor, NuGet packages.',
     ARRAY['.net','c#','asp.net','entity framework','blazor','nuget','razor pages','wpf']),
  ('Java', 'Java platform: Java, Spring Boot, Hibernate, Maven/Gradle, Jakarta EE.',
     ARRAY['java','spring boot','hibernate','maven','gradle','jvm','jakarta ee','kotlin']),
  ('Node.js', 'Node.js: JavaScript/TypeScript services, Express, NestJS, npm.',
     ARRAY['node.js','nodejs','express.js','npm','nestjs','deno']);

CREATE TABLE project_stacks (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stack_id   INT  NOT NULL REFERENCES tech_stacks(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, stack_id)
);

-- What the AI Observer concluded about the request versus the project's stack.
ALTER TABLE requirement_drafts ADD COLUMN stack_fit TEXT NOT NULL DEFAULT 'in_scope' CHECK (stack_fit IN ('in_scope','unclear','out_of_scope'));
ALTER TABLE requirement_drafts ADD COLUMN stack_note TEXT NOT NULL DEFAULT '';

-- Optional stack tag so retrieval never suggests another stack's assets (NULL = generic).
ALTER TABLE embeddings ADD COLUMN stack TEXT;
