// Startup-only recovery for upload jobs that were still non-terminal (queued/
// uploading/retrying) when the process last stopped — see uploadJobPolicy.js
// for the classification policy. Also does bounded cleanup of old finished
// job rows so the table doesn't grow forever (no background worker needed:
// this runs once per process start, which matches the current single-process,
// restart-on-deploy deployment model).
import fs from "node:fs";
import { stmt } from "./db.js";
import { cleanupPath } from "./util.js";
import { classifyInterruptedUploadJob } from "./uploadJobPolicy.js";

export async function recoverStaleUploadJobs() {
  const stale = await stmt.listStaleUploadJobs();
  for (const job of stale) {
    const tmpExists = !!job.tmp_path && fs.existsSync(job.tmp_path);
    const decision = classifyInterruptedUploadJob({ tmpExists, receivedBytes: job.received_bytes, totalBytes: job.total_bytes });
    await stmt.markUploadJobFailed(job.id, decision.lastError, Date.now());
    if (decision.deleteTmp) await cleanupPath(job.tmp_path, { label: "upload-job-recovery-cleanup" });
  }
  return stale.length;
}

export async function pruneOldUploadJobs(retentionMs) {
  const result = await stmt.deleteOldUploadJobs(Date.now() - retentionMs);
  return Array.isArray(result) ? result.length : 0;
}
