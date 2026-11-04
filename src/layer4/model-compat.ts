/** Provider-specific transport defaults. Explicit user compat values win. */
export function modelCompat(model: {
  baseUrl: string;
  compat?: Record<string, unknown>;
}) {
  let deepseek = false;
  try {
    deepseek = new URL(model.baseUrl).hostname === "api.deepseek.com";
  } catch {
    /* Config validation reports malformed URLs. */
  }
  // DeepSeek Responses treats developer as user; keep our system prompt as system.
  // https://api-docs.deepseek.com/guides/responses_api/#input-items
  return {
    ...(deepseek
      ? { supportsDeveloperRole: false, supportsMidConvoSystemMessages: true }
      : {}),
    ...model.compat,
  };
}
