import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The app intentionally uses bundler-style extensionless imports. Teach the
// Node test runner how to resolve the one local TypeScript dependency used by
// presets.ts without introducing a test-only runtime dependency.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./physics") {
      return nextResolve("./physics.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  advanceSimulation,
  calculateSystemDiagnostics,
  createBody,
  createSimulationState,
  distanceBetween,
  stepSimulation,
  systemMomentum,
} = await import("../lib/physics.ts");

const {
  ASTRONOMICAL_UNIT,
  EARTH_MOON_DISTANCE,
  PRESETS,
  createPresetState,
  createRandomPreset,
} = await import("../lib/presets.ts");

const makeBody = (overrides) =>
  createBody({
    id: "body",
    name: "BODY",
    mass: 1,
    radius: 1,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    ...overrides,
  });

const approximatelyEqual = (actual, expected, relativeTolerance = 1e-12) => {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= scale * relativeTolerance,
    `expected ${actual} to be within ${relativeTolerance} relative error of ${expected}`,
  );
};

test("an unequal-mass elastic impact conserves linear momentum and kinetic energy", () => {
  const state = createSimulationState(
    [
      makeBody({
        id: "a",
        mass: 2,
        position: { x: -3, y: -0.5 },
        velocity: { x: 4, y: 2 / 3 },
      }),
      makeBody({
        id: "b",
        mass: 3,
        position: { x: 3, y: 0.5 },
        velocity: { x: -2, y: -1 / 3 },
      }),
    ],
    {
      gravitationalConstant: 0,
      timeStep: 1,
      softening: 0,
      collisionMode: "elastic",
      restitution: 1,
    },
  );
  const initialMomentum = systemMomentum(state.bodies);
  const initialEnergy = calculateSystemDiagnostics(
    state.bodies,
    state.config,
  ).kineticEnergy;

  const result = advanceSimulation(state);
  const finalMomentum = systemMomentum(result.state.bodies);
  const finalEnergy = calculateSystemDiagnostics(
    result.state.bodies,
    result.state.config,
  ).kineticEnergy;

  assert.equal(result.collisions.length, 1);
  approximatelyEqual(finalMomentum.x, initialMomentum.x);
  approximatelyEqual(finalMomentum.y, initialMomentum.y);
  approximatelyEqual(finalEnergy, initialEnergy);
});

test("elastic bodies that begin touching cannot tunnel through each other", () => {
  const state = createSimulationState(
    [
      makeBody({
        id: "a",
        position: { x: -1, y: 0 },
        velocity: { x: 10, y: 0 },
      }),
      makeBody({
        id: "b",
        position: { x: 1, y: 0 },
        velocity: { x: -10, y: 0 },
      }),
    ],
    {
      gravitationalConstant: 0,
      timeStep: 0.3,
      softening: 0,
      collisionMode: "elastic",
      restitution: 1,
    },
  );

  const result = advanceSimulation(state);
  const bodyA = result.state.bodies.find((body) => body.id === "a");
  const bodyB = result.state.bodies.find((body) => body.id === "b");

  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].time, 0);
  assert.equal(bodyA?.velocity.x, -10);
  assert.equal(bodyB?.velocity.x, 10);
  assert.ok((bodyA?.position.x ?? Infinity) < (bodyB?.position.x ?? -Infinity));
});

test("chronological elastic resolution is independent of body array order", () => {
  const runCradle = (order) => {
    const definitions = {
      a: makeBody({
        id: "a",
        position: { x: -4, y: 0 },
        velocity: { x: 10, y: 0 },
      }),
      b: makeBody({ id: "b", position: { x: 0, y: 0 } }),
      c: makeBody({ id: "c", position: { x: 4, y: 0 } }),
    };
    const state = createSimulationState(
      order.map((id) => definitions[id]),
      {
        gravitationalConstant: 0,
        timeStep: 0.4,
        softening: 0,
        collisionMode: "elastic",
        restitution: 1,
      },
    );
    const result = advanceSimulation(state);
    return {
      collisions: result.collisions,
      bodies: Object.fromEntries(
        result.state.bodies.map((body) => [
          body.id,
          {
            position: body.position,
            velocity: body.velocity,
          },
        ]),
      ),
    };
  };

  const forward = runCradle(["a", "b", "c"]);
  const reverse = runCradle(["c", "b", "a"]);

  assert.equal(forward.collisions.length, 2);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.bodies.a.velocity.x, 0);
  assert.equal(forward.bodies.b.velocity.x, 0);
  assert.equal(forward.bodies.c.velocity.x, 10);
});

test("a swept merge conserves mass, linear momentum, and combined volume", () => {
  const first = makeBody({
    id: "first",
    mass: 2,
    radius: 2,
    position: { x: -5, y: 0 },
    velocity: { x: 8, y: 1 },
  });
  const second = makeBody({
    id: "second",
    mass: 5,
    radius: 3,
    position: { x: 5, y: 0 },
    velocity: { x: -4, y: 1 },
  });
  const state = createSimulationState([first, second], {
    gravitationalConstant: 0,
    timeStep: 1,
    softening: 0,
    collisionMode: "merge",
  });
  const initialMomentum = systemMomentum(state.bodies);

  const result = advanceSimulation(state);
  const merged = result.state.bodies[0];

  assert.equal(result.collisions.length, 1);
  assert.equal(result.state.bodies.length, 1);
  assert.equal(merged.mass, first.mass + second.mass);
  approximatelyEqual(merged.mass * merged.velocity.x, initialMomentum.x);
  approximatelyEqual(merged.mass * merged.velocity.y, initialMomentum.y);
  approximatelyEqual(
    merged.radius ** 3,
    first.radius ** 3 + second.radius ** 3,
  );
});

