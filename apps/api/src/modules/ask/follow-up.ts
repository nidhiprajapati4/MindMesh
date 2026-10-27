const FOLLOW_UP = /^(and|but|also|so|then|what about|how about|why( not)?|more|same)\b|\b(it|its|it's|that|this|these|those|they|them|their|there|he|she|him|her|the same|one)\b/i;

/**
 * Whether a question leans on the conversation so far ("and how much does it cost?") rather
 * than standing on its own. English phrasing only; other languages are searched as written.
 */
export const looksLikeFollowUp = (question: string) => question.trim().split(/\s+/).length <= 12 && FOLLOW_UP.test(question.trim());
