import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSimulation,
  calculateBodyDynamics,
  calculatePairwiseForces,
  calculateSystemDiagnostics,
  cloneSimulationState,
  createBody,
  createSimulationState,
  forceVectorsOnBody,
  predictTrajectories,
  simulateDuration,
  stepSimulation,
} from "../lib/physics.ts";

const body = (overrides) =>
  createBody({
    id: "body",
    name: "BODY",
    mass: 1,
    radius: 0,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    ...overrides,
  });

test("duration simulation drops excess work at its substep safety limit", () => {
  const state = createSimulationState([body({ id: "solo" })], {
    gravitationalConstant: 0,
    timeStep: 0.1,
  });
  const result = simulateDuration(state, 10, 0.1, 3);

  assert.equal(result.state.tick, 3);
  assert.ok(Math.abs(result.state.time - 0.3) < 1e-12);
});

test("elastic contact piles stay inside the per-step collision budget", () => {
  const bodies = Array.from({ length: 32 }, (_, index) => body({
    id: `pile-${index}`,
    radius: 1,
    position: { x: 0, y: 0 },
  }));
  const state = createSimulationState(bodies, {
    gravitationalConstant: 0,
    timeStep: 1,
    collisionMode: "elastic",
  });
  const result = advanceSimulation(state, 1);

  assert.ok(result.collisions.length <= 16);
  assert.equal(result.state.bodies.length, bodies.length);
  for (const candidate of result.state.bodies) {
    assert.ok(Number.isFinite(candidate.position.x));
    assert.ok(Number.isFinite(candidate.position.y));
  }
});

test("pairwise gravity is symmetric and has the expected magnitude", () => {
  const bodyA = body({ id: "a", mass: 5e10 });
  const bodyB = body({
    id: "b",
    mass: 7e10,
    position: { x: 10, y: 0 },
  });
  const dynamics = calculateBodyDynamics([bodyA, bodyB], {
    gravitationalConstant: 1,
    softening: 0,
  });

  assert.equal(dynamics[0].acceleration.x, 7e8);
  assert.equal(dynamics[1].acceleration.x, -5e8);
  assert.equal(
    dynamics[0].netForce.x + dynamics[1].netForce.x,
    0,
  );
});

test("selected-body force vectors match the complete pairwise calculation", () => {
  const bodies = [
    body({ id: "a", mass: 5, position: { x: -3, y: 1 } }),
    body({ id: "b", mass: 7, position: { x: 4, y: -2 } }),
    body({ id: "c", mass: 11, position: { x: 1, y: 8 } }),
  ];
  const config = { gravitationalConstant: 2, softening: 0.5 };
  const selectedForces = forceVectorsOnBody(bodies, "b", config);
  const pairwise = calculatePairwiseForces(bodies, config);

  assert.equal(selectedForces.length, 2);
  for (const force of selectedForces) {
    const pair = pairwise.find((candidate) =>
      (candidate.bodyAId === force.sourceBodyId && candidate.bodyBId === force.attractingBodyId) ||
      (candidate.bodyBId === force.sourceBodyId && candidate.bodyAId === force.attractingBodyId));
    assert.ok(pair);
    const expected = pair.bodyAId === force.sourceBodyId ? pair.forceOnA : pair.forceOnB;
    assert.deepEqual(force.vector, expected);
    assert.equal(force.magnitude, pair.magnitude);
  }
});

test("trajectory prediction stays bounded when absolute simulation time cannot advance", () => {
  const state = createSimulationState([
    body({ id: "a", position: { x: -1, y: 0 }, velocity: { x: 1, y: 0 } }),
    body({ id: "b", position: { x: 1, y: 0 }, velocity: { x: -1, y: 0 } }),
  ], {
    gravitationalConstant: 0,
    timeStep: 0.01,
    collisionMode: "pass",
  });
  state.time = 1e30;

  const predictions = predictTrajectories(state, {
    horizon: 1,
    integrationStep: 0.01,
    sampleInterval: 0.25,
    maxSteps: 100,
  });

  assert.equal(predictions.length, 2);
  for (const trajectory of predictions) {
    assert.ok(trajectory.points.length >= 4);
    assert.ok(trajectory.points.length <= 6);
    assert.ok(trajectory.points.at(-1).elapsedTime >= 1 - 1e-10);
  }
});

