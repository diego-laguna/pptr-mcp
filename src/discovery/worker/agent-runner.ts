import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  DiscoveryFailureReason,
  DiscoveryMessage,
  Usage,
} from '../api/types.js';
import { buildAgentOptions } from './agent-options.js';
import { DiscoverySession } from './agent-session.js';

export type QueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<Record<string, any>>;

export interface AgentOutcome {
  usage: Usage;
  capHit: 'turns' | 'cost' | 'duration' | null;
  finalText: string;
  error?: string;
}

export interface AgentRunInput {
  message: DiscoveryMessage;
  session: DiscoverySession;
  abortController: AbortController;
  queryFn?: QueryFn;
  model?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Drives the model within the attempt's caps: the SDK enforces turns and cost,
 * a wall-clock watchdog enforces duration. Usage is read from the SDK's result
 * (it reports total_cost_usd) and survives a cap being hit.
 */
export async function runAgent(input: AgentRunInput): Promise<AgentOutcome> {
  const { message, session } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const queryFn = input.queryFn ?? (query as unknown as QueryFn);
  let capHit: AgentOutcome['capHit'] = null;
  let finalText = '';
  let turns = 0;
  let usage: Usage | null = null;
  let error: string | undefined;

  const watchdog = setTimeout(() => {
    capHit ??= 'duration';
    input.abortController.abort();
  }, message.caps.maxDurationMs);

  try {
    const options = buildAgentOptions({
      message,
      session,
      abortController: input.abortController,
      model: input.model,
      env: input.env,
    });
    for await (const m of queryFn({
      prompt: `Discover the product catalog of ${message.siteUrl} and submit a selector spec.`,
      options,
    })) {
      if (m.type === 'assistant') {
        turns++;
        const blocks = (m.message?.content ?? []) as {
          type: string;
          text?: string;
        }[];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n');
        if (text) finalText = text;
      } else if (m.type === 'result') {
        usage = {
          turns: m.num_turns ?? turns,
          durationMs: m.duration_ms ?? now() - startedAt,
          costUsd: m.total_cost_usd,
          inputTokens: m.usage?.input_tokens,
          outputTokens: m.usage?.output_tokens,
        };
        if (m.subtype === 'error_max_turns') capHit ??= 'turns';
        else if (m.subtype === 'error_max_budget_usd') capHit ??= 'cost';
        else if (m.is_error) error = String(m.subtype);
        if (typeof m.result === 'string' && m.result) finalText = m.result;
      }
    }
  } catch (e) {
    // An abort is how the session ends itself once a candidate is accepted or the rounds run out.
    if (!input.abortController.signal.aborted) error = (e as Error).message;
  } finally {
    clearTimeout(watchdog);
  }

  return {
    usage: usage ?? { turns, durationMs: now() - startedAt },
    capHit,
    finalText,
    ...(error ? { error } : {}),
  };
}

/** Why an attempt produced no candidate, from what the session and run observed. */
export function reasonForNoCandidate(
  session: DiscoverySession,
  outcome: AgentOutcome,
): { reason: DiscoveryFailureReason; detail: string } {
  if (session.exhausted)
    return {
      reason: 'verification_failed',
      detail:
        session.lastFailureDetail ?? 'the candidate did not pass verification',
    };
  if (outcome.capHit)
    return {
      reason: 'cap_exceeded',
      detail: `the attempt reached its ${outcome.capHit} cap`,
    };
  if (outcome.error) return { reason: 'error', detail: outcome.error };
  if (/^\s*NO_CATALOG\b/m.test(outcome.finalText))
    return {
      reason: 'no_catalog_found',
      detail: outcome.finalText.slice(0, 300),
    };
  if (session.successfulNavigations === 0 && session.blockedStatuses.length > 0)
    return {
      reason: 'blocked_by_site',
      detail: `the site answered HTTP ${session.blockedStatuses.join(', ')}`,
    };
  if (
    session.successfulNavigations === 0 &&
    session.navigationErrors.length > 0
  )
    return {
      reason: 'unreachable_site',
      detail: session.navigationErrors[0].slice(0, 200),
    };
  return {
    reason: 'invalid_output',
    detail: 'the agent finished without submitting a valid spec',
  };
}
