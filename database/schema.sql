CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN (
    'ADMIN', 'BUSINESS_STAKEHOLDER', 'REQUIREMENTS_ENGINEER', 'TECHNICAL_STAKEHOLDER',
    'COMPLIANCE', 'SECURITY', 'RISK', 'PROJECT_MANAGER', 'APPROVER'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  selected_domain VARCHAR(120) NOT NULL DEFAULT 'Trade Finance / Letter of Credit',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_updated_at_idx ON projects (updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_owner_id_idx ON projects (owner_id);

INSERT INTO users (id, display_name, email, role)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local Development Owner', 'owner@local.test', 'ADMIN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, name, description, selected_domain, status, owner_id)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'Trade Finance / Letter of Credit Requirements Project',
  'Initial project context for requirements engineering on software supporting Trade Finance / Letter-of-Credit workflows.',
  'Trade Finance / Letter of Credit',
  'DRAFT',
  '00000000-0000-4000-8000-000000000001'
)
ON CONFLICT (id) DO NOTHING;
