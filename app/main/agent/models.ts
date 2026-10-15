/**
 * Picks models from client.listModels(): a fast one for the conductor (it
 * answers every utterance) and a vision-capable one for workers (images are
 * silently dropped for models without vision).
 */

export interface ModelLike {
  id: string;
  name?: string;
  capabilities?: { supports?: { vision?: boolean } };
  policy?: { state?: string };
}

export interface ModelChoice { conductor: string | null; worker: string | null }

/** Small, quick models by name: whole words only ("gemini" is not "mini"). */
const FAST = [/(^|[-_. ])(mini|haiku|flash|nano|small|fast|lite)($|[-_. ])/i];

const enabled = (m: ModelLike) => !m.policy?.state || m.policy.state === "enabled";
export const supportsVision = (m: ModelLike) => m.capabilities?.supports?.vision === true;

export function chooseModels(models: ModelLike[], prefer: { conductor?: string; worker?: string } = {}): ModelChoice {
  const usable = models.filter(enabled);
  const byId = new Map(usable.map(m => [m.id, m]));

  let conductor = prefer.conductor && byId.has(prefer.conductor) ? prefer.conductor : null;
  if (!conductor) conductor = (usable.find(m => FAST.some(r => r.test(m.id))) ?? usable[0])?.id ?? null;

  const preferredWorker = prefer.worker ? byId.get(prefer.worker) : undefined;
  let worker = preferredWorker && supportsVision(preferredWorker) ? preferredWorker.id : null;
  if (!worker) {
    const vision = usable.filter(supportsVision);
    worker = (vision.find(m => !FAST.some(r => r.test(m.id))) ?? vision[0])?.id ?? null;
  }
  return { conductor, worker };
}
