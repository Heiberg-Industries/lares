// Reviewed comment-only namespace edits. Exact hash pairs preserve existing ledgers.
// Never add a pair for changed SQL statements, and never normalize arbitrary SQL at runtime.
export const COMMENT_ONLY_MIGRATIONS = [
  {
    "path": "services/box/sql/017_notion_proposal_announced.sql",
    "filename": "017_notion_proposal_announced.sql",
    "before": "9ae6126e2af8726ed53bee518f3fae09f09425dc0b3b6293c2bc2cc5f594c36f",
    "after": "2ea8fb8d0f8327d15972fc80a4847e51dc79d21a2763810e9afe4aad0e6e625e"
  },
  {
    "path": "services/box/sql/033_voice_card_per_mailbox.sql",
    "filename": "033_voice_card_per_mailbox.sql",
    "before": "ef635eb2a8662a382117a2df1c4a5a25ac2ca4de704596177041f320e6a0d8d5",
    "after": "587184277a80a6403b858be84da3c1c5a021e16b6deb6460bd4e2f0e98c3d634"
  },
  {
    "path": "services/box/sql/034_email_triage_draft_id.sql",
    "filename": "034_email_triage_draft_id.sql",
    "before": "43f10760ca92466a5c7a11127cda5cc4bef6014db509aa638643f666ace78bd1",
    "after": "0e1604021e73878c76d8eab9493474b01a36ce71eb37c61e0a45a918b40ddea7"
  },
  {
    "path": "services/box/sql/035_proactivity.sql",
    "filename": "035_proactivity.sql",
    "before": "e6a605491f1af021aa5657497fdc144048c874260428955d11b79e6ea9d008a5",
    "after": "513c81b592cfc04d23aa1f1f8e903f886ae27b54c6c3abee3d35524bb3209359"
  },
  {
    "path": "services/box/sql/042_agent_resources.sql",
    "filename": "042_agent_resources.sql",
    "before": "94132c68f5f4990c59794312281971e57af8614da1b76a874b2e5fe72730a4b1",
    "after": "ca89d161d3291a25c9da4c3ac27b106f8b50d78219e1688833e0d933ed2e0950"
  },
  {
    "path": "services/box/sql/072_memory_proposals.sql",
    "filename": "072_memory_proposals.sql",
    "before": "fa1d23ea36270220da9e9f2ef34de381379f4c0eb3d15a5f0b8c7446fac33342",
    "after": "eee236e8ddf876a347373fff3767ec779554f2202397a7dec1d838be3db143d2"
  },
  {
    "path": "services/chief-of-staff/sql/002-standing-facts.sql",
    "filename": "002-standing-facts.sql",
    "before": "c468d5850909806480ff643a1d45c15f722633839f924ac2e8b49018f1c57922",
    "after": "0e2d80fe8702ca7a1219aa3553f7e4eda3bfc865bfb907f57344a3c807463b10"
  },
  {
    "path": "services/creative/sql/001-eve-workflow.sql",
    "filename": "001-eve-workflow.sql",
    "before": "156d1eb2853c9a0a5f6b4c23ea3533c3236cbeef9e8f2710ff0a3f202ae04b79",
    "after": "33626f1d64ea6bd9377ae135d780e559076dd28acb9cc24a5d091d843c0e2e51"
  },
  {
    "path": "services/box/sql/010_oauth_tokens_multi_account.sql",
    "filename": "010_oauth_tokens_multi_account.sql",
    "before": "890290781a606a0be4afa80b705e07efdc568727a95bf3b855dd225b3ea8b943",
    "after": "9155b361a51e774251108659a3697634ee8cd2b67585a473f0be807d408bb56f"
  },
  {
    "path": "services/box/sql/021_outreach_threads.sql",
    "filename": "021_outreach_threads.sql",
    "before": "565460aea101a41ec5ec612a76aa62c6eefae3f86024809f3020ae571b85ba2a",
    "after": "79ff3c95c54e8db3b3a9144a94c33ca784c488c3aeea1824c0925ea63081735c"
  },
  {
    "path": "services/box/sql/026_voice_per_mailbox.sql",
    "filename": "026_voice_per_mailbox.sql",
    "before": "8ca87e143ef9950a5cc0b8f10c74878e5faf94e693841bfe5f93e8d0a15f3a85",
    "after": "8d9a773bb63099ab0a24c88672b4efea2bfe97bb57f397a5674d7d52ff320bdd"
  },
  {
    "path": "services/box/sql/033_voice_card_per_mailbox.sql",
    "filename": "033_voice_card_per_mailbox.sql",
    "before": "ed59a6fc622d9b96cd847fb1dacd44eb61a62b6a422a01bfbfbee58d35a1d115",
    "after": "587184277a80a6403b858be84da3c1c5a021e16b6deb6460bd4e2f0e98c3d634"
  }
] as const;

export function isCommentOnlyMigration(filename: string, before: string, after: string): boolean {
  return COMMENT_ONLY_MIGRATIONS.some(row => row.filename === filename && row.before === before && row.after === after);
}
