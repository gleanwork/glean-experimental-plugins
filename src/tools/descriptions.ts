/**
 * Shared input-schema descriptions for parameters that recur across our
 * static tools and the dynamically-promoted remote tools (chat, search,
 * read_document). Keeping a single source of truth keeps the agent-facing
 * wording consistent and prevents drift when the paste-back semantics evolve.
 */

export const CALLBACK_URL_DESCRIPTION =
  "Optional OAuth callback URL pasted by the user after sign-in. Only set " +
  "this when a previous call returned [AUTHENTICATION_REQUIRED] AND the user " +
  "has since pasted a URL they copied from the Glean sign-in success page " +
  "(the URL will contain a `code` query parameter). The server will extract " +
  "the code, finish OAuth, and then run the original request.";
