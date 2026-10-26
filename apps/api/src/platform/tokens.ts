/** Rough token count (~4 characters per token for English); used for chunk sizes, budgets and cost estimates. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
