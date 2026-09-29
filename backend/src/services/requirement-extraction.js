// Source-grounded Phase 5 extraction schema and validation, consumed only by
// the unified Requirements Intelligence workflow.
const requirementTypes = new Set(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT', 'OTHER', 'UNKNOWN']);
const priorities = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
const MAX_CANDIDATES = 80;
const MAX_CANDIDATE_CHARS = 2800;

export const requirementResponseSchema = {
  type:'object', additionalProperties:false,
  properties:{ requirements:{ type:'array', maxItems:20, items:{ type:'object', additionalProperties:false, properties:{
    candidateId:{type:'string',minLength:1,maxLength:64}, requirementType:{type:'string',enum:[...requirementTypes]},
    confidence:{type:'number',minimum:0,maximum:1},
  },required:['candidateId','requirementType','confidence']} } },
  required:['requirements'],
};

export class RequirementExtractionError extends Error {
  constructor(message,code,status=502){super(message);this.name='RequirementExtractionError';this.code=code;this.status=status;}
}

export function buildRequirementCandidates(sourceText, sourceInputId) {
  if (typeof sourceText !== 'string' || typeof sourceInputId !== 'string' || !sourceInputId) return [];
  const spans = [];
  const append = (rawStart, rawEnd) => {
    let start = rawStart, end = rawEnd;
    while (start < end && /\s/u.test(sourceText[start])) start += 1;
    while (end > start && /\s/u.test(sourceText[end - 1])) end -= 1;
    while (start < end) {
      let cut = Math.min(end, start + MAX_CANDIDATE_CHARS);
      if (cut < end) {
        let boundary = cut;
        while (boundary > start && !/\s/u.test(sourceText[boundary - 1])) boundary -= 1;
        if (boundary > start) cut = boundary;
      }
      let pieceEnd = cut;
      while (pieceEnd > start && /\s/u.test(sourceText[pieceEnd - 1])) pieceEnd -= 1;
      if (pieceEnd > start) spans.push({ start, end: pieceEnd });
      start = cut;
      while (start < end && /\s/u.test(sourceText[start])) start += 1;
    }
  };

  const boundaryPattern = /(?:\r\n|\r|\n)+|(?<=[.!?])\s+|,\s+(?:but|whereas|while)\s+/giu;
  let start = 0;
  for (const match of sourceText.matchAll(boundaryPattern)) {
    const boundaryStart = match.index;
    const isContrast = match[0].startsWith(',');
    append(start, isContrast ? boundaryStart + 1 : boundaryStart);
    start = boundaryStart + match[0].length;
  }
  append(start, sourceText.length);

  let boundedSpans = spans;
  if (spans.length > MAX_CANDIDATES) {
    boundedSpans = [];
    let groupStart = null, groupEnd = null;
    for (const span of spans) {
      if (groupStart !== null && span.end - groupStart > MAX_CANDIDATE_CHARS) {
        boundedSpans.push({ start: groupStart, end: groupEnd });
        groupStart = null;
      }
      if (groupStart === null) groupStart = span.start;
      groupEnd = span.end;
    }
    if (groupStart !== null) boundedSpans.push({ start: groupStart, end: groupEnd });
  }

  return boundedSpans.slice(0, MAX_CANDIDATES).map((span, index) => ({
    candidateId: `${sourceInputId}:C${index + 1}`,
    sourceInputId,
    text: sourceText.slice(span.start, span.end),
    start: span.start,
    end: span.end,
  }));
}

export function validateRequirementOutput(rawContent,sourceText) {
  let output; try { output=JSON.parse(rawContent); } catch { throw invalidOutput('INVALID_JSON'); }
  if (!isObject(output)||!exactKeys(output,['requirements'])||!Array.isArray(output.requirements)||output.requirements.length>20) throw invalidOutput('ROOT_OR_REQUIREMENT_ARRAY');
  return output.requirements.map((item)=>{
    const fields=['requirementText','requirementType','confidence'];
    if(!isObject(item))throw invalidOutput('REQUIREMENT_OBJECT_SHAPE',{field:'requirement',validationReason:'must be an object'});
    const allowedFields=[...fields,'priority','assumptions'];
    if(fields.some((field)=>!Object.hasOwn(item,field))||Object.keys(item).some((field)=>!allowedFields.includes(field))){const missing=fields.filter((field)=>!Object.hasOwn(item,field));const unexpected=Object.keys(item).filter((field)=>!allowedFields.includes(field));throw invalidOutput('REQUIREMENT_OBJECT_SHAPE',{field:missing[0]||unexpected[0]||'requirement',validationReason:missing.length?`missing required field${missing.length===1?'':'s'}`:'unexpected field',safeValue:{missing,unexpected}});}
    const requirementText=typeof item.requirementText==='string'?item.requirementText.trim():'';
    if(!requirementText||requirementText.length>3000)throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'requirementText',validationReason:!requirementText?'must be a non-empty string':'exceeds 3000 characters',safeValue:{type:typeof item.requirementText,length:typeof item.requirementText==='string'?item.requirementText.length:null}});
    if(!requirementTypes.has(item.requirementType))throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'requirementType',validationReason:'must be one of the allowed requirement types',safeValue:safeEnum(item.requirementType,requirementTypes)});
    if(!validConfidence(item.confidence))throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'confidence',validationReason:'must be a JSON number from 0 to 1',safeValue:typeof item.confidence==='string'?{type:'string',length:item.confidence.length}:safeScalar(item.confidence)});
    const assumptions=Array.isArray(item.assumptions)?item.assumptions:[];
    const span=findSourceSpan(sourceText,requirementText); if(!span)throw invalidOutput('SOURCE_EVIDENCE_NOT_FOUND',{field:'requirementText',validationReason:'candidate text was not found in source text',safeValue:{type:'string',length:requirementText.length}});
    const sourceEvidence=sourceText.slice(span.start,span.end);
    const proposedPriority=priorities.has(item.priority)||item.priority===null?item.priority:'UNKNOWN';
    const priority=proposedPriority&&proposedPriority!=='UNKNOWN'&&!new RegExp(`\\b${proposedPriority}\\b`,'i').test(sourceEvidence)?'UNKNOWN':proposedPriority;
    const groundedAssumptions=assumptions.filter((assumption)=>typeof assumption==='string'&&assumption.trim()&&assumption.length<=1000&&sourceText.includes(assumption)).slice(0,3).map((assumption)=>assumption.trim());
    return {requirementText,requirementType:item.requirementType,priority,sourceEvidence,sourceEvidenceStart:span.start,sourceEvidenceEnd:span.end,confidence:item.confidence,assumptions:groundedAssumptions};
  });
}

