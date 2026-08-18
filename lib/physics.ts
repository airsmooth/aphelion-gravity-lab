/**
 * Pure, dependency-free Newtonian N-body physics for Gravity Lab.
 *
 * All public distances are metres, masses kilograms, time seconds, velocities
 * metres/second, accelerations metres/second squared, and forces newtons.
 * Functions return new objects rather than mutating the supplied state, which
 * keeps them safe to use with React state.
 */

export const GRAVITATIONAL_CONSTANT = 6.6743e-11;

export interface Vector2 {
  x: number;
  y: number;
}

export type CollisionMode = "pass" | "elastic" | "merge";

export interface CelestialBody {
  id: string;
  name: string;
  mass: number;
  radius: number;
  position: Vector2;
  velocity: Vector2;
  /** Gravitational acceleration at the body's current position. */
  acceleration: Vector2;
  /** Fixed bodies exert gravity but are not translated by the integrator. */
  fixed: boolean;
  density?: number;
  trailVisible: boolean;
}

export interface BodyInit {
  id: string;
  name: string;
  mass: number;
  radius: number;
  position: Vector2;
  velocity?: Vector2;
  acceleration?: Vector2;
  fixed?: boolean;
  density?: number;
  trailVisible?: boolean;
}

export interface PhysicsConfig {
  gravitationalConstant: number;
  /** The recommended fixed integration step, in seconds. */
  timeStep: number;
  /** Plummer softening length, in metres. */
  softening: number;
  collisionMode: CollisionMode;
  /** Coefficient of restitution used by elastic collisions, from 0 to 1. */
  restitution: number;
}

export const DEFAULT_PHYSICS_CONFIG: Readonly<PhysicsConfig> = {
  gravitationalConstant: GRAVITATIONAL_CONSTANT,
  timeStep: 60,
  softening: 1_000,
  collisionMode: "pass",
  restitution: 1,
};

export interface SimulationState {
  bodies: CelestialBody[];
  /** Elapsed simulated time in seconds. */
  time: number;
  tick: number;
  config: PhysicsConfig;
}

export interface CollisionEvent {
  mode: Exclude<CollisionMode, "pass">;
  bodyAId: string;
  bodyBId: string;
  /** The surviving body's id for merge events. */
  resultBodyId?: string;
  impactSpeed: number;
  time: number;
}

export interface SimulationStepResult {
  state: SimulationState;
  collisions: CollisionEvent[];
}

export interface BodyDynamics {
  bodyId: string;
  acceleration: Vector2;
  netForce: Vector2;
}

export interface PairwiseForce {
  bodyAId: string;
  bodyBId: string;
  distance: number;
  magnitude: number;
  /** Force exerted by B on A. */
  forceOnA: Vector2;
  /** Force exerted by A on B. */
  forceOnB: Vector2;
}

export interface ForceVector {
  sourceBodyId: string;
  attractingBodyId: string;
  distance: number;
  magnitude: number;
  vector: Vector2;
}

export interface PairMetrics {
  bodyAId: string;
  bodyBId: string;
  distance: number;
  relativeVelocity: Vector2;
  relativeSpeed: number;
  gravitationalForce: number;
  forceOnA: Vector2;
  potentialEnergy: number;
}

export interface SystemDiagnostics {
  centerOfMass: Vector2;
  centerOfMassVelocity: Vector2;
  totalMass: number;
  momentum: Vector2;
  angularMomentum: number;
  kineticEnergy: number;
  potentialEnergy: number;
  totalEnergy: number;
}

export type ReferenceFrame =
  | { type: "inertial" }
  | { type: "center-of-mass" }
  | { type: "selected-body"; bodyId: string };

export interface ReferenceFrameTransform {
  origin: Vector2;
  velocity: Vector2;
}

export interface TrajectoryPoint {
  /** Absolute simulation time. */
  time: number;
  /** Time from the start of this prediction. */
  elapsedTime: number;
  position: Vector2;
}

export interface PredictedTrajectory {
  bodyId: string;
  points: TrajectoryPoint[];
}

export interface PredictionOptions {
  /** Prediction duration in simulated seconds. */
  horizon: number;
  /** Integration step; defaults to the state's configured timestep. */
  integrationStep?: number;
  /** Interval between returned points; defaults to integrationStep. */
  sampleInterval?: number;
  includeInitial?: boolean;
  collisionMode?: CollisionMode;
  /** Work guard for interactive callers. Defaults to 20,000. */
  maxSteps?: number;
}

const ZERO: Readonly<Vector2> = { x: 0, y: 0 };
const EPSILON = 1e-12;

export function vector(x = 0, y = 0): Vector2 {
  return { x, y };
}

