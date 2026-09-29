import { pool } from '../src/db/pool.js';
import { chunkDocumentText } from '../src/services/knowledge-chunking.js';
import { embedDocumentChunks } from '../src/services/embeddings.js';
import { config } from '../src/config.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000003';
const inputs = [
  ['00000000-0000-4000-8000-000000000011','Digital banking and customer onboarding','STAKEHOLDER_STATEMENT','Customers should be able to start an account application online, save progress, and see which identity documents are still needed. Staff need a queue to review submitted applications and request corrections.'],
  ['00000000-0000-4000-8000-000000000012','Payment processing','PROCESS_DESCRIPTION','The platform should accept domestic payment instructions, validate account details, show processing status, and provide an audit reference for each submitted payment. Failed payments should include a reason that support staff can understand.'],
  ['00000000-0000-4000-8000-000000000013','Loan origination','REQUIREMENT_NOTES','Applicants can submit a loan application and supporting documents. Credit reviewers need to record a decision and reasons. The system should show missing information before submission and allow an applicant to respond to a document request.'],
  ['00000000-0000-4000-8000-000000000014','Fraud detection','BUSINESS_CONTEXT','Flag unusual transfer patterns for analyst review. Analysts should be able to record whether an alert was useful. A flagged transaction must not automatically be treated as confirmed fraud.'],
  ['00000000-0000-4000-8000-000000000015','Trade finance / Letter of Credit','MEETING_NOTES','The platform should track letter-of-credit applications, document checks, amendment requests, approval status, and key dates. Operations staff need a history of who changed a case and when.'],
  ['00000000-0000-4000-8000-000000000016','Problematic requirements for review','INTERVIEW_TRANSCRIPT','The system should be fast and easy to use. It must approve every application after a manager reviews it, but no application may be approved until two managers have approved it. Payments should finish quickly, but they must never be processed before the fraud check completes. Users should authenticate securely. Keep customer records for an appropriate period. The platform should support many users at the same time.'],
  ['00000000-0000-4000-8000-000000000017','Insurance Claims Processing','STAKEHOLDER_STATEMENT','Claims staff shall register each claim with the policy number, claimant details, incident date, and supporting documents. The system shall assign a unique claim reference and show the claim status to the claimant. Claims adjusters shall record the coverage decision, decision rationale, approved benefit amount, and payment status. Claimants shall be able to upload requested supplemental documents through the portal. The service shall maintain 99.9% monthly availability, excluding scheduled maintenance. Claims shall be resolved promptly.'],
];
const knowledge = [
  { id:'00000000-0000-4000-8000-000000000021', title:'DEMO Control Note: Identity and Access', domain:'CUSTOMER_ONBOARDING_KYC', text:'DEMO / NON-AUTHORITATIVE CONTROL EXAMPLE. A project team may choose to specify named user roles, strong authentication requirements, access review frequency, and audit logging for sensitive customer operations. This sample is educational and is not an official regulation or legal requirement.' },
  { id:'00000000-0000-4000-8000-000000000022', title:'DEMO Control Note: Data Retention and Payments', domain:'PAYMENTS', text:'DEMO / NON-AUTHORITATIVE CONTROL EXAMPLE. A project team may define payment processing states, exception handling, reconciliation, retention periods, and deletion rules with accountable business owners. This sample is educational and is not an official regulation or legal requirement.' },
];

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users(id,display_name,email,role) VALUES($1,'Local Development Owner','owner@local.test','ADMIN') ON CONFLICT(id) DO NOTHING`,[ownerId]);
    await client.query(`INSERT INTO projects(id,name,description,selected_domain,status,owner_id) VALUES($1,'Requirements Intelligence Financial Services Demo','Deterministic demo project spanning onboarding, payments, lending, fraud, and trade finance.','General Financial','ACTIVE',$2) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,selected_domain=EXCLUDED.selected_domain,status=EXCLUDED.status,owner_id=EXCLUDED.owner_id,updated_at=now()`,[projectId,ownerId]);
    for (const [id,title,type,text] of inputs) await client.query(`INSERT INTO project_inputs(id,project_id,input_type,title,source,submitted_content,processing_status,created_by) VALUES($1,$2,$3,$4,'Deterministic demo seed',$5,'READY',$6) ON CONFLICT(id) DO UPDATE SET project_id=EXCLUDED.project_id,input_type=EXCLUDED.input_type,title=EXCLUDED.title,source=EXCLUDED.source,submitted_content=EXCLUDED.submitted_content,processing_status='READY',processing_error=NULL,updated_at=now()`,[id,projectId,type,title,text,ownerId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  for (const item of knowledge) {
    const chunks=chunkDocumentText(item.text,{maxChars:1200,overlapChars:100});
    const vectors=await embedDocumentChunks(chunks,item.title);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO knowledge_documents(id,title,source,document_type,financial_domain,jurisdiction,version,authority,tags,original_filename,mime_type,file_size_bytes,storage_key,extracted_text,processing_status) VALUES($1,$2,'Local demo corpus','ORGANIZATIONAL_POLICY',$3,NULL,'demo-v1','DEMO / NON-AUTHORITATIVE',ARRAY['demo','non-authoritative','requirements-intelligence'],'demo-control.txt','text/plain',$4,$5,$6,'READY') ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,source=EXCLUDED.source,document_type=EXCLUDED.document_type,financial_domain=EXCLUDED.financial_domain,version=EXCLUDED.version,authority=EXCLUDED.authority,tags=EXCLUDED.tags,extracted_text=EXCLUDED.extracted_text,processing_status='READY',updated_at=now()`,[item.id,item.title,item.domain,item.text.length,`demo-${item.id}`,item.text]);
      for(let i=0;i<chunks.length;i++) await client.query(`INSERT INTO knowledge_chunks(knowledge_document_id,chunk_index,chunk_text,chunk_metadata,embedding,embedding_model) VALUES($1,$2,$3,$4,$5::vector,$6) ON CONFLICT(knowledge_document_id,chunk_index) DO UPDATE SET chunk_text=EXCLUDED.chunk_text,chunk_metadata=EXCLUDED.chunk_metadata,embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,updated_at=now()`,[item.id,i,chunks[i].chunkText,chunks[i].metadata,`[${vectors[i].join(',')}]`,config.knowledge.embeddingModel]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
  }
  console.log(`Seeded demo project ${projectId}: ${inputs.length} READY inputs and ${knowledge.length} non-authoritative KB notes.`);
} catch(error) { console.error(`Demo seed failed: ${error.message}`); process.exitCode=1; }
finally { await pool.end(); }
