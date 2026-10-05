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
  selected_domain VARCHAR(120) NOT NULL DEFAULT 'General Financial',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_updated_at_idx ON projects (updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_owner_id_idx ON projects (owner_id);
ALTER TABLE projects ALTER COLUMN selected_domain SET DEFAULT 'General Financial';

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

CREATE TABLE IF NOT EXISTS candidate_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_input_id UUID NOT NULL REFERENCES project_inputs(id) ON DELETE CASCADE,
  requirement_text TEXT NOT NULL CHECK (length(trim(requirement_text)) BETWEEN 1 AND 3000),
  requirement_type TEXT NOT NULL CHECK (requirement_type IN (
    'FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT', 'SECURITY', 'OTHER', 'UNKNOWN'
  )),
  priority TEXT CHECK (priority IS NULL OR priority IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  source_evidence TEXT NOT NULL CHECK (length(trim(source_evidence)) BETWEEN 1 AND 10000),
  source_evidence_start INTEGER NOT NULL CHECK (source_evidence_start >= 0),
  source_evidence_end INTEGER NOT NULL CHECK (source_evidence_end > source_evidence_start),
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  assumptions TEXT[] NOT NULL DEFAULT '{}',
  extraction_status TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (extraction_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  generation_provider TEXT NOT NULL DEFAULT 'unknown',
  generation_model VARCHAR(120) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep existing databases compatible with the final semantic classification taxonomy.
ALTER TABLE candidate_requirements DROP CONSTRAINT IF EXISTS candidate_requirements_requirement_type_check;
ALTER TABLE candidate_requirements ADD CONSTRAINT candidate_requirements_requirement_type_check
  CHECK (requirement_type IN ('FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT', 'SECURITY', 'OTHER', 'UNKNOWN'));

ALTER TABLE candidate_requirements ADD COLUMN IF NOT EXISTS generation_provider TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE candidate_requirements ADD COLUMN IF NOT EXISTS generation_model VARCHAR(120) NOT NULL DEFAULT 'unknown';
ALTER TABLE candidate_requirements ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE candidate_requirements DROP CONSTRAINT IF EXISTS candidate_requirements_review_status_check;
ALTER TABLE candidate_requirements ADD CONSTRAINT candidate_requirements_review_status_check
  CHECK (review_status IN ('DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED', 'MODIFIED'));
ALTER TABLE candidate_requirements ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE candidate_requirements ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS candidate_requirements_project_idx
  ON candidate_requirements (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS candidate_requirements_source_input_idx
  ON candidate_requirements (source_input_id, created_at DESC);
CREATE INDEX IF NOT EXISTS candidate_requirements_status_idx
  ON candidate_requirements (extraction_status);

CREATE TABLE IF NOT EXISTS requirement_analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
  provider TEXT NOT NULL DEFAULT 'ollama',
  model_name VARCHAR(120) NOT NULL,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  requirement_count INTEGER NOT NULL CHECK (requirement_count >= 0),
  finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE requirement_analysis_runs ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE requirement_analysis_runs ADD COLUMN IF NOT EXISTS source_input_id UUID REFERENCES project_inputs(id) ON DELETE CASCADE;
ALTER TABLE requirement_analysis_runs DROP CONSTRAINT IF EXISTS requirement_analysis_runs_requirement_ids_check;
ALTER TABLE requirement_analysis_runs DROP CONSTRAINT IF EXISTS requirement_analysis_runs_requirement_count_check;
ALTER TABLE requirement_analysis_runs ADD CONSTRAINT requirement_analysis_runs_requirement_count_check CHECK (requirement_count >= 0);

CREATE INDEX IF NOT EXISTS requirement_analysis_runs_project_idx
  ON requirement_analysis_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requirement_analysis_runs_source_idx
  ON requirement_analysis_runs (project_id, source_input_id, created_at DESC);

CREATE TABLE IF NOT EXISTS requirement_analysis_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID NOT NULL REFERENCES requirement_analysis_runs(id) ON DELETE CASCADE,
  requirement_ids UUID[] NOT NULL CHECK (cardinality(requirement_ids) > 0),
  agent_names TEXT[] NOT NULL CHECK (cardinality(agent_names) > 0),
  finding_type TEXT NOT NULL CHECK (finding_type IN (
    'AMBIGUITY', 'INCOMPLETENESS', 'QUALITY', 'CONSISTENCY', 'CONFLICT', 'CLASSIFICATION', 'CLARIFICATION'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH')),
  title VARCHAR(180) NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  clarification_question TEXT,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requirement_analysis_findings_run_idx
  ON requirement_analysis_findings (analysis_run_id, created_at, id);
CREATE INDEX IF NOT EXISTS requirement_analysis_findings_type_severity_idx
  ON requirement_analysis_findings (finding_type, severity);
CREATE INDEX IF NOT EXISTS requirement_analysis_findings_requirement_ids_idx
  ON requirement_analysis_findings USING GIN (requirement_ids);

-- Stakeholder responses remain auditable even when a later source analysis replaces its findings.
CREATE TABLE IF NOT EXISTS clarification_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_run_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  requirement_ids UUID[] NOT NULL CHECK (cardinality(requirement_ids) > 0),
  question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 1000),
  answer TEXT NOT NULL CHECK (length(trim(answer)) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, finding_id, question)
);
CREATE INDEX IF NOT EXISTS clarification_answers_project_idx
  ON clarification_answers (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clarification_answers_requirement_ids_idx
  ON clarification_answers USING GIN (requirement_ids);

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

CREATE TABLE IF NOT EXISTS sdlc_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED', 'MODIFIED')),
  factors JSONB NOT NULL CHECK (jsonb_typeof(factors) = 'object'),
  ranking JSONB NOT NULL CHECK (jsonb_typeof(ranking) = 'array'),
  recommendation TEXT NOT NULL,
  explanation TEXT NOT NULL,
  workflow JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(workflow) = 'array'),
  artefacts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artefacts) = 'array'),
  requirement_ids UUID[] NOT NULL DEFAULT '{}',
  is_stale BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL,
  model_name VARCHAR(120) NOT NULL,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='sdlc_analyses' AND column_name='is_stale'
  ) THEN
    -- Results created before dependency tracking cannot be certified current.
    ALTER TABLE sdlc_analyses ADD COLUMN is_stale BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS sdlc_analyses_project_idx ON sdlc_analyses(project_id, created_at DESC);

INSERT INTO users (id, display_name, email, role)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local Development Owner', 'owner@local.test', 'ADMIN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, name, description, selected_domain, status, owner_id)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'Financial Services Requirements Project',
  'Initial multi-domain project context for financial-sector requirements engineering.',
  'General Financial',
  'DRAFT',
  '00000000-0000-4000-8000-000000000001'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  selected_domain = EXCLUDED.selected_domain,
  updated_at = now();