test("merging into a fixed body preserves the fixed anchor position", () => {
  const state = createSimulationState(
    [
      makeBody({
        id: "anchor",
        mass: 100,
        fixed: true,
        position: { x: 0, y: 0 },
      }),
      makeBody({
        id: "impactor",
        position: { x: 4, y: 0 },
        velocity: { x: -10, y: 0 },
      }),
    ],
    {
      gravitationalConstant: 0,
      timeStep: 0.5,
      softening: 0,
      collisionMode: "merge",
    },
  );

  const result = advanceSimulation(state);
  assert.equal(result.collisions.length, 1);
  assert.equal(result.state.bodies.length, 1);
  assert.equal(result.state.bodies[0].fixed, true);
  assert.deepEqual(result.state.bodies[0].position, { x: 0, y: 0 });
});

test("every built-in preset is internally valid and independently cloneable", () => {
  for (const preset of PRESETS) {
    assert.ok(preset.bodies.length >= 2, `${preset.id} needs at least two bodies`);
    assert.ok(
      preset.bodies.some((body) => body.id === preset.focusBodyId),
      `${preset.id} has an invalid focus body`,
    );
    assert.ok(Number.isFinite(preset.viewRadius) && preset.viewRadius > 0);

    const ids = new Set(preset.bodies.map((body) => body.id));
    assert.equal(ids.size, preset.bodies.length, `${preset.id} has duplicate ids`);

    for (const body of preset.bodies) {
      assert.ok(
        Math.abs(body.position.x) + body.radius < preset.viewRadius,
        `${preset.id} places ${body.id} outside its horizontal opening view`,
      );
      assert.ok(
        Math.abs(body.position.y) + body.radius < preset.viewRadius,
        `${preset.id} places ${body.id} outside its vertical opening view`,
      );
    }

    for (let i = 0; i < preset.bodies.length; i += 1) {
      for (let j = i + 1; j < preset.bodies.length; j += 1) {
        const a = preset.bodies[i];
        const b = preset.bodies[j];
        assert.ok(
          distanceBetween(a.position, b.position) > a.radius + b.radius,
          `${preset.id} begins with ${a.id} overlapping ${b.id}`,
        );
      }
    }
  }

  const first = createPresetState("earth-moon");
  const second = createPresetState("earth-moon");
  first.bodies[0].position.x = 123;
  first.config.softening = 456;
  assert.notEqual(second.bodies[0].position.x, 123);
  assert.notEqual(second.config.softening, 456);
});

test("random presets are reproducible without sharing mutable body vectors", () => {
  const first = createRandomPreset("orbital-seed", 10);
  const second = createRandomPreset("orbital-seed", 10);

  assert.deepEqual(first, second);
  first.bodies[0].position.x = 99;
  assert.notEqual(second.bodies[0].position.x, 99);
});

test("the opening Sun-Earth-Moon preset remains bound and collision-free", () => {
  let state = createPresetState("sun-earth-moon");
  let earthSunMinimum = Infinity;
  let earthSunMaximum = 0;
  let earthMoonMinimum = Infinity;
  let earthMoonMaximum = 0;

  // Sixty simulated days covers more than two lunar orbits while remaining a
  // quick deterministic regression test on the project's supported Node 22.
  for (let step = 0; step < 60 * 48; step += 1) {
    const result = advanceSimulation(state);
    state = result.state;
    assert.equal(result.collisions.length, 0);

    const sun = state.bodies.find((body) => body.id === "sun");
    const earth = state.bodies.find((body) => body.id === "earth");
    const moon = state.bodies.find((body) => body.id === "moon");
    assert.ok(sun && earth && moon);

    const earthSunDistance = distanceBetween(sun.position, earth.position);
    const earthMoonDistance = distanceBetween(earth.position, moon.position);
    earthSunMinimum = Math.min(earthSunMinimum, earthSunDistance);
    earthSunMaximum = Math.max(earthSunMaximum, earthSunDistance);
    earthMoonMinimum = Math.min(earthMoonMinimum, earthMoonDistance);
    earthMoonMaximum = Math.max(earthMoonMaximum, earthMoonDistance);
  }

  assert.ok(earthSunMinimum > ASTRONOMICAL_UNIT * 0.995);
  assert.ok(earthSunMaximum < ASTRONOMICAL_UNIT * 1.005);
  assert.ok(earthMoonMinimum > EARTH_MOON_DISTANCE * 0.9);
  assert.ok(earthMoonMaximum < EARTH_MOON_DISTANCE * 1.1);
});

test("velocity Verlet keeps a softened fixed-anchor orbit bounded", () => {
  const anchor = makeBody({
    id: "anchor",
    mass: 1_000,
    radius: 0,
    fixed: true,
  });
  const radius = 100;
  const softening = 2;
  const acceleration =
    (1_000 * radius) / (radius * radius + softening * softening) ** 1.5;
  const orbiter = makeBody({
    id: "orbiter",
    radius: 0,
    position: { x: radius, y: 0 },
    velocity: { x: 0, y: Math.sqrt(acceleration * radius) },
  });
  let state = createSimulationState([anchor, orbiter], {
    gravitationalConstant: 1,
    timeStep: 0.02,
    softening,
    collisionMode: "pass",
  });

  for (let step = 0; step < 10_000; step += 1) {
    state = stepSimulation(state);
  }

  const finalOrbiter = state.bodies.find((body) => body.id === "orbiter");
  assert.ok(finalOrbiter);
  assert.ok(
    Math.abs(distanceBetween(anchor.position, finalOrbiter.position) - radius) <
      0.01,
  );
});
