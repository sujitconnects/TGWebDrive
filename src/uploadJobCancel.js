// In-memory cooperative cancellation flags for in-flight uploads (single process,
// same pattern as src/jobs.js's in-memory progress pub/sub). The DB row is the
// source of truth for the job's final status; this Set only lets an in-flight
// request handler notice "please stop" at safe checkpoints (between chunks,
// between retry attempts) without needing to poll the database.
const cancelledJobIds = new Set();

export function requestUploadJobCancel(jobId) {
  if (jobId) cancelledJobIds.add(jobId);
}
export function isUploadJobCancelRequested(jobId) {
  return !!jobId && cancelledJobIds.has(jobId);
}
export function clearUploadJobCancel(jobId) {
  if (jobId) cancelledJobIds.delete(jobId);
}
