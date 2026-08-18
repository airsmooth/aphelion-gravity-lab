/** Ready-to-run SI-unit systems for Gravity Lab. */

import {
  createBody,
  createSimulationState,
  GRAVITATIONAL_CONSTANT,
  resolvePhysicsConfig,
  type BodyInit,
  type CelestialBody,
  type PhysicsConfig,
  type SimulationState,
  type Vector2,
} from "./physics";

export const ASTRONOMICAL_UNIT = 149_597_870_700;
export const SOLAR_MASS = 1.98847e30;
export const SOLAR_RADIUS = 695_700_000;
export const EARTH_MASS = 5.9722e24;
export const EARTH_RADIUS = 6_371_000;
export const MOON_MASS = 7.342e22;
export const MOON_RADIUS = 1_737_400;
export const EARTH_MOON_DISTANCE = 384_400_000;

export type BuiltInPresetId =
  | "sun-earth-moon"
  | "earth-moon"
  | "binary-stars"
  | "chaotic-three-body"
  | "stable-orbit"
  | "collision-course"
  | "random-system";

export interface SimulationPreset {
  id: BuiltInPresetId;
  name: string;
  description: string;
  bodies: CelestialBody[];
  config: PhysicsConfig;
  /** Body the camera/property panel should select when loading the preset. */
  focusBodyId: string;
  /** Suggested half-width of the initial camera view, in metres. */
  viewRadius: number;
  /** Present for reproducible generated systems. */
  seed?: number;
}

export const DEFAULT_PRESET_ID: BuiltInPresetId = "sun-earth-moon";
export const DEFAULT_RANDOM_SEED = 0x47524156;

const openingPreset = makeOpeningPreset();
const earthMoonPreset = makeEarthMoonPreset();
const binaryStarsPreset = makeBinaryStarsPreset();
const chaoticThreeBodyPreset = makeChaoticThreeBodyPreset();
const stableOrbitPreset = makeStableOrbitPreset();
const collisionCoursePreset = makeCollisionCoursePreset();
const defaultRandomPreset = createRandomPreset(DEFAULT_RANDOM_SEED, 7);

/**
 * Definitions are intended for menus. Use getPreset/createPresetState before
 * editing so UI state never mutates these shared definitions.
 */
export const PRESETS: readonly SimulationPreset[] = [
  openingPreset,
  earthMoonPreset,
  binaryStarsPreset,
  chaoticThreeBodyPreset,
  stableOrbitPreset,
  collisionCoursePreset,
  defaultRandomPreset,
];

export const PRESET_BY_ID: Readonly<Record<BuiltInPresetId, SimulationPreset>> =
  Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])) as Record<
    BuiltInPresetId,
    SimulationPreset
  >;

export function getPreset(id: BuiltInPresetId): SimulationPreset {
  const preset = PRESET_BY_ID[id];
  if (!preset) throw new Error(`Unknown simulation preset: ${id}`);
  return clonePreset(preset);
}

export function createPresetState(
  id: BuiltInPresetId = DEFAULT_PRESET_ID,
): SimulationState {
  const preset = getPreset(id);
  return createSimulationState(preset.bodies, preset.config);
}

export function clonePreset(preset: SimulationPreset): SimulationPreset {
  return {
    ...preset,
    bodies: preset.bodies.map((body) => ({
      ...body,
      position: { ...body.position },
      velocity: { ...body.velocity },
      acceleration: { ...body.acceleration },
    })),
    config: { ...preset.config },
  };
}

/**
 * Creates a deterministic star-and-orbiters system. Equal seed and bodyCount
 * always produce identical bodies; no global Math.random state is used.
 */
