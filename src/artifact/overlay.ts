import type { Capability, TenantOverlay, Step, Locator, BusinessOutcome, RecoveryRule } from './schema.js';
import { localiseCondition, localiseLocator } from './terms.js';

/**
 * Resolve a base capability against one tenant's overlay.
 *
 * The result is an ordinary Capability, so the replay engine has no idea tenants
 * exist. That is the point: multi-tenancy is a *resolution-time* concern, not a
 * runtime one, and nothing downstream needs per-tenant branching.
 *
 * The merge is deliberately additive and narrow:
 *   - entry URL and allowed origins are replaced/extended,
 *   - a tenant may declare a VOCABULARY, which widens every locator and every
 *     condition to accept its wording as well as the base wording,
 *   - a tenant may PREPEND locator strategies for a step (its own handle is
 *     tried first, the base strategies remain as fallback),
 *   - a tenant may ADD recovery rules and business outcomes.
 * A tenant may not remove, reorder or retype steps. If it needs that, it needs
 * its own capability, and forcing that to be explicit is how we keep "reused
 * across 300 institutions" from quietly meaning "300 divergent forks".
 */
export function resolveForTenant(base: Capability, tenantId: string | undefined): Capability {
  if (!tenantId) return base;
  const overlay = base.tenantOverlays.find((o) => o.tenantId === tenantId);
  if (!overlay) {
    throw new Error(
      `capability ${base.id}@${base.version} has no overlay for tenant "${tenantId}" ` +
        `(known: ${base.tenantOverlays.map((o) => o.tenantId).join(', ') || 'none'})`,
    );
  }
  return applyOverlay(base, overlay);
}

export function applyOverlay(base: Capability, overlay: TenantOverlay): Capability {
  const terms = overlay.terms ?? {};
  const entry = overlay.entry ?? base.surface.entry;
  // Re-pointing `surface.entry` alone is not enough: the engine drives the run
  // from the steps, and the recorded entry navigate carries the BASE tenant's
  // URL. Left unrewritten, a tenant run silently drives the tenant it was
  // recorded against and reports another institution's data as success.
  const retarget = (url: string): string => (url === base.surface.entry ? entry : url);

  const steps: Step[] = base.steps.map((step) => {
    let action = step.action;

    if (action.type === 'navigate') {
      action = { ...action, url: retarget(action.url) };
    }

    if ('target' in action && action.target) {
      let target = localiseLocator(action.target as Locator, terms);
      const ov = overlay.locatorOverrides[step.id];
      if (ov) target = prependStrategies(target, ov);
      action = { ...action, target } as Step['action'];
    }

    return {
      ...step,
      action,
      precondition: step.precondition ? localiseCondition(step.precondition, terms) : undefined,
      checkpoint: step.checkpoint ? localiseCondition(step.checkpoint, terms) : undefined,
      recovery: step.recovery.map((r) => localiseRecovery(r, terms)),
    };
  });

  const outcomes: BusinessOutcome[] = [
    ...base.outcomes.map((o) => ({ ...o, when: localiseCondition(o.when, terms) })),
    ...overlay.extraOutcomes,
  ];

  return {
    ...base,
    surface: { ...base.surface, entry },
    steps,
    outcomes,
    successCondition: localiseCondition(base.successCondition, terms),
    globalRecovery: [...overlay.extraRecovery, ...base.globalRecovery.map((r) => localiseRecovery(r, terms))],
    policy: {
      ...base.policy,
      // An overlay that moves the entry REPLACES the origin allowlist rather
      // than widening it. Unioning is what made navigating to the recorded
      // tenant legal from inside a run asked for a different one.
      allowedOrigins:
        overlay.entry && overlay.allowedOrigins.length > 0
          ? dedupe(overlay.allowedOrigins)
          : dedupe([...base.policy.allowedOrigins, ...overlay.allowedOrigins]),
    },
  };
}

function localiseRecovery(rule: RecoveryRule, terms: Record<string, string>): RecoveryRule {
  return {
    ...rule,
    when: localiseCondition(rule.when, terms),
    do: rule.do.map((a) => ('target' in a && a.target ? ({ ...a, target: localiseLocator(a.target as Locator, terms) } as typeof a) : a)),
  };
}

function prependStrategies(
  loc: Locator,
  ov: { description?: string; framePath?: string[]; prependStrategies: Locator['strategies'] },
): Locator {
  return {
    description: ov.description ?? loc.description,
    framePath: ov.framePath ?? loc.framePath,
    strategies: [...ov.prependStrategies, ...loc.strategies],
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Drift signal for cross-tenant reuse.
 *
 * Replay records which locator strategy actually resolved each target. If a
 * tenant consistently falls through to a lower tier than the base recording
 * did, that tenant has drifted and its overlay needs a strategy — long before
 * the capability actually breaks. This turns drift from an outage into a
 * backlog item, without building any drift infrastructure: the data is a
 * by-product of normal replay.
 */
export type DriftObservation = {
  stepId: string;
  target: string;
  recordedTier: string;
  resolvedTier: string;
  resolvedStrategyIndex: number;
  degraded: boolean;
};

export function observeDrift(cap: Capability, resolutions: Array<{ stepId: string; target: string; strategyIndex: number; tier: string }>): DriftObservation[] {
  const byStep = new Map(cap.steps.map((s) => [s.id, s]));
  const out: DriftObservation[] = [];
  for (const r of resolutions) {
    const step = byStep.get(r.stepId);
    if (!step || !('target' in step.action) || !step.action.target) continue;
    const recorded = (step.action.target as Locator).strategies[0];
    if (!recorded) continue;
    out.push({
      stepId: r.stepId,
      target: r.target,
      recordedTier: recorded.tier,
      resolvedTier: r.tier,
      resolvedStrategyIndex: r.strategyIndex,
      degraded: r.strategyIndex > 0,
    });
  }
  return out;
}
