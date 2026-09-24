-- Manual installation migration. No transcripts; current incarnation-scoped UI projection.
CREATE TABLE agent_conversations (
  agent text NOT NULL,
  incarnation uuid NOT NULL,
  session_id text NOT NULL,
  door text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  terminal boolean NOT NULL DEFAULT false,
  PRIMARY KEY(agent, incarnation, session_id)
);
CREATE INDEX agent_conversations_recent ON agent_conversations(agent, incarnation, observed_at DESC);
