export interface WebModel {
  id: string;
  name: string;
  /** Served same-origin from public/models (copied from assets/models at build). */
  url: string;
  /** A canned highlight the dev panel can trigger, when node names are known. */
  sampleHighlight?: { label: string; nodeIds: string[] };
}

// Phase 1: the viewer has its own static catalog. In Phase 2 the model set and
// highlight commands arrive from the agent via MCP tool results.
export const WEB_CATALOG: WebModel[] = [
  {
    id: 'CesiumMilkTruck',
    name: 'Cesium Milk Truck',
    url: '/models/CesiumMilkTruck.glb',
    sampleHighlight: { label: 'Highlight the wheels', nodeIds: ['Wheels', 'Wheels.001'] },
  },
  {
    id: 'DamagedHelmet',
    name: 'Damaged Helmet',
    url: '/models/DamagedHelmet.glb',
  },
  {
    id: 'Box',
    name: 'Box',
    url: '/models/Box.glb',
  },
];
