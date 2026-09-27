CREATE EXTENSION IF NOT EXISTS vector;

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

CREATE TABLE IF NOT EXISTS project_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_type TEXT NOT NULL CHECK (input_type IN (
    'STAKEHOLDER_STATEMENT', 'MEETING_NOTES', 'INTERVIEW_TRANSCRIPT',
    'REQUIREMENT_NOTES', 'BUSINESS_CONTEXT', 'PROCESS_DESCRIPTION', 'OTHER_TEXT', 'DOCUMENT'
  )),
  title VARCHAR(200) NOT NULL CHECK (length(trim(title)) > 0),
  source VARCHAR(200) NOT NULL CHECK (length(trim(source)) > 0),
  original_filename VARCHAR(255),
  mime_type VARCHAR(255),
  file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  storage_key VARCHAR(80),
  submitted_content TEXT,
  extracted_text TEXT,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'READY', 'FAILED')),
  processing_error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (input_type = 'DOCUMENT'
      AND original_filename IS NOT NULL
      AND mime_type IS NOT NULL
      AND file_size_bytes IS NOT NULL
      AND storage_key IS NOT NULL
      AND submitted_content IS NULL)
    OR
    (input_type <> 'DOCUMENT'
      AND original_filename IS NULL
      AND mime_type IS NULL
      AND file_size_bytes IS NULL
      AND storage_key IS NULL
      AND submitted_content IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS project_inputs_project_created_idx
  ON project_inputs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_inputs_status_idx
  ON project_inputs (processing_status);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL CHECK (length(trim(title)) > 0),
  source VARCHAR(200) NOT NULL CHECK (length(trim(source)) > 0),
  document_type TEXT NOT NULL CHECK (document_type IN (
    'REGULATORY_MATERIAL', 'ORGANIZATIONAL_POLICY', 'BUSINESS_DOMAIN_REFERENCE',
    'RISK_CONTROL_REFERENCE', 'LEGACY_SYSTEM_DOCUMENTATION', 'EDUCATIONAL_REFERENCE', 'OTHER'
  )),
  financial_domain TEXT NOT NULL CHECK (financial_domain IN (
    'GENERAL_FINANCIAL', 'DIGITAL_BANKING', 'LOANS_CREDIT', 'PAYMENTS', 'FRAUD_DETECTION',
    'INSURANCE', 'INVESTMENT', 'REGULATORY_REPORTING', 'CUSTOMER_ONBOARDING_KYC',
    'FINANCIAL_DATA_ANALYTICS', 'TRADE_FINANCE', 'OTHER_FINANCIAL'
  )),
  jurisdiction VARCHAR(120),
  version VARCHAR(120),
  effective_date DATE,
  authority VARCHAR(200),
  tags TEXT[] NOT NULL DEFAULT '{}',
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
  storage_key VARCHAR(80) NOT NULL UNIQUE,
  extracted_text TEXT,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'READY', 'FAILED')),
  processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade path for databases that created the Phase 4 table before financial-domain metadata existed.
-- Legacy documents stay unclassified until an operator assigns their actual domain; the API requires
-- a valid domain for every new upload.
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS financial_domain TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_documents_financial_domain_values_check'
      AND conrelid = 'knowledge_documents'::regclass
  ) THEN
    ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_financial_domain_values_check
      CHECK (financial_domain IS NULL OR financial_domain IN (
        'GENERAL_FINANCIAL', 'DIGITAL_BANKING', 'LOANS_CREDIT', 'PAYMENTS', 'FRAUD_DETECTION',
        'INSURANCE', 'INVESTMENT', 'REGULATORY_REPORTING', 'CUSTOMER_ONBOARDING_KYC',
        'FINANCIAL_DATA_ANALYTICS', 'TRADE_FINANCE', 'OTHER_FINANCIAL'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_documents_status_idx
  ON knowledge_documents (processing_status);
CREATE INDEX IF NOT EXISTS knowledge_documents_type_idx
  ON knowledge_documents (document_type);
CREATE INDEX IF NOT EXISTS knowledge_documents_financial_domain_idx
  ON knowledge_documents (financial_domain);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_text TEXT NOT NULL CHECK (length(trim(chunk_text)) > 0),
  chunk_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768) NOT NULL,
  embedding_model VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knowledge_document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
  ON knowledge_chunks (knowledge_document_id, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

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