export function addVectors(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtractVectors(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVector(value: Vector2, scalar: number): Vector2 {
  return { x: value.x * scalar, y: value.y * scalar };
}

export function dotProduct(a: Vector2, b: Vector2): number {
  return a.x * b.x + a.y * b.y;
}

export function vectorMagnitudeSquared(value: Vector2): number {
  return dotProduct(value, value);
}

export function vectorMagnitude(value: Vector2): number {
  return Math.hypot(value.x, value.y);
}

export function normalizeVector(value: Vector2): Vector2 {
  const magnitude = vectorMagnitude(value);
  return magnitude > EPSILON
    ? { x: value.x / magnitude, y: value.y / magnitude }
    : { x: 0, y: 0 };
}

export function distanceBetween(a: Vector2, b: Vector2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function cloneBody(body: CelestialBody): CelestialBody {
  return {
    ...body,
    position: { ...body.position },
    velocity: { ...body.velocity },
    acceleration: { ...body.acceleration },
  };
}

export function cloneBodies(bodies: readonly CelestialBody[]): CelestialBody[] {
  return bodies.map(cloneBody);
}

export function cloneSimulationState(state: SimulationState): SimulationState {
  return {
    bodies: cloneBodies(state.bodies),
    time: state.time,
    tick: state.tick,
    config: { ...state.config },
  };
}

export function createBody(init: BodyInit): CelestialBody {
  const body: CelestialBody = {
    id: init.id.trim(),
    name: init.name.trim(),
    mass: init.mass,
    radius: init.radius,
    position: { ...init.position },
    velocity: { ...(init.velocity ?? ZERO) },
    acceleration: { ...(init.acceleration ?? ZERO) },
    fixed: init.fixed ?? false,
    density: init.density,
    trailVisible: init.trailVisible ?? true,
  };
  validateBody(body);
  return body;
}

export function resolvePhysicsConfig(
  config: Partial<PhysicsConfig> = {},
): PhysicsConfig {
  const resolved: PhysicsConfig = {
    ...DEFAULT_PHYSICS_CONFIG,
    ...config,
  };
  validatePhysicsConfig(resolved);
  return resolved;
}

export function createSimulationState(
  bodies: readonly (CelestialBody | BodyInit)[],
  config: Partial<PhysicsConfig> = {},
  time = 0,
): SimulationState {
  if (!Number.isFinite(time)) {
    throw new RangeError("Simulation time must be finite.");
  }
  const normalizedBodies = bodies.map((body) =>
    createBody({
      ...body,
      position: { ...body.position },
      velocity: body.velocity ? { ...body.velocity } : undefined,
      acceleration: body.acceleration ? { ...body.acceleration } : undefined,
    }),
  );
  validateUniqueIds(normalizedBodies);
  const resolvedConfig = resolvePhysicsConfig(config);
  const dynamics = calculateBodyDynamics(normalizedBodies, resolvedConfig);
  const accelerations = new Map(
    dynamics.map((entry) => [entry.bodyId, entry.acceleration]),
  );

  return {
    bodies: normalizedBodies.map((body) => ({
      ...body,
      acceleration: { ...(accelerations.get(body.id) ?? ZERO) },
    })),
    time,
    tick: 0,
    config: resolvedConfig,
  };
}

export function validateBody(body: CelestialBody): void {
  if (!body.id.trim()) throw new Error("A body id cannot be empty.");
  if (!body.name.trim()) throw new Error(`Body ${body.id} needs a name.`);
  assertFinitePositive(body.mass, `Mass for ${body.id}`);
  assertFiniteNonNegative(body.radius, `Radius for ${body.id}`);
  assertFiniteVector(body.position, `Position for ${body.id}`);
  assertFiniteVector(body.velocity, `Velocity for ${body.id}`);
  assertFiniteVector(body.acceleration, `Acceleration for ${body.id}`);
  if (body.density !== undefined) {
    assertFinitePositive(body.density, `Density for ${body.id}`);
  }
}

export function validatePhysicsConfig(config: PhysicsConfig): void {
  assertFiniteNonNegative(
    config.gravitationalConstant,
    "Gravitational constant",
  );
  assertFinitePositive(config.timeStep, "Physics timestep");
  assertFiniteNonNegative(config.softening, "Numerical softening");
  if (!(["pass", "elastic", "merge"] as CollisionMode[]).includes(config.collisionMode)) {
    throw new Error(`Unknown collision mode: ${String(config.collisionMode)}`);
  }
  if (
    !Number.isFinite(config.restitution) ||
    config.restitution < 0 ||
    config.restitution > 1
  ) {
    throw new RangeError("Restitution must be between 0 and 1.");
  }
}

/**
 * Calculates gravitational acceleration and net force for every body in one
 * symmetric O(n²) pass. Fixed bodies retain a physical acceleration value for
 * HUD/vector display even though the integrator does not move them.
 */
export function calculateBodyDynamics(
  bodies: readonly CelestialBody[],
  config: Partial<PhysicsConfig> = {},
): BodyDynamics[] {
  const { gravitationalConstant, softening } = resolvePhysicsConfig(config);
  validateBodiesForCalculation(bodies);
  const accelerations = bodies.map(() => ({ x: 0, y: 0 }));
  const softeningSquared = softening * softening;

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const bodyA = bodies[i];
      const bodyB = bodies[j];
      const dx = bodyB.position.x - bodyA.position.x;
      const dy = bodyB.position.y - bodyA.position.y;
      const softenedDistanceSquared = dx * dx + dy * dy + softeningSquared;
      if (softenedDistanceSquared <= EPSILON) continue;

      const inverseDistance = 1 / Math.sqrt(softenedDistanceSquared);
      const inverseDistanceCubed = inverseDistance / softenedDistanceSquared;
      const common = gravitationalConstant * inverseDistanceCubed;

      accelerations[i].x += common * bodyB.mass * dx;
      accelerations[i].y += common * bodyB.mass * dy;
      accelerations[j].x -= common * bodyA.mass * dx;
      accelerations[j].y -= common * bodyA.mass * dy;
    }
  }

  return bodies.map((body, index) => ({
    bodyId: body.id,
    acceleration: { ...accelerations[index] },
    netForce: scaleVector(accelerations[index], body.mass),
  }));
}

export function calculateAccelerations(
  bodies: readonly CelestialBody[],
  config: Partial<PhysicsConfig> = {},
): Map<string, Vector2> {
  return new Map(
    calculateBodyDynamics(bodies, config).map((entry) => [
      entry.bodyId,
      entry.acceleration,
    ]),
  );
}

export function calculatePairwiseForces(
  bodies: readonly CelestialBody[],
  config: Partial<PhysicsConfig> = {},
): PairwiseForce[] {
  const { gravitationalConstant, softening } = resolvePhysicsConfig(config);
  validateBodiesForCalculation(bodies);
  const result: PairwiseForce[] = [];
  const softeningSquared = softening * softening;

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const bodyA = bodies[i];
      const bodyB = bodies[j];
      const displacement = subtractVectors(bodyB.position, bodyA.position);
      const distanceSquared = vectorMagnitudeSquared(displacement);
      const softenedDistanceSquared = distanceSquared + softeningSquared;
      let forceOnA = { x: 0, y: 0 };

      if (softenedDistanceSquared > EPSILON) {
        const inverseDistance = 1 / Math.sqrt(softenedDistanceSquared);
        const scalar =
          gravitationalConstant *
          bodyA.mass *
          bodyB.mass *
          (inverseDistance / softenedDistanceSquared);
        forceOnA = scaleVector(displacement, scalar);
      }

      result.push({
        bodyAId: bodyA.id,
        bodyBId: bodyB.id,
        distance: Math.sqrt(distanceSquared),
        magnitude: vectorMagnitude(forceOnA),
        forceOnA,
        forceOnB: scaleVector(forceOnA, -1),
      });
    }
  }

  return result;
}