export function presentRequirement(row) {
  return {id:row.id,projectId:row.project_id,sourceInputId:row.source_input_id,requirementText:row.requirement_text,requirementType:row.requirement_type,priority:row.priority,sourceEvidence:row.source_evidence,sourceEvidenceStart:row.source_evidence_start,sourceEvidenceEnd:row.source_evidence_end,confidence:Number(row.confidence),assumptions:row.assumptions,extractionStatus:row.extraction_status,provider:row.generation_provider,modelName:row.generation_model,createdAt:row.created_at,updatedAt:row.updated_at};
}

function isObject(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function exactKeys(v,keys){return Object.keys(v).length===keys.length&&keys.every((k)=>Object.hasOwn(v,k));}
function validConfidence(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;}
function safeScalar(value){if(value===null||typeof value==='number'||typeof value==='boolean')return value;if(typeof value==='string')return value.length<=40?value:`${value.slice(0,40)}…`;return {type:Array.isArray(value)?'array':typeof value};}
function safeEnum(value,allowed){if(allowed.has(value))return value;if(value===null||typeof value==='number'||typeof value==='boolean')return value;return {type:Array.isArray(value)?'array':typeof value,length:typeof value==='string'?value.length:undefined};}
function invalidOutput(reason='OUTPUT_VALIDATION',detail){const error=new RequirementExtractionError('The model response did not match the required structure or exact source evidence.','INVALID_MODEL_OUTPUT',502);error.diagnosticReason=reason;if(detail)error.diagnosticDetail=detail;return error;}
function findSourceSpan(text,evidence){const source=normalize(text),candidate=normalize(evidence),start=source.text.indexOf(candidate.text);if(start<0||!candidate.text)return null;const end=start+candidate.text.length-1;return{start:source.starts[start],end:source.ends[end]};}
function normalize(value){let text='',starts=[],ends=[],pendingStart=null,pendingEnd=null,offset=0;for(const ch of value){const start=offset;offset+=ch.length;if(/\s/u.test(ch)){if(pendingStart===null)pendingStart=start;pendingEnd=offset;continue;}if(pendingStart!==null&&text.length){text+=' ';starts.push(pendingStart);ends.push(pendingEnd);}pendingStart=null;pendingEnd=null;text+=ch;for(let i=0;i<ch.length;i++){starts.push(start+i);ends.push(start+i+1);}}return{text,starts,ends};}