export function createRandomPreset(
  seed: number | string = DEFAULT_RANDOM_SEED,
  bodyCount = 7,
): SimulationPreset {
  if (!Number.isInteger(bodyCount) || bodyCount < 2 || bodyCount > 32) {
    throw new RangeError("Random preset bodyCount must be an integer from 2 to 32.");
  }

  const numericSeed = normalizeSeed(seed);
  const random = mulberry32(numericSeed);
  const starMass = SOLAR_MASS * (0.72 + random() * 0.72);
  const starRadius = SOLAR_RADIUS * Math.cbrt(starMass / SOLAR_MASS);
  const bodies: CelestialBody[] = [
    body({
      id: "random-star",
      name: "PRIMARY",
      mass: starMass,
      radius: starRadius,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      fixed: true,
      density: sphereDensity(starMass, starRadius),
    }),
  ];

  const orbiterCount = bodyCount - 1;
  const innerOrbit = ASTRONOMICAL_UNIT * 0.28;
  const outerOrbit = ASTRONOMICAL_UNIT * 3.2;

  for (let index = 0; index < orbiterCount; index += 1) {
    const fraction = orbiterCount === 1 ? 0.45 : index / (orbiterCount - 1);
    const baseOrbit =
      innerOrbit * Math.pow(outerOrbit / innerOrbit, fraction);
    const orbitRadius = baseOrbit * (0.94 + random() * 0.12);
    const angle = random() * Math.PI * 2;
    const mass = 10 ** (22.4 + random() * 3.25);
    const density = 2_400 + random() * 4_000;
    const radius = sphereRadius(mass, density);
    const position = {
      x: Math.cos(angle) * orbitRadius,
      y: Math.sin(angle) * orbitRadius,
    };
    const tangent = { x: -Math.sin(angle), y: Math.cos(angle) };
    const radial = { x: Math.cos(angle), y: Math.sin(angle) };
    const circularSpeed = Math.sqrt(
      (GRAVITATIONAL_CONSTANT * (starMass + mass)) / orbitRadius,
    );
    const tangentialSpeed = circularSpeed * (0.92 + random() * 0.16);
    const radialSpeed = circularSpeed * (random() - 0.5) * 0.055;

    bodies.push(
      body({
        id: `random-${String(index + 1).padStart(2, "0")}`,
        name: `OBJECT ${String(index + 1).padStart(2, "0")}`,
        mass,
        radius,
        density,
        position,
        velocity: addScaled(tangent, tangentialSpeed, radial, radialSpeed),
      }),
    );
  }

  return {
    id: "random-system",
    name: "Random system",
    description: `A reproducible ${bodyCount}-body system generated from seed ${numericSeed}.`,
    bodies,
    config: config({
      timeStep: 1_800,
      softening: 2_000_000,
      collisionMode: "merge",
    }),
    focusBodyId: bodies.length > 1 ? bodies[1].id : bodies[0].id,
    viewRadius: outerOrbit * 1.16,
    seed: numericSeed,
  };
}

function makeOpeningPreset(): SimulationPreset {
  const bodies = [
    body({
      id: "sun",
      name: "SUN",
      mass: SOLAR_MASS,
      radius: SOLAR_RADIUS,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      fixed: true,
      density: sphereDensity(SOLAR_MASS, SOLAR_RADIUS),
    }),
    body({
      id: "earth",
      name: "EARTH",
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: { x: ASTRONOMICAL_UNIT, y: 0 },
      velocity: { x: 0, y: 29_784.7 },
      density: 5_514,
    }),
    body({
      id: "moon",
      name: "MOON",
      mass: MOON_MASS,
      radius: MOON_RADIUS,
      position: { x: ASTRONOMICAL_UNIT + EARTH_MOON_DISTANCE, y: 0 },
      velocity: { x: 0, y: 29_784.7 + 1_022 },
      density: 3_344,
    }),
  ];

  return {
    id: "sun-earth-moon",
    name: "Sun · Earth · Moon",
    description:
      "The opening heliocentric system: Earth orbits a fixed Sun while the Moon orbits Earth.",
    bodies,
    config: config({
      timeStep: 1_800,
      softening: 1_000_000,
      collisionMode: "merge",
    }),
    focusBodyId: "earth",
    viewRadius: ASTRONOMICAL_UNIT * 1.18,
  };
}