/** Returns the individual gravitational force vectors acting on one body. */
export function forceVectorsOnBody(
  bodies: readonly CelestialBody[],
  bodyId: string,
  config: Partial<PhysicsConfig> = {},
): ForceVector[] {
  const selected = bodies.find((body) => body.id === bodyId);
  if (!selected) throw new Error(`Unknown body id: ${bodyId}`);

  return calculatePairwiseForces(bodies, config).flatMap((pair) => {
    if (pair.bodyAId === bodyId) {
      return [{
        sourceBodyId: bodyId,
        attractingBodyId: pair.bodyBId,
        distance: pair.distance,
        magnitude: pair.magnitude,
        vector: { ...pair.forceOnA },
      }];
    }
    if (pair.bodyBId === bodyId) {
      return [{
        sourceBodyId: bodyId,
        attractingBodyId: pair.bodyAId,
        distance: pair.distance,
        magnitude: pair.magnitude,
        vector: { ...pair.forceOnB },
      }];
    }
    return [];
  });
}

/**
 * Advances one velocity-Verlet (kick-drift-kick leapfrog) integration step.
 * Supply a smaller delta than config.timeStep for manually sub-stepped motion.
 */
export function advanceSimulation(
  state: SimulationState,
  deltaTime = state.config.timeStep,
  configOverrides: Partial<PhysicsConfig> = {},
): SimulationStepResult {
  if (!Number.isFinite(deltaTime) || deltaTime < 0) {
    throw new RangeError("Step duration must be a finite non-negative number.");
  }
  validateBodiesForCalculation(state.bodies);
  validateUniqueIds(state.bodies);
  const config = resolvePhysicsConfig({ ...state.config, ...configOverrides });

  if (deltaTime === 0) {
    return {
      state: refreshAccelerations({ ...cloneSimulationState(state), config }),
      collisions: [],
    };
  }

  const startBodies = cloneBodies(state.bodies);
  const initialAccelerations = calculateAccelerations(startBodies, config);
  const previousPositions = new Map(
    startBodies.map((body) => [body.id, { ...body.position }]),
  );

  let driftedBodies = startBodies.map((body) => {
    if (body.fixed) {
      return {
        ...body,
        acceleration: { ...(initialAccelerations.get(body.id) ?? ZERO) },
      };
    }

    const acceleration = initialAccelerations.get(body.id) ?? ZERO;
    const halfVelocity = addVectors(
      body.velocity,
      scaleVector(acceleration, deltaTime * 0.5),
    );
    return {
      ...body,
      velocity: halfVelocity,
      position: addVectors(body.position, scaleVector(halfVelocity, deltaTime)),
      acceleration: { ...acceleration },
    };
  });

  const collisionResult = resolveCollisions(
    driftedBodies,
    previousPositions,
    config,
    deltaTime,
    state.time,
  );
  driftedBodies = collisionResult.bodies;

  const finalAccelerations = calculateAccelerations(driftedBodies, config);
  const finalBodies = driftedBodies.map((body) => {
    const acceleration = finalAccelerations.get(body.id) ?? ZERO;
    return {
      ...body,
      velocity: body.fixed
        ? { ...body.velocity }
        : addVectors(body.velocity, scaleVector(acceleration, deltaTime * 0.5)),
      acceleration: { ...acceleration },
    };
  });

  return {
    state: {
      bodies: finalBodies,
      time: state.time + deltaTime,
      tick: state.tick + 1,
      config,
    },
    collisions: collisionResult.events,
  };
}

