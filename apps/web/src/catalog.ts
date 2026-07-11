export interface WebModel {
  id: string;
  name: string;
  /** Served same-origin from public/models (copied from assets/models at build). */
  url: string;
}

// The viewer keeps its own small static catalog of the models it serves locally.
// Highlight/camera/measure commands arrive from the agent via MCP tool results.
export const WEB_CATALOG: WebModel[] = [
  {
    id: 'CesiumMilkTruck',
    name: 'Cesium Milk Truck',
    url: '/models/CesiumMilkTruck.glb',
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
