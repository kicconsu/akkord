import { defineVisualizer } from './common';

/** Moves in each scramble; the cube takes this many beats to solve. */
const SCRAMBLE_MOVES = 20;

// Rubik's cube: a raymarched 3×3×3 cube spinning on its own (tilted) vertical axis, which
// scrambles itself and then solves one move per beat, in a loop.
// - Cycle of SCRAMBLE_MOVES + 2 beats: a fast scramble whirl on the first beat, then one move
//   undone per beat until solved, then a beat of celebration while solved. It starts scrambled.
// - Spin speed follows the music (uPhase) on top of a slow constant turn.
// - Each of the 54 sticker positions glows with one slice of the spectrum (bass on the top face
//   … treble on the back one), and stickers light up as energy rises.
// - Bass pushes the cubies apart and swells the cube; beats flash it.
// - A spectrum halo circles the cube in the background.
//
// Stateless: the cube state is a function of uBeatCount. Each cycle's scramble is a hashed move
// list; to colour a sticker, the pixel walks its position and normal back through the moves
// applied so far (at most SCRAMBLE_MOVES rotations), which gives the face it came from.
// The SDF splits the cube into three slabs along the moving layer's axis (each a 3×1×3 grid of
// cubies by clamped repetition), so the turning layer is just its points rotated.
export const rubik = defineVisualizer(
  'rubik',
  'Rubik cube',
  /* glsl */ `
const int MOVES = ${SCRAMBLE_MOVES};
const float CYCLE = ${SCRAMBLE_MOVES + 2}.0;   // scramble beat + one beat per move + solved beat
const int STEPS = 64;
const float FAR = 20.0;
const float CAM_DIST = 12.0;
const float FOCAL = 1.8;
const float HALF = 0.46;     // cubie half size before the bass gap
const float ROUND = 0.07;    // cubie edge rounding

// Rotation-rate constants are whole turns per 3600 s, so the uTime/uPhase wrap at 3600 is seamless.
const float SPIN_TIME = 0.17453293;   // 2π × 100 / 3600 rad/s
const float SPIN_PHASE = 0.52359878;  // 2π × 300 / 3600 rad per phase unit

float3x3 rotY(float a) {
  float c = cos(a);
  float s = sin(a);
  return float3x3(c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c);
}

float3x3 rotX(float a) {
  float c = cos(a);
  float s = sin(a);
  return float3x3(1.0, 0.0, 0.0,  0.0, c, s,  0.0, -s, c);
}

// State of the layer that is turning right now, shared by map() and shading, set in main().
float gAxis;      // 0, 1, 2 = x, y, z
float gLayer;     // -1, 0, 1
float gAngle;     // current turn angle, radians (0 when nothing is turning)
float gSpacing;   // distance between cubie centres

// Moves axis \`axis\` to y (a pure permutation, so distances are preserved). Each permutation
// is its own inverse, so the same function maps back.
float3 permute(float3 p, float axis) {
  if (axis < 0.5) return p.yxz;
  if (axis < 1.5) return p;
  return p.xzy;
}

float3 toTwist(float3 p) { return permute(p, gAxis); }
float3 fromTwist(float3 q) { return permute(q, gAxis); }

// Move \`i\` of scramble cycle \`c\`: x = axis, y = layer (-1..1), z = direction (±1).
// Consecutive moves never share an axis, so no move undoes the one before it.
float3 scrambleMove(float c, float i) {
  float axis = mod(i + c, 3.0);
  float layer = floor(hash12(float2(c * 31.0 + i, 7.3)) * 3.0) - 1.0;
  float dir = hash12(float2(c * 31.0 + i, 19.1)) < 0.5 ? -1.0 : 1.0;
  return float3(axis, layer, dir);
}

float roundBox(float3 p, float b, float r) {
  float3 q = abs(p) - float3(b - r);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// One slab (3×3 cubies in xz at height layer × spacing). Returns the local point in its cubie.
float slab(float3 q, float layer, out float3 local, out float3 cell) {
  float3 c = float3(clamp(floor(q.x / gSpacing + 0.5), -1.0, 1.0),
                    layer,
                    clamp(floor(q.z / gSpacing + 0.5), -1.0, 1.0));
  local = q - c * gSpacing;
  cell = c;
  return roundBox(local, HALF, ROUND);
}

float2x2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return float2x2(c, s, -s, c);
}

// Distance to the cube (p in cube space). Also returns the hit cubie's local point and cell
// (cell in twist space, before the twist rotation).
float mapFull(float3 p, out float3 local, out float3 cell) {
  float3 q = toTwist(p);
  float d = FAR;
  for (int i = 0; i < 3; i++) {
    float layer = float(i) - 1.0;
    float3 qq = q;
    if (abs(layer - gLayer) < 0.5) qq.xz = rot2(gAngle) * qq.xz;
    float3 l;
    float3 c;
    float di = slab(qq, layer, l, c);
    if (di < d) {
      d = di;
      local = l;
      cell = c;
    }
  }
  return d;
}

float map(float3 p) {
  float3 l;
  float3 c;
  return mapFull(p, l, c);
}

float3 calcNormal(float3 p) {
  const float e = 0.002;
  const float2 k = float2(1.0, -1.0);
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                   k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// Classic scheme for an axis-aligned normal: +x red, -x orange, +y white, -y yellow,
// +z green, -z blue.
float3 faceColor(float3 n) {
  float3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? float3(0.95, 0.95, 0.95) : float3(1.00, 0.84, 0.05);
  if (a.x >= a.z) return n.x > 0.0 ? float3(0.86, 0.10, 0.12) : float3(1.00, 0.45, 0.05);
  return n.z > 0.0 ? float3(0.05, 0.70, 0.30) : float3(0.08, 0.32, 0.95);
}

// Where the sticker now at cell \`c\` facing \`n\` (cube space, after \`applied\` moves of cycle
// \`cyc\`) sat on the solved cube: undo the moves newest first. Returns the solved normal.
float3 solvedNormal(float3 c, float3 n, float cyc, float applied) {
  for (int j = 0; j < MOVES; j++) {
    float i = float(MOVES - 1 - j);
    if (i < applied) {
      float3 m = scrambleMove(cyc, i);
      float3 pc = permute(c, m.x);
      if (abs(pc.y - m.y) < 0.5) {
        float3 pn = permute(n, m.x);
        float2x2 r = rot2(m.z * 0.5 * PI);   // same transform the SDF uses to look up a turned layer
        pc.xz = floor(r * pc.xz + 0.5);
        pn.xz = floor(r * pn.xz + 0.5);
        c = permute(pc, m.x);
        n = permute(pn, m.x);
      }
    }
  }
  return n;
}

// Face index 0..5 in spectrum order (bass → treble): +y, -y, +x, -x, +z, -z.
float faceIndex(float3 n) {
  float3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? 0.0 : 1.0;
  if (a.x >= a.z) return n.x > 0.0 ? 2.0 : 3.0;
  return n.z > 0.0 ? 4.0 : 5.0;
}

half4 main(float2 fragCoord) {
  float2 uv = (fragCoord - 0.5 * uResolution) / uResolution.x;   // ±0.5 across the width
  float r = length(uv);

  // Where we are in the scramble → solve cycle. uBeatCount steps on the same frame uBeat jumps
  // to 1, and each beat's motion eases in as uBeat decays (done once it falls below 0.15,
  // ≈ 0.23 s), so a move always finishes before the next beat.
  float cyc = floor(uBeatCount / CYCLE);
  float k = uBeatCount - cyc * CYCLE;                 // beat within the cycle
  float prog = clamp((1.0 - clamp(uBeat, 0.0, 1.0)) / 0.85, 0.0, 1.0);
  prog = prog * prog * (3.0 - 2.0 * prog);

  float applied;       // scramble moves fully applied
  float turn;          // 0..1 of the next move (index \`applied\`) applied on top
  if (k < 0.5) {
    // Scramble whirl: all moves in quick succession.
    float s = prog * float(MOVES);
    applied = min(floor(s), float(MOVES));
    turn = applied < float(MOVES) ? s - applied : 0.0;
  } else if (k < float(MOVES) + 0.5) {
    // Solving: beat k undoes move MOVES - k.
    applied = float(MOVES) - k;
    turn = 1.0 - prog;
  } else {
    applied = 0.0;     // solved: one beat to enjoy it
    turn = 0.0;
  }
  float solved = (k > float(MOVES) + 0.5 || (k > float(MOVES) - 0.5 && prog > 0.999)) ? 1.0 : 0.0;

  float3 m = scrambleMove(cyc, min(applied, float(MOVES - 1)));
  gAxis = m.x;
  gLayer = m.y;
  gAngle = turn > 0.0 ? m.z * 0.5 * PI * turn : 0.0;
  gSpacing = 2.0 * HALF + 0.04 + 0.10 * uBass;

  // Background: deep gradient + spectrum halo around the cube.
  float3 col = mix(float3(0.02, 0.02, 0.05), float3(0.06, 0.02, 0.08), clamp(r * 1.6, 0.0, 1.0));
  float ang = atan(uv.y, uv.x + 1e-6);                   // −π..π
  float sx = abs(ang) / PI;                              // mirrored: bass at the top
  float lvl = spectrum(sx);
  float ringR = 0.37 + 0.03 * uBass + 0.025 * uBeat;
  // Celebration while solved: the halo flares.
  lvl = max(lvl, solved * (0.5 + 0.5 * uBeat));
  float ring = exp(-pow(max(r - ringR, 0.0) / (0.015 + 0.10 * lvl), 2.0)) * step(ringR - 0.02, r);
  float3 ringCol = palette(sx * 0.8 + uPhase * 0.03, float3(0.5), float3(0.5), float3(1.0),
                           float3(0.0, 0.33, 0.67));
  col += ringCol * ring * (0.15 + 0.85 * lvl);
  col += float3(0.25, 0.12, 0.35) * (0.15 + 0.6 * uBass) * exp(-r * 4.0) * 0.6;

  // Camera and cube orientation: tilted so three faces show, spinning about cube-space y.
  float spin = uTime * SPIN_TIME + uPhase * SPIN_PHASE;
  float tilt = -0.55 + 0.08 * sin(uTime * SPIN_TIME * 2.0);
  // View → cube space: the inverse of rotX(tilt) * rotY(yaw). SkSL has no transpose().
  float3x3 toCube = rotY(-(spin + 0.6)) * rotX(-tilt);
  float scale = 1.0 + 0.05 * uBass + 0.04 * uBeat;

  float3 ro = toCube * float3(0.0, 0.0, -CAM_DIST) / scale;
  float3 rd = toCube * normalize(float3(uv.x, -uv.y, FOCAL));

  // Bounding sphere: skip pixels that can't hit the cube.
  float bound = 3.0 * (gSpacing * 0.5 + HALF) * 0.95;
  float b = dot(ro, rd);
  float disc = b * b - (dot(ro, ro) - bound * bound);
  if (disc > 0.0) {
    float t = max(-b - sqrt(disc), 0.0);
    float tEnd = -b + sqrt(disc);
    bool hit = false;
    for (int i = 0; i < STEPS; i++) {
      float d = map(ro + rd * t);
      if (d < 0.0015) { hit = true; break; }
      t += d * 0.9;
      if (t > tEnd) break;
    }

    if (hit) {
      float3 p = ro + rd * t;
      float3 local;
      float3 cell;
      mapFull(p, local, cell);
      float3 n = calcNormal(p);              // cube space

      // Sticker mask: the face axis is the largest local component; the other two must lie
      // inside a rounded square.
      float3 al = abs(local);
      float2 inFace = al.y >= al.x && al.y >= al.z ? al.xz : (al.x >= al.z ? al.yz : al.xy);
      float faceness = max(al.x, max(al.y, al.z));
      float2 qd = max(inFace - float2(HALF - 0.12), 0.0);
      float sq = length(qd) + min(max(inFace.x, inFace.y) - (HALF - 0.12), 0.0) - 0.05;
      float sticker = (1.0 - smoothstep(-0.01, 0.01, sq)) * step(HALF - 0.02, faceness);

      // The sticker's place on the cube before the turning layer moves: cell and face normal
      // (from the local face axis), both brought back from twist space to cube space.
      float3 c3 = fromTwist(cell);
      float3 nLocal = al.y >= al.x && al.y >= al.z ? float3(0.0, sign(local.y), 0.0)
                    : (al.x >= al.z ? float3(sign(local.x), 0.0, 0.0) : float3(0.0, 0.0, sign(local.z)));
      float3 n3 = fromTwist(nLocal);

      // Spectrum by position (so it stays spatially ordered while the stickers move).
      float fi = faceIndex(n3);
      float2 fc = fi < 1.5 ? c3.xz : (fi < 3.5 ? c3.yz : c3.xy);
      float si = (fc.x + 1.0) + 3.0 * (fc.y + 1.0);         // 0..8
      float level = spectrum((fi * 9.0 + si) / 53.0);

      // Colour by where this sticker sat on the solved cube.
      float3 base = faceColor(solvedNormal(c3, n3, cyc, applied));
      float3 plastic = float3(0.03, 0.03, 0.035);

      // Lighting in cube space (light fixed to the camera, slightly above).
      float3 L = normalize(toCube * float3(-0.4, 0.7, -0.6));
      float3 V = -rd;
      float diff = max(dot(n, L), 0.0);
      float3 H = normalize(L + V);
      float spec = pow(max(dot(n, H), 0.0), 48.0);
      float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);

      float glow = 0.25 + 1.4 * level + 0.35 * uEnergy;
      float3 stickerCol = base * (0.25 + 0.75 * diff) * (0.6 + 0.4 * glow) + base * level * 0.9;
      float3 surf = mix(plastic * (0.4 + 0.6 * diff), stickerCol, sticker);
      surf += float3(1.0) * spec * (0.25 + 0.5 * sticker) * (0.6 + 0.8 * uTreble);
      surf += float3(0.35, 0.25, 0.6) * fres * (0.3 + 0.7 * uEnergy);
      surf += base * sticker * uBeat * (0.35 + 0.9 * solved);
      col = surf;
    }
  }

  col *= 1.0 - 0.5 * dot(uv, uv);            // vignette
  col = col / (1.0 + col * 0.25);            // gentle tone map
  return half4(half3(col), 1.0);
}
`,
  [],
  // Raymarched: render below screen resolution and upscale (it's smooth shapes, so it stays sharp).
  { renderScale: 0.75 },
);
