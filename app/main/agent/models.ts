/**
 * Picks models from client.listModels(): a fast one for the conductor (it
 * answers every utterance) and a vision-capable one for workers (images are
 * silently dropped for models without vision). Without any vision model,
 * workers use the chosen or conductor model and read the screen as text.
 * Copilot lists models in its own order, so cost counts too: a model whose
 * billing multiplier is above 1 (several premium requests a call) is picked
 * only when no standard one fits, and the conductor skips models tuned for
 * code and slow reasoning ones. The user's own choice always wins.
 */

export interface ModelLike {
  id: string;
  name?: string;
  capabilities?: { supports?: { vision?: boolean } };
  policy?: { state?: string };
  /** Copilot's billing: the premium-request multiplier (0 included, 1 standard, more costs more). */
  billing?: { multiplier?: number };
}

/** A model's cost against the user's premium requests: its multiplier, or 1 (standard) when Copilot doesn't say. */
export const costOf = (m: ModelLike): number => {
  const x = m.billing?.multiplier;
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 1;
};

export interface ModelChoice { conductor: string | null; worker: string | null }

/** Small, quick models by name: whole words only ("gemini" is not "mini"). */
const FAST = [/(^|[-_. ])(mini|haiku|flash|nano|small|fast|lite)($|[-_. ])/i];

/** Names that mark a model tuned for code, or a slow reasoning one ("o" and a digit): not the conversation's default. */
const NOT_CHAT = [/(^|[-_. ])(code|codex|coder)($|[-_. ])/i, /^o\d/i];

const enabled = (m: ModelLike) => !m.policy?.state || m.policy.state === "enabled";
export const supportsVision = (m: ModelLike) => m.capabilities?.supports?.vision === true;
const fast = (m: ModelLike) => FAST.some(r => r.test(m.id));
const chat = (m: ModelLike) => !NOT_CHAT.some(r => r.test(m.id));
const standard = (m: ModelLike) => costOf(m) <= 1;
/** The model that costs least (the first of those that cost the same); undefined for none. */
const cheapest = (list: ModelLike[]) => list.reduce<ModelLike | undefined>((a, b) => (a && costOf(a) <= costOf(b) ? a : b), undefined);

export function chooseModels(models: ModelLike[], prefer: { conductor?: string; worker?: string } = {}): ModelChoice {
  const usable = models.filter(enabled);
  const byId = new Map(usable.map(m => [m.id, m]));

  let conductor = prefer.conductor && byId.has(prefer.conductor) ? prefer.conductor : null;
  // Small, standard and made for conversation first; then a standard general model rather than a code-tuned small one.
  // Premium ones only when nothing standard is listed, the cheapest first.
  if (!conductor) {
    conductor = (usable.find(m => fast(m) && chat(m) && standard(m)) ?? usable.find(m => chat(m) && standard(m)) ?? usable.find(m => fast(m) && standard(m))
      ?? usable.find(standard) ?? cheapest(usable.filter(m => fast(m) && chat(m))) ?? cheapest(usable))?.id ?? null;
  }

  const preferredWorker = prefer.worker ? byId.get(prefer.worker) : undefined;
  let worker = preferredWorker && supportsVision(preferredWorker) ? preferredWorker.id : null;
  if (!worker) {
    // A strong (not small) standard vision model; a premium one only when no standard one has vision, the cheapest first.
    const vision = usable.filter(supportsVision);
    worker = (vision.find(m => !fast(m) && standard(m)) ?? vision.find(standard) ?? cheapest(vision.filter(m => !fast(m))) ?? cheapest(vision))?.id ?? null;
  }
  // No model with vision: tasks still get an allowed model (never the runtime's default) and work from text only.
  if (!worker) worker = preferredWorker?.id ?? conductor;
  return { conductor, worker };
}

/**
 * May sessions be left to the runtime's own default model? Only when Copilot listed no models at all (Copilot Free
 * lists none, yet answers on its default) and nothing decides which models may be used: no administrator's allowed
 * list or pinned model (the default may be one they didn't allow), and no custom endpoint (it serves only its own).
 */
export function mayUseRuntimeDefault(listed: number, rules: { provider?: boolean; allowed?: readonly string[]; conductor?: string; worker?: string }): boolean {
  return listed === 0 && !rules.provider && !rules.allowed && !rules.conductor && !rules.worker;
}
