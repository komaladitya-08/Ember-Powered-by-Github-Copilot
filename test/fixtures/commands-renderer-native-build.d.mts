/** Required native Windows CI only; portable/default imports never invoke a renderer or application build. */
export function stageCommandsRenderer(input: { repository: string; stage: string; tap: Buffer }): Promise<{ app: string; assetsVerified: true; rendererSources: 8 | 9 }>;