test("trajectory prediction always samples its non-binary horizon at the step cap", () => {
  const horizon = 20_796.03564164516;
  const state = createSimulationState([
    body({ id: "a", position: { x: -1, y: 0 }, velocity: { x: 1, y: 0 } }),
    body({ id: "b", position: { x: 1, y: 0 }, velocity: { x: -1, y: 0 } }),
  ], {
    gravitationalConstant: 0,
    timeStep: 0.001,
    collisionMode: "pass",
  });

  const predictions = predictTrajectories(state, {
    horizon,
    integrationStep: 0.001,
    sampleInterval: horizon * 2,
    maxSteps: 275,
  });

  for (const trajectory of predictions) {
    assert.equal(trajectory.points.length, 2);
    assert.equal(trajectory.points.at(-1).elapsedTime, horizon);
  }
});

test("velocity Verlet keeps a circular orbit bounded", () => {
  const central = body({
    id: "central",
    mass: 1_000,
    fixed: true,
  });
  const orbiter = body({
    id: "orbiter",
    mass: 1,
    position: { x: 100, y: 0 },
    velocity: { x: 0, y: Math.sqrt(10) },
  });
  let state = createSimulationState([central, orbiter], {
    gravitationalConstant: 1,
    timeStep: 0.02,
    softening: 0,
    collisionMode: "pass",
  });
  const initialEnergy = calculateSystemDiagnostics(
    state.bodies,
    state.config,
  ).totalEnergy;

  for (let index = 0; index < 10_000; index += 1) {
    state = stepSimulation(state);
  }

  const finalOrbiter = state.bodies.find((candidate) => candidate.id === "orbiter");
  assert.ok(finalOrbiter);
  assert.ok(Math.abs(Math.hypot(finalOrbiter.position.x, finalOrbiter.position.y) - 100) < 0.01);
  const finalEnergy = calculateSystemDiagnostics(
    state.bodies,
    state.config,
  ).totalEnergy;
  assert.ok(Math.abs((finalEnergy - initialEnergy) / initialEnergy) < 1e-7);
});

test("merge collisions preserve mass, momentum, and combined volume", () => {
  const state = createSimulationState(
    [
      body({
        id: "a",
        mass: 2,
        radius: 1,
        position: { x: -2, y: 0 },
        velocity: { x: 10, y: 0 },
      }),
      body({
        id: "b",
        mass: 3,
        radius: 2,
        position: { x: 3, y: 0 },
        velocity: { x: -10, y: 0 },
      }),
    ],
    {
      gravitationalConstant: 0,
      timeStep: 0.2,
      softening: 0,
      collisionMode: "merge",
    },
  );
  const result = advanceSimulation(state);

  assert.equal(result.collisions.length, 1);
  assert.equal(result.state.bodies.length, 1);
  assert.equal(result.state.bodies[0].mass, 5);
  assert.ok(Math.abs(result.state.bodies[0].velocity.x + 2) < 1e-12);
  assert.ok(
    Math.abs(result.state.bodies[0].radius - Math.cbrt(9)) < 1e-12,
  );
});

test("swept elastic collisions do not tunnel and exchange equal-mass velocity", () => {
  const state = createSimulationState(
    [
      body({
        id: "a",
        radius: 1,
        position: { x: -2, y: 0 },
        velocity: { x: 10, y: 0 },
      }),
      body({
        id: "b",
        radius: 1,
        position: { x: 2, y: 0 },
        velocity: { x: -10, y: 0 },
      }),
    ],
    {
      gravitationalConstant: 0,
      timeStep: 0.2,
      softening: 0,
      collisionMode: "elastic",
      restitution: 1,
    },
  );
  const result = advanceSimulation(state);
  const nextA = result.state.bodies.find((candidate) => candidate.id === "a");
  const nextB = result.state.bodies.find((candidate) => candidate.id === "b");

  assert.equal(result.collisions.length, 1);
  assert.equal(nextA?.velocity.x, -10);
  assert.equal(nextB?.velocity.x, 10);
  assert.ok((nextA?.position.x ?? 0) < (nextB?.position.x ?? 0));
});

test("state cloning has no shared mutable vectors", () => {
  const state = createSimulationState([body({ id: "a" }), body({ id: "b" })]);
  const clone = cloneSimulationState(state);
  clone.bodies[0].position.x = 42;
  clone.bodies[0].velocity.y = 17;
  clone.config.softening = 99;

  assert.equal(state.bodies[0].position.x, 0);
  assert.equal(state.bodies[0].velocity.y, 0);
  assert.notEqual(state.config.softening, 99);
});