/** Convenience wrapper when collision events are not needed. */
export function stepSimulation(
  state: SimulationState,
  deltaTime = state.config.timeStep,
  configOverrides: Partial<PhysicsConfig> = {},
): SimulationState {
  return advanceSimulation(state, deltaTime, configOverrides).state;
}

/**
 * Advances an arbitrary duration using fixed substeps no larger than maxStep.
 * This is useful when a UI changes time scale without degrading integration.
 */
export function simulateDuration(
  state: SimulationState,
  duration: number,
  maxStep = state.config.timeStep,
): SimulationStepResult {
  assertFiniteNonNegative(duration, "Simulation duration");
  assertFinitePositive(maxStep, "Maximum integration step");
  let nextState = cloneSimulationState(state);
  const collisions: CollisionEvent[] = [];
  let remaining = duration;

  while (remaining > EPSILON) {
    const dt = Math.min(maxStep, remaining);
    const result = advanceSimulation(nextState, dt);
    nextState = result.state;
    collisions.push(...result.collisions);
    remaining -= dt;
  }

  return { state: nextState, collisions };
}

/** Recomputes acceleration after an interactive body/config edit. */
export function refreshAccelerations(state: SimulationState): SimulationState {
  const cloned = cloneSimulationState(state);
  const accelerations = calculateAccelerations(cloned.bodies, cloned.config);
  cloned.bodies = cloned.bodies.map((body) => ({
    ...body,
    acceleration: { ...(accelerations.get(body.id) ?? ZERO) },
  }));
  return cloned;
}

export function centerOfMass(
  bodies: readonly CelestialBody[],
): Vector2 {
  const totalMass = bodies.reduce((sum, body) => sum + body.mass, 0);
  if (totalMass <= 0) return { x: 0, y: 0 };
  return bodies.reduce(
    (result, body) => ({
      x: result.x + (body.position.x * body.mass) / totalMass,
      y: result.y + (body.position.y * body.mass) / totalMass,
    }),
    { x: 0, y: 0 },
  );
}

export function systemMomentum(
  bodies: readonly CelestialBody[],
): Vector2 {
  return bodies.reduce(
    (result, body) => ({
      x: result.x + body.velocity.x * body.mass,
      y: result.y + body.velocity.y * body.mass,
    }),
    { x: 0, y: 0 },
  );
}

export function centerOfMassVelocity(
  bodies: readonly CelestialBody[],
): Vector2 {
  const totalMass = bodies.reduce((sum, body) => sum + body.mass, 0);
  return totalMass > 0
    ? scaleVector(systemMomentum(bodies), 1 / totalMass)
    : { x: 0, y: 0 };
}

