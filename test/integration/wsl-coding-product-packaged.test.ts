/** One separate required shipped-Home WSL proof. Default registration/skipping is never positive acceptance evidence. */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { wslProductPreflight, wslProductRefusal, wslProductScratchParent } from "../fixtures/wsl-coding-product-preflight";
import { wslProductTitle } from "../fixtures/wsl-coding-product-contract";
import { createWslProductModel, wslProductScenarios } from "../fixtures/wsl-coding-product-model";
import { WslPackagedJourney, type WslPackagedModel } from "../fixtures/wsl-coding-packaged-product";

const required = process.env.EMBER_PACKAGED_WSL_CODING_PRODUCT_TEST === "1";
let quarantined = false;
interface Owner { root?: string; model?: WslPackagedModel; journey?: WslPackagedJourney }
const retained = new Set<Owner>();
it.skipIf(!required)(wslProductTitle("packaged", "normal-wsl-home"), async () => {
  if (quarantined) throw wslProductRefusal(1); quarantined = true;
  const owner: Owner = {}; retained.add(owner);
  let root: string | undefined, model: WslPackagedModel | undefined, journey: WslPackagedJourney | undefined, failed = false, phase = 1;
  try {
    const admitted = wslProductPreflight(required);
    root = fs.mkdtempSync(path.join(wslProductScratchParent(), "ember-packaged-wsl-product-")); owner.root = root;
    root = fs.realpathSync.native(root); owner.root = root;
    model = await createWslProductModel([...wslProductScenarios("repair"), ...wslProductScenarios("public-repair"), ...wslProductScenarios("public-denied")], admitted.targetLabel);
    owner.model = model; journey = new WslPackagedJourney(root, model, admitted.distro, admitted.targetLabel); owner.journey = journey;
    await journey.start(); await journey.offline(); await journey.public(); await journey.denyPublic(); await journey.finish();
  } catch (error) { journey?.capture(error); failed = true; phase = journey?.phase ?? phase; }
  finally {
    let clean = false; try { clean = !!journey && await journey.close(); } catch (error) { journey?.capture(error); failed = true; phase = 40; }
    try { await model?.close(); } catch { failed = true; phase = 40; }
    if (!failed && clean && root) { try { fs.rmSync(root, { recursive: true, force: false }); } catch { failed = true; phase = 40; } }
    else if (root) failed = true;
  }
  if (failed) { const observation = journey?.observation(); if (observation) console.info("Windows WSL packaged cached observation", JSON.stringify(observation)); throw wslProductRefusal(phase); }
  retained.delete(owner); quarantined = false; console.info("Windows WSL packaged journey passed", JSON.stringify({ schema: 1, phase: 11 }));
}, 360_000);
