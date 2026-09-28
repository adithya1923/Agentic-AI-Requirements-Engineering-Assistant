// Source-grounded Phase 5 extraction schema and validation, consumed only by
// the unified Requirements Intelligence workflow.
const requirementTypes = new Set(['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT', 'OTHER', 'UNKNOWN']);
const priorities = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);

export const requirementResponseSchema = {
  type:'object', additionalProperties:false,
  properties:{ requirements:{ type:'array', maxItems:20, items:{ type:'object', additionalProperties:false, properties:{
    requirementText:{type:'string',minLength:1,maxLength:3000}, requirementType:{type:'string',enum:[...requirementTypes]},
    priority:{anyOf:[{type:'string',enum:[...priorities]},{type:'null'}]}, sourceEvidence:{type:'string',minLength:1,maxLength:10000},
    confidence:{type:'number',minimum:0,maximum:1}, assumptions:{type:'array',maxItems:3,items:{type:'string',minLength:1,maxLength:1000}},
  },required:['requirementText','requirementType','priority','sourceEvidence','confidence','assumptions']} } },
  required:['requirements'],
};

export class RequirementExtractionError extends Error {
  constructor(message,code,status=502){super(message);this.name='RequirementExtractionError';this.code=code;this.status=status;}
}

export function validateRequirementOutput(rawContent,sourceText) {
  let output; try { output=JSON.parse(rawContent); } catch { throw invalidOutput('INVALID_JSON'); }
  if (!isObject(output)||!exactKeys(output,['requirements'])||!Array.isArray(output.requirements)||output.requirements.length>20) throw invalidOutput('ROOT_OR_REQUIREMENT_ARRAY');
  return output.requirements.map((item)=>{
    const fields=['requirementText','requirementType','priority','sourceEvidence','confidence','assumptions'];
    if(!isObject(item))throw invalidOutput('REQUIREMENT_OBJECT_SHAPE',{field:'requirement',validationReason:'must be an object'});
    if(!exactKeys(item,fields)){const missing=fields.filter((field)=>!Object.hasOwn(item,field));const unexpected=Object.keys(item).filter((field)=>!fields.includes(field));throw invalidOutput('REQUIREMENT_OBJECT_SHAPE',{field:missing[0]||unexpected[0]||'requirement',validationReason:missing.length?`missing required field${missing.length===1?'':'s'}`:'unexpected field',safeValue:{missing,unexpected}});}
    const requirementText=typeof item.requirementText==='string'?item.requirementText.trim():'';
    const evidence=typeof item.sourceEvidence==='string'?item.sourceEvidence:'';
    if(!requirementText||requirementText.length>3000)throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'requirementText',validationReason:!requirementText?'must be a non-empty string':'exceeds 3000 characters',safeValue:{type:typeof item.requirementText,length:typeof item.requirementText==='string'?item.requirementText.length:null}});
    if(!requirementTypes.has(item.requirementType))throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'requirementType',validationReason:'must be one of the allowed requirement types',safeValue:safeEnum(item.requirementType,requirementTypes)});
    if(!(item.priority===null||priorities.has(item.priority)))throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'priority',validationReason:'must be an allowed priority or null',safeValue:safeEnum(item.priority,priorities)});
    if(!evidence.trim()||evidence.length>10000)throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'sourceEvidence',validationReason:!evidence.trim()?'must be a non-empty source quote':'exceeds 10000 characters',safeValue:{type:typeof item.sourceEvidence,length:typeof item.sourceEvidence==='string'?item.sourceEvidence.length:null}});
    if(!validConfidence(item.confidence))throw invalidOutput('REQUIREMENT_FIELD_OR_CONFIDENCE',{field:'confidence',validationReason:'must be a JSON number from 0 to 1',safeValue:typeof item.confidence==='string'?{type:'string',length:item.confidence.length}:safeScalar(item.confidence)});
    if(!Array.isArray(item.assumptions))throw invalidOutput('ASSUMPTION_EVIDENCE',{field:'assumptions',validationReason:'must be an array of source-grounded strings',safeValue:{type:typeof item.assumptions}});
    if(item.assumptions.length>3)throw invalidOutput('ASSUMPTION_EVIDENCE',{field:'assumptions',validationReason:'exceeds 3 items',safeValue:{count:item.assumptions.length}});
    const invalidAssumption=item.assumptions.findIndex((a)=>typeof a!=='string'||!a.trim()||a.length>1000||!sourceText.includes(a));
    if(invalidAssumption!==-1){const a=item.assumptions[invalidAssumption];throw invalidOutput('ASSUMPTION_EVIDENCE',{field:'assumptions',validationReason:typeof a!=='string'?'item must be a string':!a.trim()?'item must be non-empty':a.length>1000?'item exceeds 1000 characters':'item is not grounded in source',safeValue:{index:invalidAssumption,type:typeof a,length:typeof a==='string'?a.length:null}});}
    if(item.priority&&item.priority!=='UNKNOWN'&&!new RegExp(`\\b${item.priority}\\b`,'i').test(evidence))throw invalidOutput('UNSUPPORTED_PRIORITY',{field:'priority',validationReason:'priority is not supported by the source quote',safeValue:item.priority});
    const span=findSourceSpan(sourceText,evidence); if(!span)throw invalidOutput('SOURCE_EVIDENCE_NOT_FOUND',{field:'sourceEvidence',validationReason:'quote was not found in source text',safeValue:{type:'string',length:evidence.length}});
    return {requirementText,requirementType:item.requirementType,priority:item.priority,sourceEvidence:sourceText.slice(span.start,span.end),sourceEvidenceStart:span.start,sourceEvidenceEnd:span.end,confidence:item.confidence,assumptions:item.assumptions.map((a)=>a.trim())};
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
