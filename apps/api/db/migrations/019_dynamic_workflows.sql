-- Dynamic state machine and templating engine.
-- The ticket lifecycle stops being hard-coded: phases, transitions, ticket types and project templates are data.
-- The previous nine-step lifecycle is kept as the seeded "Waterfall" template, so existing projects behave exactly as before.

-- ---------------------------------------------------------------- masters (platform-owned, readable by every project)
CREATE TABLE template_types (
  id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0);
CREATE TABLE project_types (
  id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0);
CREATE TABLE ticket_types (
  id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, short TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0);
CREATE TABLE phases (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, tone TEXT NOT NULL CHECK (tone IN ('intake','spec','build','review','done')), description TEXT NOT NULL DEFAULT '');

-- Which phases a methodology offers (in board order) and whether each starts switched on.
CREATE TABLE template_phases (
  template_type_id INT NOT NULL REFERENCES template_types(id) ON DELETE CASCADE,
  phase_id INT NOT NULL REFERENCES phases(id), position INT NOT NULL, default_on BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (template_type_id, phase_id));
-- Which ticket types a methodology can carry.
CREATE TABLE template_ticket_types (
  template_type_id INT NOT NULL REFERENCES template_types(id) ON DELETE CASCADE,
  ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  PRIMARY KEY (template_type_id, ticket_type_id));
-- What a new project of a given type starts with.
CREATE TABLE project_type_ticket_defaults (
  project_type_id INT NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
  ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  default_on BOOLEAN NOT NULL DEFAULT true, is_default BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (project_type_id, ticket_type_id));
CREATE TABLE project_type_phase_defaults (
  project_type_id INT NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
  phase_id INT NOT NULL REFERENCES phases(id) ON DELETE CASCADE, enabled BOOLEAN NOT NULL,
  PRIMARY KEY (project_type_id, phase_id));
CREATE TABLE project_type_template_defaults (
  project_type_id INT PRIMARY KEY REFERENCES project_types(id) ON DELETE CASCADE,
  template_type_id INT NOT NULL REFERENCES template_types(id));

-- The dynamic state machine. from_phase NULL = entry phase for new tickets. ticket_type NULL = every ticket type of the template
-- that has no flow of its own. gated_reason marks steps only the document/approval flow may perform.
CREATE TABLE workflow_transitions (
  id SERIAL PRIMARY KEY,
  template_type_id INT NOT NULL REFERENCES template_types(id) ON DELETE CASCADE,
  ticket_type_id INT REFERENCES ticket_types(id) ON DELETE CASCADE,
  from_phase_id INT REFERENCES phases(id),
  to_phase_id INT NOT NULL REFERENCES phases(id),
  gated_reason TEXT);
CREATE UNIQUE INDEX workflow_transitions_uq ON workflow_transitions (template_type_id, COALESCE(ticket_type_id, 0), COALESCE(from_phase_id, 0), to_phase_id);

-- Type-specific fields: the definition of the dynamic form. Values live in tickets.dynamic_metadata.
CREATE TABLE ticket_type_fields (
  id SERIAL PRIMARY KEY, ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'), label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','textarea','select','number','date','checkbox')),
  options JSONB NOT NULL DEFAULT '[]', required BOOLEAN NOT NULL DEFAULT false, help TEXT NOT NULL DEFAULT '', position INT NOT NULL DEFAULT 0,
  UNIQUE (ticket_type_id, key));

-- ---------------------------------------------------------------- per-project configuration (isolated by project)
ALTER TABLE projects ADD COLUMN project_type_id INT REFERENCES project_types(id);
ALTER TABLE projects ADD COLUMN template_type_id INT REFERENCES template_types(id);
CREATE TABLE project_phases (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, phase_id INT NOT NULL REFERENCES phases(id),
  position INT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (project_id, phase_id));
CREATE TABLE project_ticket_types (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, ticket_type_id INT NOT NULL REFERENCES ticket_types(id),
  enabled BOOLEAN NOT NULL DEFAULT true, is_default BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (project_id, ticket_type_id));
ALTER TABLE project_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_ticket_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON project_phases USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON project_ticket_types USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());