function makeEarthMoonPreset(): SimulationPreset {
  const totalMass = EARTH_MASS + MOON_MASS;
  const earthDistance = (EARTH_MOON_DISTANCE * MOON_MASS) / totalMass;
  const moonDistance = (EARTH_MOON_DISTANCE * EARTH_MASS) / totalMass;
  const angularVelocity = Math.sqrt(
    (GRAVITATIONAL_CONSTANT * totalMass) / EARTH_MOON_DISTANCE ** 3,
  );
  const bodies = [
    body({
      id: "earth",
      name: "EARTH",
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: { x: -earthDistance, y: 0 },
      velocity: { x: 0, y: -angularVelocity * earthDistance },
      density: 5_514,
    }),
    body({
      id: "moon",
      name: "MOON",
      mass: MOON_MASS,
      radius: MOON_RADIUS,
      position: { x: moonDistance, y: 0 },
      velocity: { x: 0, y: angularVelocity * moonDistance },
      density: 3_344,
    }),
  ];

  return {
    id: "earth-moon",
    name: "Earth · Moon",
    description:
      "A barycentric two-body orbit with positions and velocities balanced around the shared center of mass.",
    bodies,
    config: config({
      timeStep: 300,
      softening: 100_000,
      collisionMode: "merge",
    }),
    focusBodyId: "earth",
    viewRadius: EARTH_MOON_DISTANCE * 1.08,
  };
}

function makeBinaryStarsPreset(): SimulationPreset {
  const massA = SOLAR_MASS * 1.34;
  const massB = SOLAR_MASS * 0.88;
  const separation = ASTRONOMICAL_UNIT * 1.35;
  const totalMass = massA + massB;
  const radiusA = (separation * massB) / totalMass;
  const radiusB = (separation * massA) / totalMass;
  const angularVelocity = Math.sqrt(
    (GRAVITATIONAL_CONSTANT * totalMass) / separation ** 3,
  );
  const bodies = [
    body({
      id: "binary-a",
      name: "HELION A",
      mass: massA,
      radius: SOLAR_RADIUS * 1.18,
      position: { x: -radiusA, y: 0 },
      velocity: { x: 0, y: -angularVelocity * radiusA },
    }),
    body({
      id: "binary-b",
      name: "HELION B",
      mass: massB,
      radius: SOLAR_RADIUS * 0.91,
      position: { x: radiusB, y: 0 },
      velocity: { x: 0, y: angularVelocity * radiusB },
    }),
  ];

  return {
    id: "binary-stars",
    name: "Binary stars",
    description:
      "Two unequal stars in a circular barycentric orbit with zero net linear momentum.",
    bodies,
    config: config({
      timeStep: 1_800,
      softening: 20_000_000,
      collisionMode: "merge",
    }),
    focusBodyId: "binary-a",
    viewRadius: separation * 0.74,
  };
}

function makeChaoticThreeBodyPreset(): SimulationPreset {
  const mass = 1.0e29;
  const lengthScale = 80_000_000_000;
  const velocityScale = Math.sqrt(
    (GRAVITATIONAL_CONSTANT * mass) / lengthScale,
  );
  const baseVelocity = {
    x: 0.466203685 * velocityScale,
    y: 0.43236573 * velocityScale,
  };
  const velocityA = { x: baseVelocity.x * 1.006, y: baseVelocity.y };
  const velocityB = { x: baseVelocity.x, y: baseVelocity.y * 0.994 };
  const velocityC = {
    x: -(velocityA.x + velocityB.x),
    y: -(velocityA.y + velocityB.y),
  };
  const starRadius = 220_000_000;
  const bodies = [
    body({
      id: "chaos-a",
      name: "VECTOR A",
      mass,
      radius: starRadius,
      position: {
        x: 0.97000436 * lengthScale,
        y: -0.24308753 * lengthScale,
      },
      velocity: velocityA,
    }),
    body({
      id: "chaos-b",
      name: "VECTOR B",
      mass,
      radius: starRadius,
      position: {
        x: -0.97000436 * lengthScale,
        y: 0.24308753 * lengthScale,
      },
      velocity: velocityB,
    }),
    body({
      id: "chaos-c",
      name: "VECTOR C",
      mass,
      radius: starRadius,
      position: { x: 0, y: 0 },
      velocity: velocityC,
    }),
  ];

  return {
    id: "chaotic-three-body",
    name: "Chaotic three-body",
    description:
      "A deliberately perturbed figure-eight configuration: initially coherent, increasingly sensitive over time.",
    bodies,
    config: config({
      timeStep: 300,
      softening: 5_000_000,
      collisionMode: "merge",
    }),
    focusBodyId: "chaos-c",
    viewRadius: lengthScale * 1.35,
  };
}

