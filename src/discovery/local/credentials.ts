/** Null when the environment can reach a model, else what to set. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.ANTHROPIC_API_KEY) return null;
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK;
  if (bedrock === '1' || bedrock === 'true') return null;
  return 'no model credentials: set ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials';
}
