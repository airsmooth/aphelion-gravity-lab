"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MiniPlot } from "@/components/MiniPlot";
import {
  calculateBodyDynamics,
  calculatePairMetrics,
  calculateSystemDiagnostics,
  cloneSimulationState,
  createBody,
  createSimulationState,
  forceVectorsOnBody,
  getReferenceFrameTransform,
  predictTrajectories,
  refreshAccelerations,
  simulateDuration,
  stepSimulation,
  type CelestialBody,
  type CollisionMode,
  type ReferenceFrame,
  type SimulationState,
} from "@/lib/physics";
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  createRandomPreset,
  getPreset,
  type BuiltInPresetId,
  type SimulationPreset,
} from "@/lib/presets";
import {
  formatAcceleration,
  formatDistance,
  formatDuration,
  formatMass,
  formatScientific,
  formatVelocity,
  magnitude,
} from "@/lib/format";
import UniverseCanvas, {
  type BodyTrail,
  type UniverseCamera,
  type UniverseDisplayOptions,
} from "./UniverseCanvas";

const TIME_SCALE_OPTIONS = [0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
const SIMULATED_SECONDS_PER_REAL_SECOND = 86_400;
const MAX_HISTORY = 96;

type InspectorTab = "object" | "analysis";
type ReferenceFrameMode = "inertial" | "center-of-mass" | "selected-body";

interface DisplayState {
  grid: boolean;
  trails: boolean;
  vectors: boolean;
  gravityField: boolean;
  predictions: boolean;
  labels: boolean;
}

interface HistorySample {
  distance: number;
  speed: number;
  kinetic: number;
  potential: number;
  total: number;
}

const initialPreset = getPreset(DEFAULT_PRESET_ID);
const initialSimulation = createSimulationState(initialPreset.bodies, initialPreset.config);

function cameraForPreset(preset: SimulationPreset): UniverseCamera {
  return {
    center: { x: 0, y: 0 },
    pixelsPerMeter: 430 / Math.max(1, preset.viewRadius),
  };
}

function initialTrails(bodies: readonly CelestialBody[]): BodyTrail[] {
  return bodies
    .filter((body) => body.trailVisible)
    .map((body) => ({ bodyId: body.id, points: [{ ...body.position }] }));
}

export default function GravityLab() {
  const [simulation, setSimulation] = useState<SimulationState>(() => cloneSimulationState(initialSimulation));
  const simulationRef = useRef(simulation);
  const resetStateRef = useRef(cloneSimulationState(initialSimulation));
  const [activePresetId, setActivePresetId] = useState<BuiltInPresetId>(DEFAULT_PRESET_ID);
  const [presetDescription, setPresetDescription] = useState(initialPreset.description);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(initialPreset.focusBodyId);
  const [analysisBodyId, setAnalysisBodyId] = useState<string | null>(initialPreset.bodies[0]?.id ?? null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("object");
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState<(typeof TIME_SCALE_OPTIONS)[number]>(1);
  const [fps, setFps] = useState(60);
  const [display, setDisplay] = useState<DisplayState>({
    grid: true,
    trails: true,
    vectors: true,
    gravityField: false,
    predictions: true,
    labels: true,
  });
  const [camera, setCamera] = useState<UniverseCamera>(() => cameraForPreset(initialPreset));
  const [trails, setTrails] = useState<BodyTrail[]>(() => initialTrails(initialSimulation.bodies));
  const [trailLength, setTrailLength] = useState(280);
  const [trailSamplingInterval, setTrailSamplingInterval] = useState(initialSimulation.config.timeStep * 8);
  const [gravityFieldDensity, setGravityFieldDensity] = useState(62);
  const [vectorScale, setVectorScale] = useState(1);
  const [predictionHorizonDays, setPredictionHorizonDays] = useState(36);
  const [referenceFrameMode, setReferenceFrameMode] = useState<ReferenceFrameMode>("inertial");
  const [predictionSource, setPredictionSource] = useState(() => cloneSimulationState(initialSimulation));
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const lastTrailTimeRef = useRef(initialSimulation.time);
  const bodySequenceRef = useRef(initialSimulation.bodies.length + 1);

  const selectedBody = simulation.bodies.find((body) => body.id === selectedBodyId) ?? null;
  const comparisonBody = simulation.bodies.find((body) => body.id === analysisBodyId) ?? null;

  const referenceFrame = useMemo<ReferenceFrame>(() => {
    if (referenceFrameMode === "center-of-mass") return { type: "center-of-mass" };
    if (referenceFrameMode === "selected-body" && selectedBodyId) {
      return { type: "selected-body", bodyId: selectedBodyId };
    }
    return { type: "inertial" };
  }, [referenceFrameMode, selectedBodyId]);

  const frameTransform = useMemo(() => {
    try {
      return getReferenceFrameTransform(simulation.bodies, referenceFrame);
    } catch {
      return { origin: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    }
  }, [referenceFrame, simulation.bodies]);

  const dynamics = useMemo(
    () => calculateBodyDynamics(simulation.bodies, simulation.config),
    [simulation.bodies, simulation.config],
  );

  const selectedForces = useMemo(() => {
    if (!selectedBodyId || !simulation.bodies.some((body) => body.id === selectedBodyId)) return [];
    return forceVectorsOnBody(simulation.bodies, selectedBodyId, simulation.config);
  }, [selectedBodyId, simulation.bodies, simulation.config]);

  const pairMetrics = useMemo(() => {
    if (!selectedBody || !comparisonBody || selectedBody.id === comparisonBody.id) return null;
    return calculatePairMetrics(selectedBody, comparisonBody, simulation.config);
  }, [comparisonBody, selectedBody, simulation.config]);

  const diagnostics = useMemo(
    () => calculateSystemDiagnostics(simulation.bodies, simulation.config),
    [simulation.bodies, simulation.config],
  );

  const predictions = useMemo(() => {
    if (!display.predictions || predictionSource.bodies.length < 2) return [];
    const horizon = Math.max(0.02, predictionHorizonDays) * 86_400;
    return predictTrajectories(predictionSource, {
      horizon,
      integrationStep: Math.max(predictionSource.config.timeStep, horizon / 220),
      sampleInterval: Math.max(predictionSource.config.timeStep, horizon / 90),
      maxSteps: 240,
      collisionMode: "pass",
    });
  }, [display.predictions, predictionHorizonDays, predictionSource]);

  const openingInset = useMemo(() => {
    if (activePresetId !== "sun-earth-moon") return null;
    const earth = simulation.bodies.find((body) => body.id === "earth");
    const moon = simulation.bodies.find((body) => body.id === "moon");
    if (!earth || !moon) return null;
    const relative = {
      x: moon.position.x - earth.position.x,
      y: moon.position.y - earth.position.y,
    };
    const distance = Math.max(1, Math.hypot(relative.x, relative.y));
    const earthTrail = trails.find((trail) => trail.bodyId === earth.id)?.points ?? [];
    const moonTrail = trails.find((trail) => trail.bodyId === moon.id)?.points ?? [];
    const pointCount = Math.min(earthTrail.length, moonTrail.length);
    const relativeTrail = Array.from({ length: pointCount }, (_, index) => {
      const earthPoint = earthTrail[earthTrail.length - pointCount + index];
      const moonPoint = moonTrail[moonTrail.length - pointCount + index];
      return { x: moonPoint.x - earthPoint.x, y: moonPoint.y - earthPoint.y };
    });
    return {
      bodies: [
        { ...earth, fixed: true, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } },
        {
          ...moon,
          position: relative,
          velocity: { x: moon.velocity.x - earth.velocity.x, y: moon.velocity.y - earth.velocity.y },
        },
      ],
      trails: [
        { bodyId: earth.id, points: relativeTrail.map(() => ({ x: 0, y: 0 })) },
        { bodyId: moon.id, points: relativeTrail },
      ],
      camera: { center: { x: 0, y: 0 }, pixelsPerMeter: 88 / distance },
    };
  }, [activePresetId, simulation.bodies, trails]);

  function commitSimulation(nextState: SimulationState, refreshPrediction = false) {
    simulationRef.current = nextState;
    setSimulation(nextState);
    if (refreshPrediction) setPredictionSource(cloneSimulationState(nextState));
  }

  const appendTrailSample = useCallback((nextState: SimulationState, force = false) => {
    if (!force && nextState.time - lastTrailTimeRef.current < trailSamplingInterval) return;
    lastTrailTimeRef.current = nextState.time;
    setTrails((current) => {
      const existing = new Map(current.map((trail) => [trail.bodyId, trail.points]));
      return nextState.bodies
        .filter((body) => body.trailVisible)
        .map((body) => ({
          bodyId: body.id,
          points: [...(existing.get(body.id) ?? []), { ...body.position }].slice(-trailLength),
        }));
    });
  }, [trailLength, trailSamplingInterval]);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let lastHudUpdate = previous;
    let lastHistoryUpdate = previous;
    let lastPredictionUpdate = previous;
    let smoothedFps = 60;

    const animate = (now: number) => {
      const realDelta = Math.min(0.05, Math.max(0, (now - previous) / 1_000));
      previous = now;
      if (realDelta > 0) smoothedFps += ((1 / realDelta) - smoothedFps) * 0.08;

      if (!paused && realDelta > 0) {
        const current = simulationRef.current;
        const duration = realDelta * SIMULATED_SECONDS_PER_REAL_SECOND * timeScale;
        const next = simulateDuration(current, duration, current.config.timeStep).state;
        simulationRef.current = next;
        setSimulation(next);
        appendTrailSample(next);

        if (selectedBodyId && !next.bodies.some((body) => body.id === selectedBodyId)) {
          const fallbackId = next.bodies[0]?.id ?? null;
          setSelectedBodyId(fallbackId);
          setAnalysisBodyId(next.bodies.find((body) => body.id !== fallbackId)?.id ?? null);
        } else if (
          !analysisBodyId ||
          analysisBodyId === selectedBodyId ||
          !next.bodies.some((body) => body.id === analysisBodyId)
        ) {
          setAnalysisBodyId(next.bodies.find((body) => body.id !== selectedBodyId)?.id ?? null);
        }

        if (now - lastHistoryUpdate >= 550) {
          lastHistoryUpdate = now;
          const system = calculateSystemDiagnostics(next.bodies, next.config);
          const primary = next.bodies.find((body) => body.id === selectedBodyId);
          const secondary = next.bodies.find((body) => body.id === analysisBodyId);
          const pair = primary && secondary && primary.id !== secondary.id
            ? calculatePairMetrics(primary, secondary, next.config)
            : null;
          setHistory((currentHistory) => [...currentHistory, {
            distance: pair?.distance ?? 0,
            speed: pair?.relativeSpeed ?? 0,
            kinetic: system.kineticEnergy,
            potential: system.potentialEnergy,
            total: system.totalEnergy,
          }].slice(-MAX_HISTORY));
        }

        if (now - lastPredictionUpdate >= 1_200) {
          lastPredictionUpdate = now;
          setPredictionSource(cloneSimulationState(next));
        }
      }

      if (now - lastHudUpdate >= 450) {
        lastHudUpdate = now;
        setFps(Math.round(smoothedFps));
      }
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [analysisBodyId, appendTrailSample, paused, selectedBodyId, timeScale]);

  function loadPreset(id: BuiltInPresetId) {
    const preset = id === "random-system"
      ? createRandomPreset(Math.floor(Date.now() % 4_294_967_295), 7)
      : getPreset(id);
    const next = createSimulationState(preset.bodies, preset.config);
    resetStateRef.current = cloneSimulationState(next);
    lastTrailTimeRef.current = next.time;
    setActivePresetId(id);
    setPresetDescription(preset.description);
    setSelectedBodyId(preset.focusBodyId);
    setAnalysisBodyId(preset.bodies.find((body) => body.id !== preset.focusBodyId)?.id ?? null);
    setCamera(cameraForPreset(preset));
    setTrails(initialTrails(next.bodies));
    setTrailSamplingInterval(Math.max(1, next.config.timeStep * 8));
    setHistory([]);
    setPaused(false);
    commitSimulation(next, true);
  }

  function resetSimulation() {
    const next = cloneSimulationState(resetStateRef.current);
    lastTrailTimeRef.current = next.time;
    setTrails(initialTrails(next.bodies));
    setHistory([]);
    setPaused(false);
    commitSimulation(next, true);
  }

  function updateBody(bodyId: string, updater: (body: CelestialBody) => CelestialBody) {
    const current = simulationRef.current;
    const next = refreshAccelerations({
      ...current,
      bodies: current.bodies.map((body) => body.id === bodyId ? updater(body) : body),
    });
    commitSimulation(next, true);
  }

  function patchSelected(patch: Partial<CelestialBody>) {
    if (!selectedBodyId) return;
    updateBody(selectedBodyId, (body) => ({
      ...body,
      ...patch,
      position: patch.position ? { ...patch.position } : body.position,
      velocity: patch.velocity ? { ...patch.velocity } : body.velocity,
      acceleration: patch.acceleration ? { ...patch.acceleration } : body.acceleration,
    }));
  }

  function updateConfig(patch: Partial<SimulationState["config"]>) {
    const current = simulationRef.current;
    const next = refreshAccelerations({ ...current, config: { ...current.config, ...patch } });
    commitSimulation(next, true);
  }

  function addBody() {
    const current = simulationRef.current;
    const anchor = selectedBody ?? current.bodies[0];
    const viewOffset = Math.max(anchor?.radius ? anchor.radius * 12 : 0, 30 / camera.pixelsPerMeter);
    const id = `body-${bodySequenceRef.current++}-${Date.now().toString(36)}`;
    const dominantMass = anchor?.mass ?? 5.9722e24;
    const orbitalSpeed = Math.sqrt(
      Math.max(0, current.config.gravitationalConstant * dominantMass / Math.max(viewOffset, 1)),
    );
    const body = createBody({
      id,
      name: `OBJECT ${String(current.bodies.length + 1).padStart(2, "0")}`,
      mass: 5.9722e24,
      radius: 6_371_000,
      density: 5_514,
      position: {
        x: (anchor?.position.x ?? camera.center.x) + viewOffset,
        y: anchor?.position.y ?? camera.center.y,
      },
      velocity: {
        x: anchor?.velocity.x ?? 0,
        y: (anchor?.velocity.y ?? 0) + orbitalSpeed,
      },
      trailVisible: true,
    });
    const next = refreshAccelerations({ ...current, bodies: [...current.bodies, body] });
    setSelectedBodyId(id);
    setTrails((existing) => [...existing, { bodyId: id, points: [{ ...body.position }] }]);
    commitSimulation(next, true);
  }

  function duplicateSelected() {
    if (!selectedBody) return;
    const current = simulationRef.current;
    const id = `body-${bodySequenceRef.current++}-${Date.now().toString(36)}`;
    const offset = Math.max(selectedBody.radius * 5, 18 / camera.pixelsPerMeter);
    const duplicate = createBody({
      ...selectedBody,
      id,
      name: `${selectedBody.name} COPY`,
      fixed: false,
      position: { x: selectedBody.position.x + offset, y: selectedBody.position.y + offset * 0.2 },
      velocity: { ...selectedBody.velocity },
      acceleration: { x: 0, y: 0 },
    });
    const next = refreshAccelerations({ ...current, bodies: [...current.bodies, duplicate] });
    setSelectedBodyId(id);
    setTrails((existing) => [...existing, { bodyId: id, points: [{ ...duplicate.position }] }]);
    commitSimulation(next, true);
  }

  function deleteSelected() {
    if (!selectedBody || simulation.bodies.length <= 2) return;
    const nextBodies = simulationRef.current.bodies.filter((body) => body.id !== selectedBody.id);
    const next = refreshAccelerations({ ...simulationRef.current, bodies: nextBodies });
    const fallback = nextBodies[0]?.id ?? null;
    setSelectedBodyId(fallback);
    setAnalysisBodyId(nextBodies.find((body) => body.id !== fallback)?.id ?? null);
    setTrails((existing) => existing.filter((trail) => trail.bodyId !== selectedBody.id));
    commitSimulation(next, true);
  }

  function focusBody(bodyId: string) {
    const body = simulationRef.current.bodies.find((candidate) => candidate.id === bodyId);
    if (!body) return;
    setCamera((current) => ({
      ...current,
      center: {
        x: body.position.x - frameTransform.origin.x,
        y: body.position.y - frameTransform.origin.y,
      },
    }));
  }

  function focusSelected() {
    if (selectedBodyId) focusBody(selectedBodyId);
  }

  function selectBody(bodyId: string) {
    setSelectedBodyId(bodyId);
    if (analysisBodyId === bodyId) {
      setAnalysisBodyId(simulationRef.current.bodies.find((body) => body.id !== bodyId)?.id ?? null);
    }
  }

  function stepForward() {
    const next = stepSimulation(simulationRef.current);
    setPaused(true);
    appendTrailSample(next, true);
    commitSimulation(next, true);
  }

  function shiftSpeed(direction: -1 | 1) {
    const index = TIME_SCALE_OPTIONS.indexOf(timeScale);
    const nextIndex = Math.max(0, Math.min(TIME_SCALE_OPTIONS.length - 1, index + direction));
    setTimeScale(TIME_SCALE_OPTIONS[nextIndex]);
  }

  const canvasDisplay: Partial<UniverseDisplayOptions> = {
    grid: display.grid,
    trails: display.trails,
    predictions: display.predictions,
    labels: display.labels,
    velocityVectors: display.vectors,
    accelerationVectors: display.vectors,
    forceVectors: display.vectors,
    distanceGuides: display.vectors,
    gravityField: display.gravityField,
    scaleIndicator: true,
    engineHud: true,
  };

  const activePreset = PRESETS.find((preset) => preset.id === activePresetId) ?? PRESETS[0];

  return (
    <main className="gravity-lab">
      <aside className="left-rail instrument-panel">
        <div className="brand-block">
          <p className="micro-label">GRAVITATIONAL LAB / 01</p>
          <div className="brand-line"><h1>APHELION</h1><span className={paused ? "status-dot paused" : "status-dot"} /></div>
          <p className="brand-subtitle">N-BODY NAVIGATION INSTRUMENT</p>
        </div>

        <div className="rail-section system-section">
          <div className="section-heading"><span>SYSTEM</span><span>{String(simulation.bodies.length).padStart(2, "0")} OBJECTS</span></div>
          <div className="body-list" role="list" aria-label="Celestial bodies">
            {simulation.bodies.map((body, index) => (
              <button
                className={`body-row ${body.id === selectedBodyId ? "active" : ""}`}
                key={body.id}
                onClick={() => selectBody(body.id)}
              >
                <span className="body-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="body-row-copy"><strong>{body.name}</strong><small>{formatMass(body.mass)}</small></span>
                <i className={body.fixed ? "fixed-marker" : ""} aria-hidden="true" />
              </button>
            ))}
          </div>
          <button className="outline-action full-width" onClick={addBody}>＋ ADD BODY</button>
        </div>

        <div className="rail-section preset-section">
          <div className="section-heading"><span>INITIAL CONDITIONS</span><span>PRESET</span></div>
          <select
            className="instrument-select"
            value={activePresetId}
            onChange={(event) => loadPreset(event.target.value as BuiltInPresetId)}
            aria-label="System preset"
          >
            {PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.name.toUpperCase()}</option>)}
          </select>
          <p className="preset-description">{presetDescription}</p>
          {activePreset.id === "random-system" && (
            <button className="text-action" onClick={() => loadPreset("random-system")}>REGENERATE SEED ↻</button>
          )}
        </div>

        <div className="left-rail-footer">
          <div><span>SOLVER</span><strong>VELOCITY VERLET</strong></div>
          <div><span>FRAME</span><strong>{referenceFrameMode.replaceAll("-", " ").toUpperCase()}</strong></div>
        </div>
      </aside>

      <section className="universe-stage">
        <UniverseCanvas
          bodies={simulation.bodies}
          selectedBodyId={selectedBodyId}
          dynamics={dynamics}
          forces={selectedForces}
          trails={trails}
          predictions={predictions}
          display={canvasDisplay}
          camera={camera}
          referenceFrame={{
            origin: frameTransform.origin,
            velocity: frameTransform.velocity,
            label: referenceFrameMode.replaceAll("-", " ").toUpperCase(),
          }}
          hud={{ fps, timeScale, solver: "VELOCITY VERLET", status: paused ? "HOLD" : "LIVE" }}
          vectorScale={vectorScale}
          gravityFieldDensity={gravityFieldDensity}
          onCameraChange={setCamera}
          onSelectBody={(id) => { if (id) selectBody(id); }}
          onMoveBody={(id, position) => updateBody(id, (body) => ({ ...body, position: { ...position } }))}
          onVelocityChange={(id, velocity) => updateBody(id, (body) => ({ ...body, velocity: { ...velocity } }))}
          onFocusBody={(id) => { selectBody(id); focusBody(id); }}
        />
        <div className="stage-topline">
          <span>SYS / {activePresetId.replaceAll("-", " ").toUpperCase()}</span>
          <span>G {formatScientific(simulation.config.gravitationalConstant, 4)} N·M²/KG²</span>
        </div>
        <div className="stage-tools" aria-label="Camera tools">
          <button onClick={() => setCamera((current) => ({ ...current, pixelsPerMeter: current.pixelsPerMeter * 1.35 }))} aria-label="Zoom in">＋</button>
          <button onClick={() => setCamera((current) => ({ ...current, pixelsPerMeter: current.pixelsPerMeter / 1.35 }))} aria-label="Zoom out">−</button>
          <button onClick={focusSelected} aria-label="Focus selected body">⌖</button>
          <button className="mobile-inspector-toggle" onClick={() => setMobileInspectorOpen((open) => !open)} aria-label="Toggle inspector">OBJ</button>
        </div>
        {openingInset && (
          <div className="local-inset">
            <div className="local-inset-heading"><span>LOCAL FRAME / EARTH</span><span>MOON TRACK</span></div>
            <UniverseCanvas
              bodies={openingInset.bodies}
              selectedBodyId="moon"
              trails={openingInset.trails}
              camera={openingInset.camera}
              referenceFrame={{ origin: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, label: "EARTH LOCAL" }}
              display={{
                grid: true,
                trails: true,
                predictions: false,
                labels: false,
                velocityVectors: false,
                accelerationVectors: false,
                forceVectors: false,
                distanceGuides: true,
                gravityField: false,
                scaleIndicator: true,
                engineHud: false,
              }}
              interactive={false}
              ariaLabel="Magnified live Earth and Moon local reference view"
            />
          </div>
        )}
        <div className="interaction-hint"><span>DRAG BODY</span><span>DRAG VECTOR</span><span>WHEEL ZOOM</span><span>DOUBLE CLICK FOCUS</span></div>
      </section>

      <aside className={`right-rail instrument-panel ${mobileInspectorOpen ? "mobile-open" : ""}`}>
        <div className="inspector-tabs" role="tablist">
          <button className={inspectorTab === "object" ? "active" : ""} onClick={() => setInspectorTab("object")} role="tab">OBJECT</button>
          <button className={inspectorTab === "analysis" ? "active" : ""} onClick={() => setInspectorTab("analysis")} role="tab">ANALYSIS</button>
          <button className="close-mobile" onClick={() => setMobileInspectorOpen(false)} aria-label="Close inspector">×</button>
        </div>

        {inspectorTab === "object" ? (
          <ObjectInspector
            body={selectedBody}
            bodyNumber={Math.max(0, simulation.bodies.findIndex((body) => body.id === selectedBodyId)) + 1}
            bodyCount={simulation.bodies.length}
            onPatch={patchSelected}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
            onFocus={focusSelected}
          />
        ) : (
          <AnalysisInspector
            selected={selectedBody}
            comparison={comparisonBody}
            bodies={simulation.bodies}
            comparisonId={analysisBodyId}
            onComparisonChange={setAnalysisBodyId}
            metrics={pairMetrics}
            diagnostics={diagnostics}
            history={history}
          />
        )}

        <details className="advanced-block">
          <summary><span>SIMULATION PARAMETERS</span><span>＋</span></summary>
          <div className="advanced-content">
            <NumberField label="GRAVITATIONAL CONSTANT" unit="N·M²/KG²" value={simulation.config.gravitationalConstant} step={1e-15} onChange={(value) => updateConfig({ gravitationalConstant: Math.max(1e-20, value) })} />
            <NumberField label="PHYSICS TIMESTEP" unit="SEC" value={simulation.config.timeStep} step={1} onChange={(value) => updateConfig({ timeStep: Math.max(0.001, value) })} />
            <NumberField label="NUMERICAL SOFTENING" unit="KM" value={simulation.config.softening / 1_000} step={1} onChange={(value) => updateConfig({ softening: Math.max(0, value * 1_000) })} />
            <NumberField label="TRAIL LENGTH" unit="PTS" value={trailLength} step={10} onChange={(value) => setTrailLength(Math.max(20, Math.min(1_500, Math.round(value))))} />
            <NumberField label="TRAIL SAMPLE" unit="SEC" value={trailSamplingInterval} step={1} onChange={(value) => setTrailSamplingInterval(Math.max(0.01, value))} />
            <NumberField label="FIELD DENSITY" unit="PX" value={gravityFieldDensity} step={2} onChange={(value) => setGravityFieldDensity(Math.max(30, Math.min(120, value)))} />
            <NumberField label="VECTOR SCALE" unit="×" value={vectorScale} step={0.1} onChange={(value) => setVectorScale(Math.max(0.1, Math.min(8, value)))} />
            <NumberField label="PREDICTION HORIZON" unit="DAYS" value={predictionHorizonDays} step={1} onChange={(value) => setPredictionHorizonDays(Math.max(0.02, Math.min(3_650, value)))} />
            <label className="field-row"><span>COLLISION MODE</span><select value={simulation.config.collisionMode} onChange={(event) => updateConfig({ collisionMode: event.target.value as CollisionMode })}><option value="pass">PASS THROUGH</option><option value="elastic">ELASTIC</option><option value="merge">MERGE</option></select></label>
            <label className="field-row"><span>REFERENCE FRAME</span><select value={referenceFrameMode} onChange={(event) => setReferenceFrameMode(event.target.value as ReferenceFrameMode)}><option value="inertial">INERTIAL</option><option value="center-of-mass">CENTER OF MASS</option><option value="selected-body">SELECTED BODY</option></select></label>
          </div>
        </details>
      </aside>

      <footer className="transport-bar">
        <div className="transport-cluster">
          <button onClick={() => shiftSpeed(-1)} aria-label="Reduce simulation speed">◀◀</button>
          <button onClick={resetSimulation} aria-label="Reset simulation">↺</button>
          <button className="primary-transport" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Resume simulation" : "Pause simulation"}>{paused ? "▶" : "Ⅱ"}</button>
          <button onClick={stepForward} aria-label="Step forward one tick">▷</button>
          <button onClick={() => shiftSpeed(1)} aria-label="Increase simulation speed">▶▶</button>
        </div>
        <label className="transport-readout speed-readout"><span>TIME SCALE</span><select value={timeScale} onChange={(event) => setTimeScale(Number(event.target.value) as typeof timeScale)}>{TIME_SCALE_OPTIONS.map((value) => <option value={value} key={value}>× {value.toFixed(value < 1 ? 2 : 1)}</option>)}</select></label>
        <div className="transport-readout simulation-time"><span>SIMULATION TIME / D:HH:MM:SS</span><strong>{formatDuration(simulation.time)}</strong></div>
        <div className="display-toggles">
          <Toggle label="GRID" value={display.grid} onChange={(value) => setDisplay((current) => ({ ...current, grid: value }))} />
          <Toggle label="TRAILS" value={display.trails} onChange={(value) => setDisplay((current) => ({ ...current, trails: value }))} />
          <Toggle label="VECTORS" value={display.vectors} onChange={(value) => setDisplay((current) => ({ ...current, vectors: value }))} />
          <Toggle label="FIELD" value={display.gravityField} onChange={(value) => setDisplay((current) => ({ ...current, gravityField: value }))} />
          <Toggle label="PREDICT" value={display.predictions} onChange={(value) => setDisplay((current) => ({ ...current, predictions: value }))} />
        </div>
      </footer>
    </main>
  );
}