export function getReferenceFrameTransform(
  bodies: readonly CelestialBody[],
  frame: ReferenceFrame,
): ReferenceFrameTransform {
  switch (frame.type) {
    case "inertial":
      return { origin: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    case "center-of-mass":
      return {
        origin: centerOfMass(bodies),
        velocity: centerOfMassVelocity(bodies),
      };
    case "selected-body": {
      const body = bodies.find((candidate) => candidate.id === frame.bodyId);
      if (!body) throw new Error(`Unknown reference body id: ${frame.bodyId}`);
      return {
        origin: { ...body.position },
        velocity: { ...body.velocity },
      };
    }
  }
}

/** Returns display-space clones in the requested translational reference frame. */
export function bodiesInReferenceFrame(
  bodies: readonly CelestialBody[],
  frame: ReferenceFrame,
): CelestialBody[] {
  const transform = getReferenceFrameTransform(bodies, frame);
  return bodies.map((body) => ({
    ...cloneBody(body),
    position: subtractVectors(body.position, transform.origin),
    velocity: subtractVectors(body.velocity, transform.velocity),
  }));
}

export function calculatePairMetrics(
  bodyA: CelestialBody,
  bodyB: CelestialBody,
  config: Partial<PhysicsConfig> = {},
): PairMetrics {
  const pair = calculatePairwiseForces([bodyA, bodyB], config)[0];
  const relativeVelocity = subtractVectors(bodyB.velocity, bodyA.velocity);
  const resolved = resolvePhysicsConfig(config);
  const softenedDistance = Math.sqrt(
    pair.distance * pair.distance + resolved.softening * resolved.softening,
  );

  return {
    bodyAId: bodyA.id,
    bodyBId: bodyB.id,
    distance: pair.distance,
    relativeVelocity,
    relativeSpeed: vectorMagnitude(relativeVelocity),
    gravitationalForce: pair.magnitude,
    forceOnA: { ...pair.forceOnA },
    potentialEnergy:
      softenedDistance > EPSILON
        ? (-resolved.gravitationalConstant * bodyA.mass * bodyB.mass) /
          softenedDistance
        : 0,
  };
}

export function calculateSystemDiagnostics(
  bodies: readonly CelestialBody[],
  config: Partial<PhysicsConfig> = {},
): SystemDiagnostics {
  validateBodiesForCalculation(bodies);
  const resolved = resolvePhysicsConfig(config);
  const totalMass = bodies.reduce((sum, body) => sum + body.mass, 0);
  const momentum = systemMomentum(bodies);
  const kineticEnergy = bodies.reduce(
    (sum, body) =>
      sum + 0.5 * body.mass * vectorMagnitudeSquared(body.velocity),
    0,
  );
  let potentialEnergy = 0;

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const distance = distanceBetween(bodies[i].position, bodies[j].position);
      const softenedDistance = Math.sqrt(
        distance * distance + resolved.softening * resolved.softening,
      );
      if (softenedDistance > EPSILON) {
        potentialEnergy -=
          (resolved.gravitationalConstant * bodies[i].mass * bodies[j].mass) /
          softenedDistance;
      }
    }
  }

  const angularMomentum = bodies.reduce(
    (sum, body) =>
      sum +
      body.mass *
        (body.position.x * body.velocity.y -
          body.position.y * body.velocity.x),
    0,
  );

  return {
    centerOfMass: centerOfMass(bodies),
    centerOfMassVelocity:
      totalMass > 0 ? scaleVector(momentum, 1 / totalMass) : { x: 0, y: 0 },
    totalMass,
    momentum,
    angularMomentum,
    kineticEnergy,
    potentialEnergy,
    totalEnergy: kineticEnergy + potentialEnergy,
  };
}

/**
 * Generates sampled future positions without modifying the input state. If the
 * requested horizon would exceed maxSteps, the integration step is enlarged to
 * keep prediction work bounded for interactive use.
 */
export function predictTrajectories(
  state: SimulationState,
  options: PredictionOptions,
): PredictedTrajectory[] {
  assertFinitePositive(options.horizon, "Prediction horizon");
  const requestedStep = options.integrationStep ?? state.config.timeStep;
  const sampleInterval = options.sampleInterval ?? requestedStep;
  const maxSteps = options.maxSteps ?? 20_000;
  assertFinitePositive(requestedStep, "Prediction integration step");
  assertFinitePositive(sampleInterval, "Prediction sample interval");
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError("Prediction maxSteps must be a positive integer.");
  }

  const integrationStep = Math.max(
    requestedStep,
    options.horizon / maxSteps,
  );
  const startTime = state.time;
  let predicted = cloneSimulationState(state);
  if (options.collisionMode) {
    predicted.config.collisionMode = options.collisionMode;
  }

  const trajectories = new Map<string, TrajectoryPoint[]>();
  for (const body of predicted.bodies) trajectories.set(body.id, []);

  const sample = (elapsedTime: number) => {
    for (const body of predicted.bodies) {
      if (!trajectories.has(body.id)) trajectories.set(body.id, []);
      trajectories.get(body.id)?.push({
        time: predicted.time,
        elapsedTime,
        position: { ...body.position },
      });
    }
  };

  if (options.includeInitial ?? true) sample(0);
  let elapsed = 0;
  let nextSample = sampleInterval;

  while (elapsed < options.horizon - EPSILON) {
    const dt = Math.min(integrationStep, options.horizon - elapsed);
    predicted = stepSimulation(predicted, dt);
    elapsed = predicted.time - startTime;

    if (elapsed + EPSILON >= nextSample || elapsed + EPSILON >= options.horizon) {
      sample(elapsed);
      while (nextSample <= elapsed + EPSILON) nextSample += sampleInterval;
    }
  }

  return [...trajectories.entries()].map(([bodyId, points]) => ({
    bodyId,
    points,
  }));
}

interface CollisionDetection {
  endOverlap: boolean;
  timeFraction: number;
}

interface CollisionResolution {
  bodies: CelestialBody[];
  events: CollisionEvent[];
}

interface ElasticCollisionCandidate {
  bodyAIndex: number;
  bodyBIndex: number;
  pairKey: string;
  time: number;
}

