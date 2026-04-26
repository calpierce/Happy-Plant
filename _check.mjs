import { computeGrid, computeWallGrids } from './src/simulation/lightSim.js';

function summary(label, grid) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of grid) { if (v<min) min=v; if (v>max) max=v; sum+=v; }
  console.log(`  ${label}: min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${(sum/grid.length).toFixed(3)}`);
}

function halfMeans(grid) {
  const gridSize = Math.sqrt(grid.length);
  let south = 0, north = 0, west = 0, east = 0;
  let southN = 0, northN = 0, westN = 0, eastN = 0;
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const v = grid[i * gridSize + j];
      if (j < gridSize / 2) { south += v; southN++; } else { north += v; northN++; }
      if (i < gridSize / 2) { west += v; westN++; } else { east += v; eastN++; }
    }
  }
  return {
    south: south / southN,
    north: north / northN,
    west: west / westN,
    east: east / eastN,
  };
}

console.log('--- Case 1: no windows, sun high (all walls near-zero) ---');
const g1 = computeWallGrids({ altitude: Math.PI/3, azimuth: 0, isAboveHorizon: true }, []);
for (const k of Object.keys(g1)) summary(k, g1[k]);
console.log('--- Case 2: south window, sun due south at 45° (expect N wall lit) ---');
const win = [{ id:'w1', kind:'wall', wall:'S', min:1, max:3, yMin:0.8, yMax:2.0 }];
const g2 = computeWallGrids({ altitude: Math.PI/4, azimuth: 0, isAboveHorizon: true }, win);
for (const k of Object.keys(g2)) summary(k, g2[k]);
console.log('--- Case 3: skylight, sun high (expect near-zero walls, non-zero ceiling ≈0) ---');
const sky = [{ id:'s1', kind:'skylight', xMin:1.5, xMax:2.5, zMin:1.5, zMax:2.5 }];
const g3 = computeWallGrids({ altitude: Math.PI/2 - 0.2, azimuth: 0, isAboveHorizon: true }, sky);
for (const k of Object.keys(g3)) summary(k, g3[k]);
console.log('--- Case 4: below horizon (all zero-ish, just night floor) ---');
const g4 = computeWallGrids({ altitude: -0.2, azimuth: 0, isAboveHorizon: false }, win);
for (const k of Object.keys(g4)) summary(k, g4[k]);
console.log('--- Case 5: east window, sun due east (expect W wall lit) ---');
const winE = [{ id:'w2', kind:'wall', wall:'E', min:1, max:3, yMin:0.8, yMax:2.0 }];
const g5 = computeWallGrids({ altitude: Math.PI/4, azimuth: -Math.PI/2, isAboveHorizon: true }, winE);
for (const k of Object.keys(g5)) summary(k, g5[k]);

console.log('--- Case 6: south window, sun due south at 45° (expect brighter SOUTH half of floor) ---');
const floorSouth = computeGrid({ altitude: Math.PI/4, azimuth: 0, isAboveHorizon: true }, win);
console.log(halfMeans(floorSouth));

console.log('--- Case 7: north window, sun due north at 45° (expect brighter NORTH half of floor) ---');
const winN = [{ id:'w3', kind:'wall', wall:'N', min:1, max:3, yMin:0.8, yMax:2.0 }];
const floorNorth = computeGrid({ altitude: Math.PI/4, azimuth: Math.PI, isAboveHorizon: true }, winN);
console.log(halfMeans(floorNorth));
