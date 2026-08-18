import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSimulation,
  calculateBodyDynamics,
  calculateSystemDiagnostics,
  cloneSimulationState,
  createBody,
  createSimulationState,
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