function resolveCollisions(
  bodies: CelestialBody[],
  previousPositions: Map<string, Vector2>,
  config: PhysicsConfig,
  deltaTime: number,
  startTime: number,
): CollisionResolution {
  if (config.collisionMode === "pass" || bodies.length < 2) {
    return { bodies, events: [] };
  }

  if (config.collisionMode === "elastic") {
    return resolveElasticCollisions(
      bodies,
      previousPositions,
      config,
      deltaTime,
      startTime,
    );
  }

  return resolveMergeCollisions(
    bodies,
    previousPositions,
    deltaTime,
    startTime,
  );
}

function resolveElasticCollisions(
  suppliedBodies: CelestialBody[],
  previousPositions: Map<string, Vector2>,
  config: PhysicsConfig,
  deltaTime: number,
  startTime: number,
): CollisionResolution {
  // Re-run the drift chronologically from its starting positions. The supplied
  // velocities are already at Verlet's half step, so motion between impacts is
  // linear and can be resolved exactly without changing the integrator.
  const bodies = cloneBodies(suppliedBodies).map((body) => ({
    ...body,
    position: {
      ...(previousPositions.get(body.id) ?? body.position),
    },
  }));
  const events: CollisionEvent[] = [];
  let elapsedTime = 0;
  let remainingTime = deltaTime;
  let resolvedCollisionCount = 0;
  // Degenerate contact piles can otherwise create an unbounded amount of work
  // in one UI tick. Normal systems terminate far below this guard.
  const maxResolvedCollisions = Math.max(64, bodies.length * bodies.length * 2);

  while (
    remainingTime > EPSILON &&
    resolvedCollisionCount < maxResolvedCollisions
  ) {
    const candidate = findEarliestElasticCollision(bodies, remainingTime);
    if (!candidate) {
      advanceBodiesLinearly(bodies, remainingTime);
      elapsedTime += remainingTime;
      remainingTime = 0;
      break;
    }

    const timeToImpact = Math.min(
      remainingTime,
      Math.max(0, candidate.time),
    );
    advanceBodiesLinearly(bodies, timeToImpact);
    elapsedTime += timeToImpact;
    remainingTime = Math.max(0, remainingTime - timeToImpact);

    const bodyA = bodies[candidate.bodyAIndex];
    const bodyB = bodies[candidate.bodyBIndex];
    let normal = normalizeVector(subtractVectors(bodyB.position, bodyA.position));
    if (vectorMagnitudeSquared(normal) <= EPSILON) {
      normal = normalizeVector(
        subtractVectors(
          collisionVelocity(bodyB),
          collisionVelocity(bodyA),
        ),
      );
    }
    if (vectorMagnitudeSquared(normal) <= EPSILON) {
      normal = deterministicCollisionNormal(bodyA.id, bodyB.id);
    }

    const relativeVelocity = subtractVectors(
      collisionVelocity(bodyB),
      collisionVelocity(bodyA),
    );
    const velocityAlongNormal = dotProduct(relativeVelocity, normal);
    const impactSpeed = Math.abs(velocityAlongNormal);
    const inverseMassA = bodyA.fixed ? 0 : 1 / bodyA.mass;
    const inverseMassB = bodyB.fixed ? 0 : 1 / bodyB.mass;
    const inverseMassSum = inverseMassA + inverseMassB;

    if (velocityAlongNormal < 0 && inverseMassSum > 0) {
      const impulseMagnitude =
        (-(1 + config.restitution) * velocityAlongNormal) / inverseMassSum;
      const impulse = scaleVector(normal, impulseMagnitude);
      if (!bodyA.fixed) {
        bodyA.velocity = subtractVectors(
          bodyA.velocity,
          scaleVector(impulse, inverseMassA),
        );
      }
      if (!bodyB.fixed) {
        bodyB.velocity = addVectors(
          bodyB.velocity,
          scaleVector(impulse, inverseMassB),
        );
      }
    }

    separateOverlappingBodies(bodyA, bodyB, normal);
    const [eventBodyAId, eventBodyBId] =
      bodyA.id < bodyB.id
        ? [bodyA.id, bodyB.id]
        : [bodyB.id, bodyA.id];
    events.push({
      mode: "elastic",
      bodyAId: eventBodyAId,
      bodyBId: eventBodyBId,
      impactSpeed,
      time: startTime + elapsedTime,
    });
    resolvedCollisionCount += 1;
  }

  if (remainingTime > 0) {
    advanceBodiesLinearly(bodies, remainingTime);
  }

  return { bodies, events };
}

