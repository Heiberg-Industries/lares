// The origin vocabulary lives in @lares/vault-format so the sync jobs can share it without
// pulling in agent-kit's dependency graph. This file exists so @lares/agent-kit/origin keeps working.
export * from "@lares/vault-format/origin";