interface ObjectInspectorProps {
  body: CelestialBody | null;
  bodyNumber: number;
  bodyCount: number;
  onPatch: (patch: Partial<CelestialBody>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onFocus: () => void;
}

function ObjectInspector({ body, bodyNumber, bodyCount, onPatch, onDuplicate, onDelete, onFocus }: ObjectInspectorProps) {
  if (!body) return <div className="empty-inspector">SELECT AN OBJECT TO INSPECT</div>;
  const speed = magnitude(body.velocity);
  const acceleration = magnitude(body.acceleration);
  const massExponent = Math.log10(Math.max(body.mass, 1));

  return (
    <div className="inspector-scroll">
      <div className="object-heading">
        <p className="micro-label">OBJECT {String(bodyNumber).padStart(2, "0")} / {String(bodyCount).padStart(2, "0")}</p>
        <input className="object-name-input" value={body.name} onChange={(event) => onPatch({ name: event.target.value.toUpperCase() })} aria-label="Body name" />
      </div>

      <div className="property-block mass-block">
        <div className="property-title"><span>MASS</span><output>{formatMass(body.mass)}</output></div>
        <input className="precision-slider" type="range" min="10" max="32" step="0.01" value={massExponent} onChange={(event) => onPatch({ mass: 10 ** Number(event.target.value) })} aria-label="Mass exponent" />
        <NumberField value={body.mass} step={body.mass * 0.001} unit="KG" onChange={(value) => onPatch({ mass: Math.max(1, value) })} />
      </div>
      <div className="two-column-fields">
        <NumberField label="RADIUS" value={body.radius / 1_000} step={1} unit="KM" onChange={(value) => onPatch({ radius: Math.max(0.001, value * 1_000) })} />
        <NumberField label="DENSITY" value={body.density ?? 0} step={1} unit="KG/M³" onChange={(value) => onPatch({ density: value > 0 ? value : undefined })} />
      </div>
      <div className="coordinate-group">
        <span className="group-label">POSITION / ×10⁹ M</span>
        <NumberField label="X" value={body.position.x / 1e9} step={0.01} onChange={(value) => onPatch({ position: { ...body.position, x: value * 1e9 } })} />
        <NumberField label="Y" value={body.position.y / 1e9} step={0.01} onChange={(value) => onPatch({ position: { ...body.position, y: value * 1e9 } })} />
      </div>
      <div className="coordinate-group">
        <span className="group-label">VELOCITY / KM·S⁻¹</span>
        <NumberField label="X" value={body.velocity.x / 1_000} step={0.01} onChange={(value) => onPatch({ velocity: { ...body.velocity, x: value * 1_000 } })} />
        <NumberField label="Y" value={body.velocity.y / 1_000} step={0.01} onChange={(value) => onPatch({ velocity: { ...body.velocity, y: value * 1_000 } })} />
      </div>
      <div className="live-readouts">
        <div><span>SPEED</span><strong>{formatVelocity(speed)}</strong></div>
        <div><span>ACCELERATION</span><strong>{formatAcceleration(acceleration)}</strong></div>
      </div>
      <div className="binary-options">
        <label><input type="checkbox" checked={body.fixed} onChange={(event) => onPatch({ fixed: event.target.checked })} /><span>FIXED POSITION</span></label>
        <label><input type="checkbox" checked={body.trailVisible} onChange={(event) => onPatch({ trailVisible: event.target.checked })} /><span>RENDER TRAIL</span></label>
      </div>
      <div className="object-actions">
        <button onClick={onFocus}>⌖ FOCUS</button>
        <button onClick={onDuplicate}>⧉ DUPLICATE</button>
        <button className="danger-action" disabled={bodyCount <= 2} onClick={onDelete}>× DELETE</button>
      </div>
    </div>
  );
}

interface AnalysisInspectorProps {
  selected: CelestialBody | null;
  comparison: CelestialBody | null;
  bodies: readonly CelestialBody[];
  comparisonId: string | null;
  onComparisonChange: (id: string) => void;
  metrics: ReturnType<typeof calculatePairMetrics> | null;
  diagnostics: ReturnType<typeof calculateSystemDiagnostics>;
  history: readonly HistorySample[];
}

function AnalysisInspector({ selected, comparison, bodies, comparisonId, onComparisonChange, metrics, diagnostics, history }: AnalysisInspectorProps) {
  if (!selected) return <div className="empty-inspector">SELECT A PRIMARY OBJECT</div>;
  return (
    <div className="inspector-scroll analysis-panel">
      <div className="analysis-heading">
        <p className="micro-label">RELATIONSHIP INSPECTOR</p>
        <strong>{selected.name} <span>→</span> {comparison?.name ?? "—"}</strong>
      </div>
      <label className="analysis-target"><span>SECONDARY OBJECT</span><select value={comparisonId ?? ""} onChange={(event) => onComparisonChange(event.target.value)}>{bodies.filter((body) => body.id !== selected.id).map((body) => <option value={body.id} key={body.id}>{body.name}</option>)}</select></label>
      {metrics && (
        <div className="analysis-metrics">
          <Metric label="DISTANCE" value={formatDistance(metrics.distance)} />
          <Metric label="RELATIVE VELOCITY" value={formatVelocity(metrics.relativeSpeed)} />
          <Metric label="GRAVITATIONAL FORCE" value={`${formatScientific(metrics.gravitationalForce, 3)} N`} />
          <Metric label="POTENTIAL ENERGY" value={`${formatScientific(metrics.potentialEnergy, 3)} J`} />
        </div>
      )}
      <div className="plot-stack">
        <MiniPlot label="DISTANCE" values={history.map((sample) => sample.distance)} />
        <MiniPlot label="RELATIVE SPEED" values={history.map((sample) => sample.speed)} />
        <MiniPlot label="TOTAL ENERGY" values={history.map((sample) => sample.total)} />
      </div>
      <div className="energy-table">
        <Metric label="KINETIC ENERGY" value={`${formatScientific(diagnostics.kineticEnergy, 2)} J`} />
        <Metric label="POTENTIAL ENERGY" value={`${formatScientific(diagnostics.potentialEnergy, 2)} J`} />
        <Metric label="MECHANICAL ENERGY" value={`${formatScientific(diagnostics.totalEnergy, 2)} J`} />
        <Metric label="SYSTEM MASS" value={formatMass(diagnostics.totalMass)} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

interface NumberFieldProps {
  label?: string;
  value: number;
  step?: number | "any";
  unit?: string;
  onChange: (value: number) => void;
}

function NumberField({ label, value, step = "any", unit, onChange }: NumberFieldProps) {
  return (
    <label className="number-field">
      {label && <span>{label}</span>}
      <div><input type="number" value={Number.isFinite(value) ? value : 0} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} />{unit && <small>{unit}</small>}</div>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button className={value ? "toggle active" : "toggle"} onClick={() => onChange(!value)} aria-pressed={value}><i />{label}</button>;
}
