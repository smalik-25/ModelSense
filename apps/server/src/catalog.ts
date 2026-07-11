import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CatalogEntry } from '@modelsense/shared';

interface ManifestEntry extends CatalogEntry {
  /** Absolute path to the .glb on disk (source: 'local'). */
  location: string;
}

const modelsDir = fileURLToPath(new URL('../../../assets/models/', import.meta.url));

const MANIFEST: ManifestEntry[] = [
  {
    model_id: 'DamagedHelmet',
    name: 'Damaged Helmet',
    description: 'Khronos hero PBR model. Single textured mesh, good for material and stats questions.',
    category: 'hero',
    source: 'local',
    location: `${modelsDir}DamagedHelmet.glb`,
  },
  {
    model_id: 'CesiumMilkTruck',
    name: 'Cesium Milk Truck',
    description: 'Vehicle with separately named wheel nodes. Good for find/highlight and multi-step tasks.',
    category: 'vehicle',
    source: 'local',
    location: `${modelsDir}CesiumMilkTruck.glb`,
  },
  {
    model_id: 'Box',
    name: 'Box',
    description: 'Minimal single-mesh box. Fast fixture for trivial checks.',
    category: 'scene',
    source: 'local',
    location: `${modelsDir}Box.glb`,
  },
];

const stripLocation = ({ location: _location, ...entry }: ManifestEntry): CatalogEntry => entry;

/** Catalog entries whose backing file is present on disk. */
export function availableModels(): CatalogEntry[] {
  return MANIFEST.filter((m) => m.source !== 'local' || existsSync(m.location)).map(stripLocation);
}

export function resolveModel(model_id: string): ManifestEntry | undefined {
  return MANIFEST.find((m) => m.model_id === model_id);
}

const ALLOWED_URL_HOSTS = new Set(['raw.githubusercontent.com']);

/** Only Khronos glTF-Sample-Assets .glb URLs are permitted. No arbitrary fetching. */
export function isAllowedModelUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === 'https:' &&
      ALLOWED_URL_HOSTS.has(url.hostname) &&
      // Anchor to the start of the path: on raw.githubusercontent.com the path is
      // /<owner>/<repo>/<ref>/..., so a substring match would let any repo whose
      // path merely contains this segment (e.g. /attacker/repo/main/KhronosGroup/
      // glTF-Sample-Assets/x.glb) serve an arbitrary .glb.
      url.pathname.startsWith('/KhronosGroup/glTF-Sample-Assets/') &&
      url.pathname.endsWith('.glb')
    );
  } catch {
    return false;
  }
}
