// Shared application error type for the unified Requirements Intelligence
// service and its read APIs.
export class RequirementAnalysisError extends Error {
  constructor(message, code, status = 422) {
    super(message);
    this.name = 'RequirementAnalysisError';
    this.code = code;
    this.status = status;
  }
}
