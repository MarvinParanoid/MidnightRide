export const DS = 5;                 // metres between centreline samples
export const N = 24;                 // samples per chunk
export const CHUNK_LEN = DS * N;     // 120 m of road per chunk
export const ROAD_HALF = 6.5;        // carriageway half-width
export const SHOULDER = 1.7;
export const AHEAD = 7;              // chunks kept in front of the rider
export const BEHIND = 2;
export const VIEW_DIST = AHEAD * CHUNK_LEN;

export const BIOME = {
  CITY: 'CITY',
  TUNNEL: 'TUNNEL',
  HIGHWAY: 'HIGHWAY',
  GAS: 'GAS STATION',
  FOREST: 'FOREST',
  BRIDGE: 'BRIDGE',
};