-- ---------------------------------------------------------------- seed the masters
INSERT INTO template_types (key, name, description, sort) VALUES
 ('waterfall', 'Waterfall', 'Requirement, functional and technical specification with sign-offs, then build, test and deploy. The original Design Max lifecycle.', 1),
 ('agile',     'Agile',     'A backlog worked in short cycles: ready, in progress, in review, done.', 2),
 ('hybrid',    'Hybrid (SAP Activate style)', 'Specified up front with approvals, then built and reviewed iteratively.', 3),
 ('itil',      'ITIL', 'Service management: incidents, problems, requests and controlled changes.', 4);
INSERT INTO project_types (key, name, description, sort) VALUES
 ('implementation', 'Implementation', 'Building and rolling out a solution (for example an SAP implementation).', 1),
 ('support',        'Support',        'Running a live system: incidents, problems, requests and changes.', 2),
 ('devops',         'DevOps',         'Continuous delivery of features and fixes.', 3),
 ('conversion',     'Conversion',     'Migrating data and objects from one system to another.', 4);
INSERT INTO ticket_types (key, name, short, description, sort) VALUES
 ('requirement', 'Requirement',    'REQ',   'A verified business requirement (what the intake chat creates).', 1),
 ('wricef',      'WRICEF',         'WRCF',  'A Workflow, Report, Interface, Conversion, Enhancement or Form.', 2),
 ('epic',        'Epic',           'EPIC',  'A large body of work split into smaller items.', 3),
 ('feature',     'Feature',        'FEAT',  'A new capability.', 4),
 ('bug',         'Bug',            'BUG',   'Something that does not work as intended.', 5),
 ('incident',    'Incident',       'INC',   'An unplanned interruption or degradation of a service.', 6),
 ('problem',     'Problem',        'PRB',   'The underlying cause of one or more incidents.', 7),
 ('change',      'Change Request', 'CR',    'A controlled change to a live system.', 8),
 ('ritm',        'Request Item',   'RITM',  'A catalogue request, for example access or a new device.', 9);
INSERT INTO phases (name, tone) VALUES
 ('Requirement Verified','intake'),('FS Drafted','spec'),('FS Approved','spec'),('TS Drafted','spec'),('TS Approved','spec'),
 ('Development','build'),('QA','build'),('UAT','review'),('Deployed','done'),('Hypercare','done'),('Closed','done'),
 ('Backlog','intake'),('Ready','intake'),('In Progress','build'),('In Review','review'),('Done','done'),
 ('New','intake'),('Triage','intake'),('Assessment','spec'),('Change Approved','spec'),('Implementation','build'),('Pending','build'),('Review','review'),('Resolved','review');

