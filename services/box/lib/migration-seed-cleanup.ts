// Pre-publication exception: remove an installation-specific identity/organisation seed from fresh
// schemas. This is NOT a comment-only or semantically equivalent SQL replacement.
// An exact known historical ledger is skipped, never replayed or rewritten: its
// identities and domains remain installation data. Unknown hashes still refuse. Do not add broad
// checksum normalization, transitive matching, or automatic ledger adoption here.
export const DOMAIN_SEED_CLEANUP = {
  "filename": "032_org_domains.sql",
  "before": [
    "e0044b2954ac804e1e8839224cfc7b8e944fb678490bd1a53f717737b4d173a7",
    "ed04d284518898576d35e2cf5e13b33d903a1bca5549efac0bc5b3d01ada7d09"
  ],
  "after": "2c92d29a9afa5eb3d0e60c207b3b02bee8d1c1bf0e8e72222058727da0b140bd"
} as const;

export const IDENTITY_SEED_CLEANUP = [
  {
    "filename": "014_identity.sql",
    "before": [
      "9e080231f5a4fdd9d67a01ee294c6e4cf47c4f460124070fca2a77e30d9aea1a"
    ],
    "after": "1dcc059ce5d9211d26203126e94a537ac019d2e9bdfe18bc78fec88f9fc774d6"
  },
  {
    "filename": "028_orgs.sql",
    "before": [
      "c2c59a4359807157169cd4f277660642e7fbd7ef3bae876c7f67f86e33c53514"
    ],
    "after": "d59c8639020730e11a73ebd53649c735b0ae06b537d42b4ac416ec118892c6e9"
  },
  {
    "filename": "029_cross_member.sql",
    "before": [
      "353795db991aea8554f3b8ea544dfffa7814a78e91f4d4ca1e59483ae8bd8625"
    ],
    "after": "ee4a8be51aa9647a4fab7f54fd94d4c0ecfc4a9fe1ae2b7d248d3c1b65590614"
  }
] as const;
export const OWNER_DEFAULT_CLEANUP = [
  {
    "path": "services/box/sql/036_deadlines.sql",
    "filename": "036_deadlines.sql",
    "before": [
      "774a1bb899aa4326d41a6281de21b1155083078fa2180df9867c2e9ba6e618e8"
    ],
    "after": "aa3465984dadc542da7e3962c9bfa66d1533e4736fb5f3d2a2a08080d3fa1585"
  },
  {
    "path": "services/box/sql/001_init.sql",
    "filename": "001_init.sql",
    "before": [
      "9939aa0969bc0c90490f15712c46dd96a74ef5598b4528f2db05f8734ecd4848"
    ],
    "after": "af7f54f76ffe3f7ff58dcdfa2a6d972454540ce1b8ce7b832d84b0f06b370e58"
  },
  {
    "path": "services/box/sql/027_meeting_followup.sql",
    "filename": "027_meeting_followup.sql",
    "before": [
      "e8a1f9ff3726ebf8915419249112d09bb1488244e8706339cc4662cfad78090e"
    ],
    "after": "ccbd3423178f175a1575a73c114621f713d6c2cf43cda05488a4ede210fa5e5f"
  },
  {
    "path": "services/box/sql/022_email_triage.sql",
    "filename": "022_email_triage.sql",
    "before": [
      "095bbed6a2695044cae5bbfc1cd61277960695073f4d088bf7ff25afae9b82a4"
    ],
    "after": "a396b67bfc93b9ba10e0c7c177d23778655e27146822e0901088943ad07f6cf2"
  },
  {
    "path": "services/box/sql/023_schema_principal_scoping.sql",
    "filename": "023_schema_principal_scoping.sql",
    "before": [
      "57efc647550344facaf68a88eae8ee89b9e7855fab04862bfe4495d88ae581ce"
    ],
    "after": "221a45a41a0c9b95749ba531a35ee9688e29db3ba9092c1d54887728c735f8ac"
  },
  {
    "path": "services/chief-of-staff/sql/003-facts-owner.sql",
    "filename": "003-facts-owner.sql",
    "before": [
      "4574e8c5a05874ad67d5432d8e8945cfeb1bc13b64834e3db9990fe5c324523d"
    ],
    "after": "820c920fa40902fc055f0cf8871a53e58502e186b17614162f9f14be37ea7aba"
  }
] as const;
export const SEED_CLEANUP_MIGRATIONS = [DOMAIN_SEED_CLEANUP, ...IDENTITY_SEED_CLEANUP, ...OWNER_DEFAULT_CLEANUP] as const;

export function isRetiredInstallationSeed(filename: string, before: string, after: string): boolean {
  return SEED_CLEANUP_MIGRATIONS.some(row => filename === row.filename
    && after === row.after && row.before.some(hash => hash === before));
}