function findEarliestElasticCollision(
  bodies: readonly CelestialBody[],
  remainingTime: number,
): ElasticCollisionCandidate | null {
  let earliest: ElasticCollisionCandidate | null = null;
  const timeTolerance = Math.max(
    EPSILON,
    remainingTime * Number.EPSILON * 32,
  );

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const bodyA = bodies[i];
      const bodyB = bodies[j];
      if (bodyA.fixed && bodyB.fixed) continue;

      const endA = addVectors(
        bodyA.position,
        scaleVector(collisionVelocity(bodyA), remainingTime),
      );
      const endB = addVectors(
        bodyB.position,
        scaleVector(collisionVelocity(bodyB), remainingTime),
      );
      const collision = detectCollision(
        bodyA,
        bodyB,
        bodyA.position,
        bodyB.position,
        endA,
        endB,
      );
      if (!collision) continue;

      const candidateTime = collision.timeFraction * remainingTime;
      const pairKey = collisionPairKey(bodyA.id, bodyB.id);
      if (
        !earliest ||
        candidateTime < earliest.time - timeTolerance ||
        (Math.abs(candidateTime - earliest.time) <= timeTolerance &&
          pairKey < earliest.pairKey)
      ) {
        earliest = {
          bodyAIndex: i,
          bodyBIndex: j,
          pairKey,
          time: candidateTime,
        };
      }
    }
  }

  return earliest;
}

function advanceBodiesLinearly(bodies: CelestialBody[], duration: number): void {
  if (duration <= 0) return;
  for (const body of bodies) {
    if (!body.fixed) {
      body.position = addVectors(
        body.position,
        scaleVector(body.velocity, duration),
      );
    }
  }
}

function collisionVelocity(body: CelestialBody): Vector2 {
  return body.fixed ? { x: 0, y: 0 } : body.velocity;
}

function collisionPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}\u0000${idB}` : `${idB}\u0000${idA}`;
}

function resolveMergeCollisions(
  suppliedBodies: CelestialBody[],
  previousPositions: Map<string, Vector2>,
  deltaTime: number,
  startTime: number,
): CollisionResolution {
  const bodies = cloneBodies(suppliedBodies);
  const events: CollisionEvent[] = [];
  let mergedInPass = true;

  while (mergedInPass) {
    mergedInPass = false;
    outer: for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const bodyA = bodies[i];
        const bodyB = bodies[j];
        const startA = previousPositions.get(bodyA.id) ?? bodyA.position;
        const startB = previousPositions.get(bodyB.id) ?? bodyB.position;
        const collision = detectCollision(bodyA, bodyB, startA, startB);
        if (!collision) continue;

        const relativeVelocity = subtractVectors(bodyB.velocity, bodyA.velocity);
        const impactSpeed = vectorMagnitude(relativeVelocity);
        const impactA = interpolateVector(
          startA,
          bodyA.position,
          collision.timeFraction,
        );
        const impactB = interpolateVector(
          startB,
          bodyB.position,
          collision.timeFraction,
        );
        const impactCenter = massWeightedPosition(
          impactA,
          bodyA.mass,
          impactB,
          bodyB.mass,
        );
        const mergedVelocity = scaleVector(
          addVectors(
            scaleVector(bodyA.velocity, bodyA.mass),
            scaleVector(bodyB.velocity, bodyB.mass),
          ),
          1 / (bodyA.mass + bodyB.mass),
        );
        const mergedPosition = addVectors(
          impactCenter,
          scaleVector(
            mergedVelocity,
            deltaTime * (1 - collision.timeFraction),
          ),
        );

        const merged = mergeBodies(bodyA, bodyB, mergedPosition);
        const previousMergedPosition = massWeightedPosition(
          startA,
          bodyA.mass,
          startB,
          bodyB.mass,
        );
        previousPositions.set(merged.id, previousMergedPosition);
        bodies.splice(j, 1);
        bodies.splice(i, 1, merged);
        events.push({
          mode: "merge",
          bodyAId: bodyA.id,
          bodyBId: bodyB.id,
          resultBodyId: merged.id,
          impactSpeed,
          time: startTime + deltaTime * collision.timeFraction,
        });
        mergedInPass = true;
        break outer;
      }
    }
  }

  return { bodies, events };
}

function detectCollision(
  bodyA: CelestialBody,
  bodyB: CelestialBody,
  startA: Vector2,
  startB: Vector2,
  endA: Vector2 = bodyA.position,
  endB: Vector2 = bodyB.position,
): CollisionDetection | null {
  const combinedRadius = bodyA.radius + bodyB.radius;
  if (combinedRadius <= 0) return null;
  const combinedRadiusSquared = combinedRadius * combinedRadius;
  const startDisplacement = subtractVectors(startB, startA);
  const endDisplacement = subtractVectors(endB, endA);
  const startDistanceSquared = vectorMagnitudeSquared(startDisplacement);
  const endDistanceSquared = vectorMagnitudeSquared(endDisplacement);
  const relativeTravel = subtractVectors(endDisplacement, startDisplacement);

  if (startDistanceSquared <= combinedRadiusSquared) {
    const startedPenetrating = startDistanceSquared < combinedRadiusSquared;
    const movingInward = dotProduct(startDisplacement, relativeTravel) < 0;

    // Resolve existing penetration immediately. Bodies exactly at contact only
    // collide when moving inward; separating/tangential contact must not create
    // a duplicate impulse on the following step.
    return startedPenetrating || movingInward
      ? { endOverlap: startedPenetrating, timeFraction: 0 }
      : null;
  }

  const a = vectorMagnitudeSquared(relativeTravel);
  if (a <= EPSILON) return null;
  const b = 2 * dotProduct(startDisplacement, relativeTravel);
  const c = vectorMagnitudeSquared(startDisplacement) - combinedRadiusSquared;
  const discriminant = b * b - 4 * a * c;
  if (discriminant >= 0) {
    const firstContact = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (firstContact >= 0 && firstContact <= 1) {
      return { endOverlap: false, timeFraction: firstContact };
    }
  }

  // Fallback for very small penetrations where floating point cancellation can
  // make the quadratic's discriminant slightly negative.
  return endDistanceSquared <= combinedRadiusSquared
    ? { endOverlap: true, timeFraction: 1 }
    : null;
}

function separateOverlappingBodies(
  bodyA: CelestialBody,
  bodyB: CelestialBody,
  normal: Vector2,
): void {
  const distance = distanceBetween(bodyA.position, bodyB.position);
  const penetration = bodyA.radius + bodyB.radius - distance;
  if (penetration <= 0) return;
  const inverseMassA = bodyA.fixed ? 0 : 1 / bodyA.mass;
  const inverseMassB = bodyB.fixed ? 0 : 1 / bodyB.mass;
  const inverseMassSum = inverseMassA + inverseMassB;
  if (inverseMassSum <= 0) return;
  const coordinateScale = Math.max(
    bodyA.radius + bodyB.radius,
    Math.abs(bodyA.position.x),
    Math.abs(bodyA.position.y),
    Math.abs(bodyB.position.x),
    Math.abs(bodyB.position.y),
  );
  const separationPadding = Math.max(
    1e-6,
    coordinateScale * Number.EPSILON * 16,
  );
  const correction = scaleVector(normal, penetration + separationPadding);

  if (!bodyA.fixed) {
    bodyA.position = subtractVectors(
      bodyA.position,
      scaleVector(correction, inverseMassA / inverseMassSum),
    );
  }
  if (!bodyB.fixed) {
    bodyB.position = addVectors(
      bodyB.position,
      scaleVector(correction, inverseMassB / inverseMassSum),
    );
  }
}

function mergeBodies(
  bodyA: CelestialBody,
  bodyB: CelestialBody,
  suppliedPosition?: Vector2,
): CelestialBody {
  const primary = bodyA.mass >= bodyB.mass ? bodyA : bodyB;
  const totalMass = bodyA.mass + bodyB.mass;
  const radius = Math.cbrt(bodyA.radius ** 3 + bodyB.radius ** 3);
  const volume = (4 / 3) * Math.PI * radius ** 3;
  const fixed = bodyA.fixed || bodyB.fixed;
  const momentumVelocity = scaleVector(
    addVectors(
      scaleVector(bodyA.velocity, bodyA.mass),
      scaleVector(bodyB.velocity, bodyB.mass),
    ),
    1 / totalMass,
  );
  const fixedBody = bodyA.fixed ? bodyA : bodyB.fixed ? bodyB : undefined;

  return {
    id: primary.id,
    name: primary.name,
    mass: totalMass,
    radius,
    position: fixedBody
      ? { ...fixedBody.position }
      : suppliedPosition
        ? { ...suppliedPosition }
        : massWeightedPosition(
            bodyA.position,
            bodyA.mass,
            bodyB.position,
            bodyB.mass,
          ),
    velocity: momentumVelocity,
    acceleration: { x: 0, y: 0 },
    fixed,
    density: volume > 0 ? totalMass / volume : undefined,
    trailVisible: bodyA.trailVisible || bodyB.trailVisible,
  };
}

function massWeightedPosition(
  positionA: Vector2,
  massA: number,
  positionB: Vector2,
  massB: number,
): Vector2 {
  const totalMass = massA + massB;
  return {
    x: (positionA.x * massA + positionB.x * massB) / totalMass,
    y: (positionA.y * massA + positionB.y * massB) / totalMass,
  };
}

function interpolateVector(a: Vector2, b: Vector2, amount: number): Vector2 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  };
}

function deterministicCollisionNormal(idA: string, idB: string): Vector2 {
  let hash = 2166136261;
  const forward = idA < idB;
  const key = collisionPairKey(idA, idB);
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
  const normal = { x: Math.cos(angle), y: Math.sin(angle) };
  return forward ? normal : scaleVector(normal, -1);
}

function validateBodiesForCalculation(
  bodies: readonly CelestialBody[],
): void {
  for (const body of bodies) validateBody(body);
}

function validateUniqueIds(bodies: readonly CelestialBody[]): void {
  const ids = new Set<string>();
  for (const body of bodies) {
    if (ids.has(body.id)) throw new Error(`Duplicate body id: ${body.id}`);
    ids.add(body.id);
  }
}

function assertFiniteVector(value: Vector2, label: string): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new RangeError(`${label} must contain finite coordinates.`);
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
}
