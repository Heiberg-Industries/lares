// `@lares/agent-kit/learning` — what an agent may learn without the owner in the room.
//
// One subpath, so a role service imports the RULE and never a sibling service's file. Today it
// holds the promotion gate (ADR-0018 rules 2 and 4); the do-not-learn list and the proposal
// lane plug into it through `makeLearningPromoter`'s injected callbacks.
//
// Nothing here may import a role service, a database driver or anything eve-specific: the
// packages that test the rule without a model (`packages/memory-evals`) depend on this kit and
// on nothing else.
export {
  makeLearningPromoter,
  PROMOTE_MIN_OWNER_RECURRENCE,
  type LearnableObservation,
  type LearningStore,
  type PromoterResult,
  type Rejection,
  type RejectionReason,
} from "./promote.js";
