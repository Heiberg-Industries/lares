/** The only two sentences a spending-limit refusal may carry. No imports on purpose: the console's browser code reads them too. */
const LIMIT_DATE='[1-9][0-9]? (?:January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}';
export const MEMBER_LIMIT_SENTENCE=new RegExp(`^You've reached your monthly limit of \\$[0-9]{1,18}(?:\\.[0-9]{2,18})?\\. It resets on ${LIMIT_DATE}\\.$`);
export const INSTALLATION_LIMIT_SENTENCE=new RegExp(`^This installation has reached its monthly spending limit\\. It resets on ${LIMIT_DATE}\\.$`);