CREATE FUNCTION _ph(n TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT id FROM phases WHERE name = n $$;
CREATE FUNCTION _tt(k TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT id FROM template_types WHERE key = k $$;
CREATE FUNCTION _ty(k TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT id FROM ticket_types WHERE key = k $$;
CREATE FUNCTION _pt(k TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT id FROM project_types WHERE key = k $$;

INSERT INTO template_phases (template_type_id, phase_id, position, default_on)
SELECT _tt(t), _ph(p), ord, COALESCE(d, true) FROM (VALUES
 ('waterfall','Requirement Verified',1,true),('waterfall','FS Drafted',2,true),('waterfall','FS Approved',3,true),('waterfall','TS Drafted',4,true),('waterfall','TS Approved',5,true),
 ('waterfall','Development',6,true),('waterfall','QA',7,true),('waterfall','UAT',8,true),('waterfall','Deployed',9,true),('waterfall','Hypercare',10,false),('waterfall','Closed',11,false),
 ('agile','Backlog',1,true),('agile','Ready',2,true),('agile','In Progress',3,true),('agile','In Review',4,true),('agile','Done',5,true),
 ('hybrid','Backlog',1,true),('hybrid','Requirement Verified',2,true),('hybrid','FS Drafted',3,true),('hybrid','FS Approved',4,true),('hybrid','TS Drafted',5,true),('hybrid','TS Approved',6,true),
 ('hybrid','In Progress',7,true),('hybrid','In Review',8,true),('hybrid','UAT',9,true),('hybrid','Deployed',10,true),('hybrid','Closed',11,true),
 ('itil','New',1,true),('itil','Triage',2,true),('itil','Assessment',3,true),('itil','Change Approved',4,true),('itil','Implementation',5,true),('itil','In Progress',6,true),
 ('itil','Pending',7,true),('itil','Review',8,true),('itil','Resolved',9,true),('itil','Closed',10,true)
) v(t, p, ord, d);

INSERT INTO template_ticket_types (template_type_id, ticket_type_id)
SELECT _tt(t), _ty(y) FROM (VALUES
 ('waterfall','requirement'),('waterfall','wricef'),('waterfall','epic'),('waterfall','feature'),('waterfall','bug'),
 ('hybrid','requirement'),('hybrid','wricef'),('hybrid','epic'),('hybrid','feature'),('hybrid','bug'),
 ('agile','wricef'),('agile','epic'),('agile','feature'),('agile','bug'),
 ('itil','incident'),('itil','problem'),('itil','change'),('itil','ritm')) v(t, y);

INSERT INTO project_type_template_defaults SELECT _pt(p), _tt(t) FROM (VALUES
 ('implementation','waterfall'),('support','itil'),('devops','agile'),('conversion','waterfall')) v(p, t);
INSERT INTO project_type_ticket_defaults (project_type_id, ticket_type_id, default_on, is_default) SELECT _pt(p), _ty(y), d, def FROM (VALUES
 ('implementation','requirement',true,true),('implementation','wricef',true,false),('implementation','epic',true,false),('implementation','feature',false,false),('implementation','bug',false,false),
 ('support','incident',true,true),('support','change',true,false),('support','problem',false,false),('support','ritm',false,false),
 ('devops','feature',true,true),('devops','bug',true,false),('devops','epic',true,false),('devops','wricef',false,false),
 ('conversion','wricef',true,true),('conversion','bug',true,false),('conversion','requirement',false,false),('conversion','epic',false,false)) v(p, y, d, def);
INSERT INTO project_type_phase_defaults SELECT _pt('implementation'), _ph('Hypercare'), true;
INSERT INTO project_type_phase_defaults SELECT _pt('implementation'), _ph('Closed'), true;
INSERT INTO project_type_phase_defaults SELECT _pt('conversion'), _ph('Hypercare'), true;
INSERT INTO project_type_phase_defaults SELECT _pt('conversion'), _ph('Closed'), true;

-- Transitions. g1..g4 are the document-driven steps of the original lifecycle.
CREATE FUNCTION _edge(t TEXT, ty TEXT, f TEXT, d TEXT, g TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO workflow_transitions (template_type_id, ticket_type_id, from_phase_id, to_phase_id, gated_reason)
  VALUES (_tt(t), CASE WHEN ty IS NULL THEN NULL ELSE _ty(ty) END, CASE WHEN f IS NULL THEN NULL ELSE _ph(f) END, _ph(d), g) $$;

SELECT _edge('waterfall', NULL, NULL, 'Requirement Verified');
SELECT _edge('waterfall', NULL, 'Requirement Verified', 'FS Drafted', 'Generate the Functional Specification to move forward');
SELECT _edge('waterfall', NULL, 'FS Drafted', 'FS Approved', 'The Functional Specification needs an approval');
SELECT _edge('waterfall', NULL, 'FS Approved', 'TS Drafted', 'Generate the Technical Specification to move forward');
SELECT _edge('waterfall', NULL, 'TS Drafted', 'TS Approved', 'The Technical Specification needs an approval');
SELECT _edge('waterfall', NULL, 'TS Approved', 'Development');
SELECT _edge('waterfall', NULL, 'Development', 'QA');
SELECT _edge('waterfall', NULL, 'QA', 'UAT');
SELECT _edge('waterfall', NULL, 'UAT', 'Deployed');
SELECT _edge('waterfall', NULL, 'Deployed', 'Hypercare');
SELECT _edge('waterfall', NULL, 'Hypercare', 'Closed');

SELECT _edge('hybrid', NULL, NULL, 'Backlog');
SELECT _edge('hybrid', NULL, 'Backlog', 'Requirement Verified');
SELECT _edge('hybrid', NULL, 'Requirement Verified', 'FS Drafted', 'Generate the Functional Specification to move forward');
SELECT _edge('hybrid', NULL, 'FS Drafted', 'FS Approved', 'The Functional Specification needs an approval');
SELECT _edge('hybrid', NULL, 'FS Approved', 'TS Drafted', 'Generate the Technical Specification to move forward');
SELECT _edge('hybrid', NULL, 'TS Drafted', 'TS Approved', 'The Technical Specification needs an approval');
SELECT _edge('hybrid', NULL, 'TS Approved', 'In Progress');
SELECT _edge('hybrid', NULL, 'In Progress', 'In Review');
SELECT _edge('hybrid', NULL, 'In Review', 'In Progress');
SELECT _edge('hybrid', NULL, 'In Review', 'UAT');
SELECT _edge('hybrid', NULL, 'UAT', 'Deployed');
SELECT _edge('hybrid', NULL, 'Deployed', 'Closed');

SELECT _edge('agile', NULL, NULL, 'Backlog');
SELECT _edge('agile', NULL, 'Backlog', 'Ready');
SELECT _edge('agile', NULL, 'Ready', 'Backlog');
SELECT _edge('agile', NULL, 'Ready', 'In Progress');
SELECT _edge('agile', NULL, 'In Progress', 'In Review');
SELECT _edge('agile', NULL, 'In Review', 'In Progress');
SELECT _edge('agile', NULL, 'In Review', 'Done');

SELECT _edge('itil', NULL, NULL, 'New');
SELECT _edge('itil', NULL, 'New', 'Triage');
SELECT _edge('itil', NULL, 'Triage', 'In Progress');
SELECT _edge('itil', NULL, 'In Progress', 'Pending');
SELECT _edge('itil', NULL, 'Pending', 'In Progress');
SELECT _edge('itil', NULL, 'In Progress', 'Resolved');
SELECT _edge('itil', NULL, 'Resolved', 'In Progress');
SELECT _edge('itil', NULL, 'Resolved', 'Closed');
-- Change requests follow their own controlled flow.
SELECT _edge('itil', 'change', NULL, 'New');
SELECT _edge('itil', 'change', 'New', 'Assessment');
SELECT _edge('itil', 'change', 'Assessment', 'Change Approved');
SELECT _edge('itil', 'change', 'Assessment', 'Closed');
SELECT _edge('itil', 'change', 'Change Approved', 'Implementation');
SELECT _edge('itil', 'change', 'Implementation', 'Review');
SELECT _edge('itil', 'change', 'Review', 'Implementation');
SELECT _edge('itil', 'change', 'Review', 'Closed');

-- Dynamic field definitions
INSERT INTO ticket_type_fields (ticket_type_id, key, label, kind, options, required, help, position)
SELECT _ty(t), k, l, kd, o::jsonb, r, h, p FROM (VALUES
 ('incident','priority','Priority','select','["P1 - Critical","P2 - High","P3 - Medium","P4 - Low"]',true,'How urgently the business needs this fixed.',1),
 ('incident','impact','Impact','select','["Enterprise-wide","Department","Single user"]',true,'How many people are affected.',2),
 ('incident','urgency','Urgency','select','["High","Medium","Low"]',false,'',3),
 ('incident','affected_service','Affected service','text','[]',false,'For example the transaction, interface or application.',4),
 ('incident','steps_to_reproduce','Steps to reproduce','textarea','[]',true,'What someone does to see the problem.',5),
 ('problem','root_cause','Suspected root cause','textarea','[]',false,'',1),
 ('problem','related_incidents','Related incidents','text','[]',false,'Incident numbers, comma separated.',2),
 ('problem','workaround','Known workaround','textarea','[]',false,'',3),
 ('change','change_type','Change type','select','["Standard","Normal","Emergency"]',true,'',1),
 ('change','risk','Risk','select','["Low","Medium","High"]',true,'',2),
 ('change','planned_start','Planned start','date','[]',false,'',3),
 ('change','implementation_plan','Implementation plan','textarea','[]',true,'',4),
 ('change','rollback_plan','Rollback plan','textarea','[]',true,'How to undo the change if it goes wrong.',5),
 ('ritm','requested_for','Requested for','text','[]',true,'',1),
 ('ritm','catalog_item','Catalogue item','text','[]',true,'',2),
 ('ritm','quantity','Quantity','number','[]',false,'',3),
 ('wricef','ricef_category','RICEF category','select','["Workflow","Report","Interface","Conversion","Enhancement","Form"]',true,'The kind of development object.',1),
 ('wricef','sap_module','SAP module','select','["FICO","SD","MM","PP","QM","PM","HCM","Basis","Other"]',true,'',2),
 ('wricef','business_value','Business value','textarea','[]',false,'Why the business needs this.',3),
 ('epic','business_goal','Business goal','textarea','[]',true,'',1),
 ('epic','target_release','Target release','text','[]',false,'',2),
 ('feature','story_points','Story points','number','[]',false,'',1),
 ('feature','user_value','User value','textarea','[]',false,'',2),
 ('bug','severity','Severity','select','["Blocker","Major","Minor","Trivial"]',true,'',1),
 ('bug','environment','Environment','text','[]',false,'',2),
 ('bug','steps_to_reproduce','Steps to reproduce','textarea','[]',true,'',3),
 ('bug','expected_actual','Expected versus actual','textarea','[]',false,'',4)
) v(t, k, l, kd, o, r, h, p);

-- ---------------------------------------------------------------- tickets: enum -> text, type and metadata
ALTER TABLE tickets ADD COLUMN ticket_type_id INT REFERENCES ticket_types(id);
ALTER TABLE tickets ADD COLUMN dynamic_metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(dynamic_metadata) = 'object');
DROP TRIGGER tickets_state_guard ON tickets;
ALTER TABLE tickets ALTER COLUMN current_state DROP DEFAULT;
ALTER TABLE tickets ALTER COLUMN current_state TYPE TEXT USING current_state::text;
ALTER TABLE ticket_transitions ALTER COLUMN from_state TYPE TEXT USING from_state::text;
ALTER TABLE ticket_transitions ALTER COLUMN to_state TYPE TEXT USING to_state::text;
DROP FUNCTION enforce_ticket_state();
DROP TYPE ticket_state;

-- Existing projects become Implementation + Waterfall with exactly the old nine phases on; existing tickets are Requirements.
UPDATE projects SET project_type_id = _pt('implementation'), template_type_id = _tt('waterfall');
INSERT INTO project_phases (project_id, phase_id, position, enabled)
SELECT p.id, tp.phase_id, tp.position, tp.default_on FROM projects p JOIN template_phases tp ON tp.template_type_id = p.template_type_id;
INSERT INTO project_ticket_types (project_id, ticket_type_id, enabled, is_default)
SELECT p.id, _ty('requirement'), true, true FROM projects p;
UPDATE tickets SET ticket_type_id = _ty('requirement');
CREATE INDEX tickets_type_idx ON tickets (project_id, ticket_type_id);

-- ---------------------------------------------------------------- the dynamic graph
-- Where can a ticket of this type, in this project, go from `p_from` (NULL = where does a new ticket start)?
-- Switched-off phases are bypassed: the walk continues through them to the next switched-on phase.
CREATE FUNCTION next_phases(p_project UUID, p_type INT, p_from TEXT)
RETURNS TABLE (to_phase TEXT, gated_reason TEXT) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE
  cfg AS (SELECT template_type_id AS tt FROM projects WHERE id = p_project),
  own AS (SELECT EXISTS (SELECT 1 FROM workflow_transitions w, cfg WHERE w.template_type_id = cfg.tt AND w.ticket_type_id = p_type) AS has),
  e AS (
    SELECT w.from_phase_id AS f, w.to_phase_id AS t, w.gated_reason AS g
    FROM workflow_transitions w, cfg, own
    WHERE w.template_type_id = cfg.tt AND ((own.has AND w.ticket_type_id = p_type) OR (NOT own.has AND w.ticket_type_id IS NULL))),
  en AS (SELECT phase_id FROM project_phases WHERE project_id = p_project AND enabled),
  walk(t, g, depth) AS (
    SELECT e.t, e.g, 1 FROM e LEFT JOIN phases pf ON pf.id = e.f
    WHERE (p_from IS NULL AND e.f IS NULL) OR (p_from IS NOT NULL AND pf.name = p_from)
    UNION
    SELECT e2.t, COALESCE(w.g, e2.g), w.depth + 1 FROM walk w JOIN e e2 ON e2.f = w.t
    WHERE w.t NOT IN (SELECT phase_id FROM en) AND w.depth < 12)
  SELECT DISTINCT ON (ph.name) ph.name, walk.g FROM walk JOIN phases ph ON ph.id = walk.t
  WHERE walk.t IN (SELECT phase_id FROM en) ORDER BY ph.name, (walk.g IS NULL)
$$;

-- Database-level enforcement: a ticket can only move along the project's workflow.
CREATE FUNCTION enforce_ticket_state() RETURNS trigger AS $$
BEGIN
  IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
    IF NOT EXISTS (SELECT 1 FROM next_phases(NEW.project_id, NEW.ticket_type_id, OLD.current_state) n WHERE n.to_phase = NEW.current_state) THEN
      RAISE EXCEPTION 'Illegal state transition: % -> %', OLD.current_state, NEW.current_state USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state) VALUES (NEW.id, OLD.current_state, NEW.current_state);
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tickets_state_guard BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION enforce_ticket_state();

-- New tickets get their project's default ticket type and that type's entry phase unless the caller says otherwise.
CREATE FUNCTION ticket_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.ticket_type_id IS NULL THEN
    SELECT ticket_type_id INTO NEW.ticket_type_id FROM project_ticket_types WHERE project_id = NEW.project_id AND enabled ORDER BY is_default DESC, ticket_type_id LIMIT 1;
  END IF;
  IF NEW.current_state IS NULL THEN
    SELECT to_phase INTO NEW.current_state FROM next_phases(NEW.project_id, NEW.ticket_type_id, NULL) ORDER BY to_phase LIMIT 1;
  END IF;
  IF NEW.current_state IS NULL OR NOT EXISTS (SELECT 1 FROM phases WHERE name = NEW.current_state) THEN
    RAISE EXCEPTION 'This project has no starting phase for the ticket type' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tickets_defaults BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION ticket_defaults();
ALTER TABLE tickets ALTER COLUMN current_state SET NOT NULL;

-- Configure a project from its type and methodology (called when a project is created and by the template builder).
CREATE FUNCTION seed_project_workflow(p_project UUID, p_ptype INT, p_ttype INT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects SET project_type_id = p_ptype, template_type_id = p_ttype WHERE id = p_project;
  DELETE FROM project_phases WHERE project_id = p_project;
  INSERT INTO project_phases (project_id, phase_id, position, enabled)
    SELECT p_project, tp.phase_id, tp.position, COALESCE(d.enabled, tp.default_on)
    FROM template_phases tp LEFT JOIN project_type_phase_defaults d ON d.project_type_id = p_ptype AND d.phase_id = tp.phase_id WHERE tp.template_type_id = p_ttype;
  DELETE FROM project_ticket_types WHERE project_id = p_project;
  INSERT INTO project_ticket_types (project_id, ticket_type_id, enabled, is_default)
    SELECT p_project, tt.ticket_type_id, COALESCE(d.default_on, false), COALESCE(d.is_default, false)
    FROM template_ticket_types tt LEFT JOIN project_type_ticket_defaults d ON d.project_type_id = p_ptype AND d.ticket_type_id = tt.ticket_type_id WHERE tt.template_type_id = p_ttype;
  -- always keep exactly one default among the enabled types
  IF NOT EXISTS (SELECT 1 FROM project_ticket_types WHERE project_id = p_project AND enabled AND is_default) THEN
    UPDATE project_ticket_types SET is_default = true WHERE (project_id, ticket_type_id) = (
      SELECT project_id, ticket_type_id FROM project_ticket_types WHERE project_id = p_project AND enabled ORDER BY ticket_type_id LIMIT 1);
  END IF;
END $$;

-- A project created without choosing anything is the original: Implementation + Waterfall, Requirements only.
CREATE FUNCTION project_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.template_type_id IS NULL THEN
    PERFORM seed_project_workflow(NEW.id, NULL, _tt('waterfall'));
    UPDATE projects SET project_type_id = _pt('implementation') WHERE id = NEW.id;
    DELETE FROM project_ticket_types WHERE project_id = NEW.id AND ticket_type_id <> _ty('requirement');
    UPDATE project_ticket_types SET enabled = true, is_default = true WHERE project_id = NEW.id AND ticket_type_id = _ty('requirement');
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER projects_defaults AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION project_defaults();

GRANT SELECT, INSERT, UPDATE, DELETE ON template_types, project_types, ticket_types, phases, template_phases, template_ticket_types, project_type_ticket_defaults,
  project_type_phase_defaults, project_type_template_defaults, workflow_transitions, ticket_type_fields, project_phases, project_ticket_types TO design_max_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO design_max_app;