function makeStableOrbitPreset(): SimulationPreset {
  const orbitRadius = ASTRONOMICAL_UNIT * 0.72;
  const planetMass = EARTH_MASS * 3.1;
  const planetDensity = 5_100;
  const circularSpeed = Math.sqrt(
    (GRAVITATIONAL_CONSTANT * (SOLAR_MASS + planetMass)) / orbitRadius,
  );
  const bodies = [
    body({
      id: "anchor",
      name: "ANCHOR",
      mass: SOLAR_MASS,
      radius: SOLAR_RADIUS,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      fixed: true,
    }),
    body({
      id: "orbiter",
      name: "ORBITER",
      mass: planetMass,
      radius: sphereRadius(planetMass, planetDensity),
      density: planetDensity,
      position: { x: orbitRadius, y: 0 },
      velocity: { x: 0, y: circularSpeed },
    }),
  ];

  return {
    id: "stable-orbit",
    name: "Stable orbit",
    description:
      "A planet initialized at the exact circular-orbit speed around a fixed solar-mass anchor.",
    bodies,
    config: config({
      timeStep: 1_800,
      softening: 1_000_000,
      collisionMode: "merge",
    }),
    focusBodyId: "orbiter",
    viewRadius: orbitRadius * 1.35,
  };
}

function makeCollisionCoursePreset(): SimulationPreset {
  const bodies = [
    body({
      id: "collision-a",
      name: "IMPACTOR A",
      mass: 4.2e24,
      radius: 7_000_000,
      position: { x: -16_000_000, y: -1_500_000 },
      velocity: { x: 5_600, y: 260 },
      density: sphereDensity(4.2e24, 7_000_000),
    }),
    body({
      id: "collision-b",
      name: "IMPACTOR B",
      mass: 6.1e24,
      radius: 7_800_000,
      position: { x: 16_000_000, y: 1_500_000 },
      velocity: { x: -4_100, y: -190 },
      density: sphereDensity(6.1e24, 7_800_000),
    }),
  ];

  return {
    id: "collision-course",
    name: "Collision course",
    description:
      "Two terrestrial bodies on an offset impact trajectory; switch collision modes to compare outcomes.",
    bodies,
    config: config({
      timeStep: 5,
      softening: 100_000,
      collisionMode: "merge",
    }),
    focusBodyId: "collision-a",
    viewRadius: 42_000_000,
  };
}

function body(init: BodyInit): CelestialBody {
  return createBody({ trailVisible: true, fixed: false, ...init });
}

function config(overrides: Partial<PhysicsConfig>): PhysicsConfig {
  return resolvePhysicsConfig({ restitution: 1, ...overrides });
}

function sphereRadius(mass: number, density: number): number {
  return Math.cbrt((3 * mass) / (4 * Math.PI * density));
}

function sphereDensity(mass: number, radius: number): number {
  return mass / ((4 / 3) * Math.PI * radius ** 3);
}

function addScaled(
  a: Vector2,
  aScale: number,
  b: Vector2,
  bScale: number,
): Vector2 {
  return {
    x: a.x * aScale + b.x * bScale,
    y: a.y * aScale + b.y * bScale,
  };
}

function normalizeSeed(seed: number | string): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new RangeError("Random seed must be finite.");
    return Math.trunc(seed) >>> 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
