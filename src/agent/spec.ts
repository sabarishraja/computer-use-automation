import { z } from 'zod';
import { BusinessOutcome, CapabilityPolicy, InputParam, OutputField, RecoveryRule, SurfaceBinding } from '../artifact/schema.js';

/**
 * ============================================================================
 * Capability spec — the authored half of discovery
 * ============================================================================
 *
 * A deliberate split, and one of the load-bearing decisions in this project:
 *
 *   A HUMAN AUTHORS THE CONTRACT. The model discovers the path.
 *
 * The contract — id, description, typed inputs and outputs, which business
 * outcomes exist, the allowlist, the app's known interruptions — is written by
 * the engineer who wants the capability. The model's job is the part a human
 * cannot do cheaply: work out which controls on a hostile screen realise that
 * contract.
 *
 * Doing it the other way round, where the model invents the schema too, gives
 * you `member_id_input_field` as an output name, sensitivity classifications
 * that drift per run, and a contract that changes shape every time you
 * re-record. The calling agent's interface must be stable across re-recordings
 * of the same capability; the steps are free to change.
 *
 * `appProfile` is the second piece of authored input: allowlist, global
 * recovery rules and viewport are properties of the *application*, not of any
 * one capability, so they are written once per vendor product and reused by
 * every capability recorded against it.
 */

export const OutcomeSpec = BusinessOutcome.omit({ when: true }).extend({
  /**
   * Inputs that provoke this outcome. Discovery phase 2 uses them to make the
   * application actually produce the state, so its detector condition is
   * observed rather than guessed.
   */
  probeInputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpec>;

export const AppProfile = z.object({
  /** Vendor product identity. The key for cross-tenant reuse. */
  application: SurfaceBinding.shape.application,
  surfaceKind: SurfaceBinding.shape.kind.default('web'),
  viewport: SurfaceBinding.shape.viewport,
  policy: CapabilityPolicy,
  /**
   * Interruptions that any capability on this app can meet: a maintenance
   * notice, a disclosure gate, an expired session. Written once per app.
   */
  globalRecovery: z.array(RecoveryRule).default([]),
});
export type AppProfile = z.infer<typeof AppProfile>;

export const CapabilitySpec = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  description: z.string(),
  /** The natural-language goal handed to the model. */
  goal: z.string(),
  /** Entry point template; `{{env.baseUrl}}` is substituted at run time. */
  entry: z.string(),
  inputs: z.array(InputParam).default([]),
  outputs: z.array(OutputField).default([]),
  outcomes: z.array(OutcomeSpec).default([]),
  app: AppProfile,
  /** Concrete values used for the discovery run. Never persisted. */
  discoveryInputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * Credentials the flow needs, referenced by name. The values come from the
   * environment at run time and are registered as secrets, so they are typed
   * into the application but never reach the artifact, the log or the model.
   */
  credentials: z.array(z.object({ envKey: z.string(), label: z.string() })).default([]),
  maxSteps: z.number().int().min(1).max(60).default(30),
});
export type CapabilitySpec = z.infer<typeof CapabilitySpec>;
