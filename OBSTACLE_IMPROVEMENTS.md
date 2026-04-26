# Obstacle Rendering Improvements

## Changes Made

### 1. ✅ Fixed East/West Coordinate Flip
**Problem:** Obstacles drawn on the west side in the 2D view appeared on the east side in the 3D view.

**Root Cause:** The 3D view mirrors the X-axis (east-west) for visual consistency with the 2D heatmap and floor texture, but obstacles were using coordinates directly without this mirror.

**Solution:** 
- Added `dims` prop to `OutdoorObstacles` component
- Apply E-W flip: `x = W - obstacle.x` (matching the convention used for windows and floor heatmap)
- Updated the component call to pass `dims={dims}`

**Code Location:** `src/components/RoomView3D.jsx` lines 763-832

---

### 2. ✅ Object Types Now Fully Supported
Your app already supports 4 object types with complete physics integration!

**Available Types:**
- **Tree** (Opacity: 0.72)
  - Radius: 0.65 m
  - Height: 4.0 m
  - Best for simulating tree canopy shadows

- **Hedge** (Opacity: 0.52)
  - Radius: 0.55 m
  - Height: 1.6 m
  - Good for low vegetation barriers

- **Fence** (Opacity: 0.42)
  - Radius: 0.35 m
  - Height: 1.9 m
  - Minimal occlusion, mostly decorative shadow

- **Shed** (Opacity: 0.9)
  - Radius: 0.8 m
  - Height: 2.4 m
  - Strong shadow blocker for structures

**How Physics Work:**
The simulation in `lightSim.js` treats each obstacle as a cylinder with a circular cross-section. The `obstacleBlocksRay()` function (line 89) uses the obstacle's `radius` and `height` to determine if a light ray is blocked. Opacity values control how much light is blocked (0.0 = transparent, 1.0 = fully opaque).

---

### 3. ✅ Improved Tree Geometry & Light Interaction

**Previous Issues:**
- Visual gap between trunk and canopy
- Sphere canopy didn't visually match the cylindrical physics model
- Materials didn't have shadow properties

**Changes Made:**

**Trunk:**
- Height adjusted to `0.55 * height` (from `0.56`)
- Position moved to `0.35 * height` (from `0.28`) — creates slight overlap with canopy
- Added `castShadow` and `receiveShadow` for proper shadow rendering
- Slightly larger base radius for better proportions

**Canopy:**
- Sphere radius now `0.95 * radius` (from full `radius`) — better scale matching
- Position moved to `0.75 * height` (from `0.78`) — overlaps with trunk
- Increased geometry detail: `sphereGeometry args={[radius * 0.95, 20, 16]}` (from `18, 14`)
- Added `castShadow` and `receiveShadow` for proper shadow casting

**Result:** 
- Trees now look like solid, unified objects with no visible gap
- Shadows cast correctly on the ground and interior surfaces
- Geometry better represents the cylindrical collision model used in the physics

---

## Technical Details

### Coordinate System Reminder
```
X: East   (0 = west wall, W = east wall)
Y: Up     (0 = floor, H = ceiling)
Z: North  (0 = south wall, D = north wall)
```

### E-W Mirror Convention
The 3D view mirrors the X-axis to align the visual perspective with the 2D floor plan:
- Floor heatmap cells: `col = GRID_SIZE - 1 - i`
- Window panes: `cx = W - (w.xMin + w.xMax) / 2`
- Ceiling overlays: `flipU = true`
- **Now:** Obstacles: `x = W - obstacle.x`

This ensures that an object placed at position X=1 in the 2D view appears at the same visual location in the 3D view.

### Shadow Casting
All obstacles now include `castShadow` and `receiveShadow` properties, enabling:
1. Realistic shadow casting onto the floor and walls
2. Proper light occlusion in the simulation (handled by `obstacleBlocksRay()`)
3. Visual feedback showing how obstacles block direct sunlight

---

## Testing Recommendations

1. **Test the flip fix:**
   - Draw an obstacle on the west side in the 2D view
   - Verify it appears on the west side in the 3D view (not flipped to east)

2. **Test different object types:**
   - Try placing tree, hedge, fence, and shed
   - Verify they have correct proportions and heights
   - Check that shadows render properly throughout the day

3. **Verify light blocking:**
   - Place obstacles at different distances from windows
   - In instant mode, watch the floor heatmap darken as the obstacle blocks direct sun rays
   - Try different sun angles to see shadow variation

4. **Visual quality:**
   - Check that tree trunks and canopies appear connected (no gaps)
   - Verify shadows look realistic and update smoothly as sun moves

---

## Future Enhancements

Possible next steps:
- Add more object types (buildings, pergolas, palm trees, etc.)
- Customize individual obstacle properties (scale, opacity) via UI
- Add collision detection to prevent overlapping obstacles
- Support for rotating obstacles (e.g., fence orientation)
