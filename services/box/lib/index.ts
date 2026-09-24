// @lares/agent-box — the box's state-store data layer.
export { poolFromEnv, poolFromUrl } from "./db.js";
export { startBoss } from "./boss.js";
export {
  createReminder,
  dueReminders,
  markDelivered,
  listPending,
  cancelReminder,
  type NewReminder,
  type Reminder,
  type DueReminder,
  type PendingReminder,
} from "./reminders.js";
export { findOrCreateSession, setSdkSession, touchSession, type Session } from "./sessions.js";
export {
  createConfirmation, getConfirmation, resolveConfirmation, expireConfirmations,
  setConfirmationSlackRef, findConfirmationBySlackRef,
  consumeConfirmation, markConfirmationConsumed,
  type Confirmation,
} from "./confirmations.js";
export { appendAudit, type AuditEntry } from "./audit.js";
export { setTaskState, getTaskState } from "./task-state.js";
export { makeBrainDeps, type BrainDeps } from "./brain-source.js";
export { withNoteLock } from "./note-lock.js";
export { makeNetworkQuery } from "./network-source.js";
export {
  enqueueDigestRequest, claimDigestRequests,
  recordDigestSkip, listSkippedPaths,
  type DigestRequest,
} from "./digest-store.js";
export {
  createJob, getJob, dueJobs, claimJob, heartbeatJob, reclaimStalledJobs,
  advanceJob, waitJob, waitForEventJob, findJobWaitingOnEvent, resumeByEvent, completeJob, failJob,
  startWorkflowForEvent,
  type Queryable, type WorkflowJob, type NewWorkflowJob, type WorkflowStatus, type EventWorkflowStart,
} from "./workflow-jobs.js";
export { getEmailWatchCursor, advanceEmailWatchCursor } from "./email-watch-cursors.js";
export { encryptSecret, decryptSecret, keyFromEnv } from "./crypto.js";
export { storeToken, getDecryptedRefreshToken, listDecryptedRefreshTokens, listTokens, deleteToken, type StoredOAuthToken } from "./oauth-tokens.js";
// The notion-sync proposal queue (spec §20.1): shared here so the console card and
// Saga's `notion` hand resolve proposals through one implementation, not two copies.
export {
  insertProposal, getOpenProposals, setProposalState, getRejectedUnexecuted,
  markProposalReverted, getRecentlyClosedProposals, resolveProposal,
  getUnannouncedProposals, markProposalAnnounced, getStaleProposals,
  rejectOutcome, rejectConsequence, approveConsequence,
  type ProposalState, type ProposalInput, type ProposalRow, type ProposalAction,
  type StaleProposalRow, type ProposalKind, type RejectOutcome,
} from "./notion-proposals.js";
// The Atlas sync job's proposal queue: shared here so the job's CLI and Saga's
// Telegram decision button resolve a proposal through one implementation, not two.
export {
  insertAtlasProposal, getOpenAtlasProposals, getAtlasProposalsAwaitingApply,
  completeAtlasProposal, supersedeAtlasProposal, resolveAtlasProposal,
  getUnannouncedAtlasProposals, markAtlasProposalAnnounced,
  atlasApproveConsequence, atlasRejectConsequence,
  upsertAtlasNote, getAtlasNotes, recordAtlasSourcesAccounted, setAtlasNoteState,
  type AtlasProposalState, type AtlasProposalInput, type AtlasProposalRow, type AtlasProposalAction,
  type AtlasEngineState, type AtlasDecidedState, type AtlasAwaitingApplyRow,
  type AtlasNoteState, type AtlasNoteRow,
} from "./atlas-proposals.js";
