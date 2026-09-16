import { Router } from "express";
import fs from "node:fs";
import { stmt } from "../db.js";
import { requireAppAuth, requireAccount } from "../middleware.js";
import { getConnectedClient } from "../tg/manager.js";
import { buildPeer, uploadFile, serializeMessage } from "../tg/operations.js";
import { cleanupPath } from "../util.js";
import { canAccessUploadJob, isUploadJobRetryEligible, canTransitionUploadJob } from "../uploadJobPolicy.js";
import { requestUploadJobCancel } from "../uploadJobCancel.js";

export const uploadJobs = Router();

function requesterFrom(req) {
  return { accountId: req.accountId, userId: req.user?.id, isAdmin: req.user?.role === "admin" };
}

// Never send the server-side temp path (or anything else internal) to the client.
function serializeUploadJob(j) {
  return {
    id: j.id,
    fileName: j.file_name,
    mime: j.mime,
    totalBytes: j.total_bytes != null ? Number(j.total_bytes) : null,
    receivedBytes: Number(j.received_bytes) || 0,
    uploadedBytes: Number(j.uploaded_bytes) || 0,
    status: j.status,
    retryCount: j.retry_count,
    lastError: j.last_error,
    msgId: j.msg_id,
    multipartId: j.multipart_id,
    hasTempFile: !!j.tmp_path,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    cancelledAt: j.cancelled_at,
  };
}

async function loadOwnedJob(req, res) {
  const job = await stmt.getUploadJob(req.params.id);
  if (!canAccessUploadJob(job, requesterFrom(req))) {
    res.status(404).json({ error: "Upload job not found" });
    return null;
  }
  return job;
}

uploadJobs.get("/files/upload/jobs", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const rows = await stmt.listUploadJobsForAccount(req.accountId, { userId: req.user.id, isAdmin: req.user.role === "admin" });
    res.json({ jobs: rows.map(serializeUploadJob) });
  } catch (e) {
    next(e);
  }
});

uploadJobs.get("/files/upload/jobs/:id", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    res.json({ job: serializeUploadJob(job) });
  } catch (e) {
    next(e);
  }
});

uploadJobs.post("/files/upload/jobs/:id/cancel", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (!["queued", "uploading", "retrying"].includes(job.status)) {
      return res.status(409).json({ error: "This upload job has already finished and cannot be cancelled." });
    }
    // Best-effort: an in-flight request handler polls this flag at safe checkpoints
    // (between chunks, between retry attempts). A Telegram send already in flight
    // for this attempt cannot be aborted mid-call, so cancellation there only takes
    // effect before the *next* attempt/checkpoint — it never corrupts a transfer
    // that has already been accepted by Telegram.
    requestUploadJobCancel(job.id);
    await stmt.markUploadJobCancelled(job.id, Date.now());
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

uploadJobs.post("/files/upload/jobs/:id/retry", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    const tmpExists = !!job.tmp_path && fs.existsSync(job.tmp_path);
    if (!isUploadJobRetryEligible(job, { tmpExists }) || !canTransitionUploadJob(job.status, "uploading")) {
      return res.status(409).json({ error: "This upload job cannot be retried. Please re-upload the file instead." });
    }

    await stmt.markUploadJobStarted(job.id, job.tmp_path, Date.now());
    let sent;
    try {
      const peer = buildPeer({ peer_json: job.peer_json });
      const client = await getConnectedClient(job.account_id);
      sent = await uploadFile(client, peer, {
        filePath: job.tmp_path,
        fileName: job.file_name,
        fileSize: job.total_bytes != null ? Number(job.total_bytes) : undefined,
        caption: job.caption || "",
        forceDocument: !!job.force_document,
        onProgress: (uploaded) => {
          stmt.updateUploadJobProgress(job.id, { receivedBytes: Number(job.received_bytes) || 0, uploadedBytes: Number(uploaded) || 0 }, Date.now()).catch(() => {});
        },
      });
    } catch (e) {
      await stmt.markUploadJobFailed(job.id, String(e?.message || e), Date.now());
      await cleanupPath(job.tmp_path, { label: "upload-job-retry-cleanup" });
      return next(e);
    }
    const file = serializeMessage(sent);
    await stmt.markUploadJobCompleted(job.id, { msgId: file?.id }, Date.now());
    await cleanupPath(job.tmp_path, { label: "upload-job-retry-cleanup" });
    res.json({ ok: true, file });
  } catch (e) {
    next(e);
  }
});
