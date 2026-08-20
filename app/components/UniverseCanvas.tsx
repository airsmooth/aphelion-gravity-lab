"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type {
  BodyDynamics,
  CelestialBody,
  ForceVector,
  PredictedTrajectory,
  Vector2,
} from "@/lib/physics";

const DEFAULT_CAMERA: UniverseCamera = {
  center: { x: 0, y: 0 },
  pixelsPerMeter: 4e-9,
};

const DEFAULT_REFERENCE_FRAME: UniverseReferenceFrame = {
  origin: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  label: "INERTIAL",
};

const DEFAULT_DISPLAY: UniverseDisplayOptions = {
  grid: true,
  trails: true,
  predictions: true,
  labels: true,
  velocityVectors: true,
  accelerationVectors: true,
  forceVectors: true,
  distanceGuides: true,
  gravityField: false,
  scaleIndicator: true,
  engineHud: true,
};

const MIN_ZOOM = 1e-15;
const MAX_ZOOM = 1e2;
const MAX_CAMERA_COORDINATE = 1e30;
const MAX_GRID_LINES_PER_AXIS = 256;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_VISIBLE_TRAIL_VERTICES = 8_000;
const MIN_RENDER_FPS = 1;
const MAX_RENDER_FPS = 120;
const RENDER_FAILURE_LOG_INTERVAL = 10_000;
const MAX_RENDER_RETRY_DELAY = 2_000;
const TWO_PI = Math.PI * 2;

/** Camera coordinates are in the translated reference frame; zoom is CSS pixels per metre. */
export interface UniverseCamera {
  center: Vector2;
  pixelsPerMeter: number;
}

/**
 * Positions supplied to the renderer remain absolute simulation coordinates.
 * This transform is subtracted for display and added back for drag callbacks.
 */
export interface UniverseReferenceFrame {
  origin: Vector2;
  velocity: Vector2;
  label?: string;
}

export interface BodyTrail {
  bodyId: string;
  points: readonly Vector2[];
}

export interface UniverseDisplayOptions {
  grid: boolean;
  trails: boolean;
  predictions: boolean;
  labels: boolean;
  velocityVectors: boolean;
  accelerationVectors: boolean;
  forceVectors: boolean;
  distanceGuides: boolean;
  gravityField: boolean;
  scaleIndicator: boolean;
  engineHud: boolean;
}

export interface UniverseHud {
  fps?: number;
  timeScale?: number;
  solver?: string;
  status?: string;
}

export interface UniverseCanvasProps {
  bodies: readonly CelestialBody[];
  selectedBodyId?: string | null;
  dynamics?: readonly BodyDynamics[];
  /** Individual gravitational vectors, normally for the selected body. */
  forces?: readonly ForceVector[];
  trails?: readonly BodyTrail[];
  predictions?: readonly PredictedTrajectory[];
  display?: Partial<UniverseDisplayOptions>;
  camera?: UniverseCamera;
  referenceFrame?: UniverseReferenceFrame;
  hud?: UniverseHud;
  /** Multiplier applied to normalized screen-space vector lengths. */
  vectorScale?: number;
  /** Approximate spacing of gravity-field samples in CSS pixels. */
  gravityFieldDensity?: number;
  /** Maximum canvas redraw rate. Defaults to 60 interactive, 24 passive, or 12 while held. */
  renderFps?: number;
  minZoom?: number;
  maxZoom?: number;
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  onSelectBody?: (bodyId: string | null) => void;
  onHoverBodyChange?: (bodyId: string | null) => void;
  onMoveBody?: (bodyId: string, absolutePosition: Vector2) => void;
  onVelocityChange?: (bodyId: string, absoluteVelocity: Vector2) => void;
  onCameraChange?: (camera: UniverseCamera) => void;
  onFocusBody?: (bodyId: string) => void;
}

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

interface BodyGeometry {
  id: string;
  x: number;
  y: number;
  radius: number;
}

interface VelocityHandleGeometry {
  bodyId: string;
  bodyX: number;
  bodyY: number;
  x: number;
  y: number;
  pixelsPerVelocityUnit: number;
}

interface RenderGeometry {
  bodies: BodyGeometry[];
  velocityHandle: VelocityHandleGeometry | null;
}

type DragState =
  | {
      mode: "body";
      pointerId: number;
      bodyId: string;
      grabOffset: Vector2;
    }
  | {
      mode: "velocity";
      pointerId: number;
      bodyId: string;
      bodyX: number;
      bodyY: number;
      pixelsPerVelocityUnit: number;
    }
  | {
      mode: "pan";
      pointerId: number;
      lastX: number;
      lastY: number;
    }
  | null;

interface LatestRenderData {
  bodies: readonly CelestialBody[];
  selectedBodyId: string | null;
  hoveredBodyId: string | null;
  dynamics: readonly BodyDynamics[];
  forces: readonly ForceVector[];
  trails: readonly BodyTrail[];
  predictions: readonly PredictedTrajectory[];
  display: UniverseDisplayOptions;
  referenceFrame: UniverseReferenceFrame;
  hud: UniverseHud;
  vectorScale: number;
  gravityFieldDensity: number;
  renderFps: number;
  canDragVelocity: boolean;
}

interface DrawState extends LatestRenderData {
  camera: UniverseCamera;
  width: number;
  height: number;
  now: number;
  measuredFps: number;
}

interface BodyRenderEntry {
  body: CelestialBody;
  dynamics?: BodyDynamics;
  geometry: BodyGeometry;
  index: number;
  logMass: number;
}

export default function UniverseCanvas({
  bodies,
  selectedBodyId = null,
  dynamics = [],
  forces = [],
  trails = [],
  predictions = [],
  display,
  camera,
  referenceFrame = DEFAULT_REFERENCE_FRAME,
  hud = {},
  vectorScale = 1,
  gravityFieldDensity = 54,
  renderFps,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
  interactive = true,
  className,
  style,
  ariaLabel = "Interactive N-body universe. Drag a body to reposition it, drag the selected velocity arrow to change velocity, drag empty space to pan, and use the wheel to zoom.",
  onSelectBody,
  onHoverBodyChange,
  onMoveBody,
  onVelocityChange,
  onCameraChange,
  onFocusBody,
}: UniverseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<CanvasSize>({ width: 1, height: 1, dpr: 1 });
  const geometryRef = useRef<RenderGeometry>({
    bodies: [],
    velocityHandle: null,
  });
  const dragRef = useRef<DragState>(null);
  const [uncontrolledCamera, setUncontrolledCamera] = useState(DEFAULT_CAMERA);
  const [hoveredBodyId, setHoveredBodyId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const resolvedCamera = sanitizeCamera(camera ?? uncontrolledCamera);
  const cameraRef = useRef(resolvedCamera);
  const renderRequestedRef = useRef(true);
  const renderFailedRef = useRef(false);
  const defaultRenderFps = hud.status?.toUpperCase() === "HOLD"
    ? 12
    : interactive
      ? 60
      : 24;

  const latestRenderData: LatestRenderData = {
    bodies,
    selectedBodyId,
    hoveredBodyId,
    dynamics,
    forces,
    trails,
    predictions,
    display: { ...DEFAULT_DISPLAY, ...display },
    referenceFrame,
    hud,
    vectorScale,
    gravityFieldDensity,
    renderFps: clamp(
      finitePositive(renderFps ?? defaultRenderFps, defaultRenderFps),
      MIN_RENDER_FPS,
      MAX_RENDER_FPS,
    ),
    canDragVelocity: Boolean(interactive && onVelocityChange),
  };
  latestRenderData.referenceFrame = sanitizeReferenceFrame(referenceFrame);
  latestRenderData.vectorScale = finitePositive(vectorScale, 1);
  latestRenderData.gravityFieldDensity = clamp(
    finitePositive(gravityFieldDensity, 54),
    30,
    120,
  );
  const latestRef = useRef<LatestRenderData>(latestRenderData);

  useEffect(() => {
    cameraRef.current = resolvedCamera;
    if (latestRef.current.renderFps !== latestRenderData.renderFps) {
      renderRequestedRef.current = true;
    }
    latestRef.current = latestRenderData;
  });

  function publishCamera(nextCamera: UniverseCamera) {
    const low = Math.min(
      finitePositive(minZoom, MIN_ZOOM),
      finitePositive(maxZoom, MAX_ZOOM),
    );
    const high = Math.max(
      finitePositive(minZoom, MIN_ZOOM),
      finitePositive(maxZoom, MAX_ZOOM),
    );
    const next = sanitizeCamera({
      center: nextCamera.center,
      pixelsPerMeter: clamp(nextCamera.pixelsPerMeter, low, high),
    });
    cameraRef.current = next;
    renderRequestedRef.current = true;
    if (camera === undefined) setUncontrolledCamera(next);
    onCameraChange?.(next);
  }

  function updateHovered(nextId: string | null) {
    if (nextId === hoveredBodyId) return;
    renderRequestedRef.current = true;
    setHoveredBodyId(nextId);
    onHoverBodyChange?.(nextId);
  }

  function pointerCoordinates(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    if (event.button !== 0 && event.button !== 1) return;
    renderRequestedRef.current = true;
    const canvas = event.currentTarget;
    const point = pointerCoordinates(event);
    const handle = geometryRef.current.velocityHandle;
    canvas.focus();

    if (
      event.button === 0 &&
      handle &&
      onVelocityChange &&
      squaredDistance(point.x, point.y, handle.x, handle.y) <= 12 ** 2
    ) {
      dragRef.current = {
        mode: "velocity",
        pointerId: event.pointerId,
        bodyId: handle.bodyId,
        bodyX: handle.bodyX,
        bodyY: handle.bodyY,
        pixelsPerVelocityUnit: handle.pixelsPerVelocityUnit,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
      event.preventDefault();
      return;
    }

    const hit = hitTestBody(point.x, point.y, geometryRef.current.bodies);
    if (event.button === 0 && hit) {
      const absolutePoint = screenToAbsolute(
        point,
        cameraRef.current,
        latestRef.current.referenceFrame,
        sizeRef.current,
      );
      const body = latestRef.current.bodies.find((candidate) => candidate.id === hit.id);
      dragRef.current = {
        mode: "body",
        pointerId: event.pointerId,
        bodyId: hit.id,
        grabOffset: body
          ? {
              x: absolutePoint.x - body.position.x,
              y: absolutePoint.y - body.position.y,
            }
          : { x: 0, y: 0 },
      };
      onSelectBody?.(hit.id);
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = onMoveBody ? "grabbing" : "pointer";
      event.preventDefault();
      return;
    }

    if (event.button === 0) onSelectBody?.(null);
    dragRef.current = {
      mode: "pan",
      pointerId: event.pointerId,
      lastX: point.x,
      lastY: point.y,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    event.preventDefault();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = pointerCoordinates(event);
    const drag = dragRef.current;
    const canvas = event.currentTarget;

    if (!drag || drag.pointerId !== event.pointerId) {
      const handle = geometryRef.current.velocityHandle;
      const overVelocityHandle = Boolean(
        handle &&
          squaredDistance(point.x, point.y, handle.x, handle.y) <= 12 ** 2,
      );
      const hit = hitTestBody(point.x, point.y, geometryRef.current.bodies);
      updateHovered(hit?.id ?? null);
      canvas.style.cursor = !interactive
        ? "default"
        : overVelocityHandle
          ? "grab"
          : hit
            ? "pointer"
            : "crosshair";
      return;
    }

    renderRequestedRef.current = true;
    if (drag.mode === "pan") {
      const zoom = cameraRef.current.pixelsPerMeter;
      publishCamera({
        center: {
          x: cameraRef.current.center.x - (point.x - drag.lastX) / zoom,
          y: cameraRef.current.center.y + (point.y - drag.lastY) / zoom,
        },
        pixelsPerMeter: zoom,
      });
      dragRef.current = { ...drag, lastX: point.x, lastY: point.y };
    } else if (drag.mode === "body" && onMoveBody) {
      const absolutePoint = screenToAbsolute(
        point,
        cameraRef.current,
        latestRef.current.referenceFrame,
        sizeRef.current,
      );
      onMoveBody(drag.bodyId, {
        x: absolutePoint.x - drag.grabOffset.x,
        y: absolutePoint.y - drag.grabOffset.y,
      });
    } else if (drag.mode === "velocity" && onVelocityChange) {
      const relativeVelocity = {
        x: (point.x - drag.bodyX) / drag.pixelsPerVelocityUnit,
        y: -(point.y - drag.bodyY) / drag.pixelsPerVelocityUnit,
      };
      const frameVelocity = latestRef.current.referenceFrame.velocity;
      onVelocityChange(drag.bodyId, {
        x: relativeVelocity.x + frameVelocity.x,
        y: relativeVelocity.y + frameVelocity.y,
      });
    }
    event.preventDefault();
  }

  function endPointerInteraction(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    renderRequestedRef.current = true;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = hoveredBodyId ? "pointer" : "crosshair";
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    const point = pointerCoordinates(event as unknown as ReactPointerEvent<HTMLCanvasElement>);
    const before = screenToFrame(point, cameraRef.current, sizeRef.current);
    const factor = Math.exp(-event.deltaY * 0.0014);
    const low = Math.min(
      finitePositive(minZoom, MIN_ZOOM),
      finitePositive(maxZoom, MAX_ZOOM),
    );
    const high = Math.max(
      finitePositive(minZoom, MIN_ZOOM),
      finitePositive(maxZoom, MAX_ZOOM),
    );
    const zoom = clamp(cameraRef.current.pixelsPerMeter * factor, low, high);
    const center = {
      x: before.x - (point.x - sizeRef.current.width / 2) / zoom,
      y: before.y + (point.y - sizeRef.current.height / 2) / zoom,
    };
    publishCamera({ center, pixelsPerMeter: zoom });
  }

  function focusBody(bodyId: string) {
    const body = latestRef.current.bodies.find((candidate) => candidate.id === bodyId);
    if (!body) return;
    const origin = latestRef.current.referenceFrame.origin;
    publishCamera({
      center: {
        x: body.position.x - origin.x,
        y: body.position.y - origin.y,
      },
      pixelsPerMeter: cameraRef.current.pixelsPerMeter,
    });
    onFocusBody?.(bodyId);
  }

  function handleDoubleClick(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    const point = pointerCoordinates(event);
    const hit = hitTestBody(point.x, point.y, geometryRef.current.bodies);
    if (hit) focusBody(hit.id);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    renderRequestedRef.current = true;
    const cameraValue = cameraRef.current;
    const panDistance = 48 / cameraValue.pixelsPerMeter;
    let nextCenter: Vector2 | null = null;
    if (event.key === "ArrowLeft") {
      nextCenter = { x: cameraValue.center.x - panDistance, y: cameraValue.center.y };
    } else if (event.key === "ArrowRight") {
      nextCenter = { x: cameraValue.center.x + panDistance, y: cameraValue.center.y };
    } else if (event.key === "ArrowUp") {
      nextCenter = { x: cameraValue.center.x, y: cameraValue.center.y + panDistance };
    } else if (event.key === "ArrowDown") {
      nextCenter = { x: cameraValue.center.x, y: cameraValue.center.y - panDistance };
    }

    if (nextCenter) {
      publishCamera({ center: nextCenter, pixelsPerMeter: cameraValue.pixelsPerMeter });
      event.preventDefault();
      return;
    }

    if (event.key === "+" || event.key === "=") {
      publishCamera({ ...cameraValue, pixelsPerMeter: cameraValue.pixelsPerMeter * 1.25 });
      event.preventDefault();
    } else if (event.key === "-" || event.key === "_") {
      publishCamera({ ...cameraValue, pixelsPerMeter: cameraValue.pixelsPerMeter / 1.25 });
      event.preventDefault();
    } else if (event.key.toLowerCase() === "f" && selectedBodyId) {
      focusBody(selectedBodyId);
      event.preventDefault();
    } else if (event.key === "Escape") {
      onSelectBody?.(null);
      event.preventDefault();
    } else if (event.key === "[") {
      selectAdjacentBody(-1, bodies, selectedBodyId, onSelectBody);
      event.preventDefault();
    } else if (event.key === "]") {
      selectAdjacentBody(1, bodies, selectedBodyId, onSelectBody);
      event.preventDefault();
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    let animationFrame = 0;
    let previousFrame = performance.now();
    let nextRenderAt = 0;
    let smoothedFps = 60;
    let consecutiveFailures = 0;
    let retryNotBefore = 0;
    let lastFailureLog = Number.NEGATIVE_INFINITY;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const requestedDpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
      const budgetDpr = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
      const dpr = Math.max(0.25, Math.min(requestedDpr, budgetDpr));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      sizeRef.current = { width, height, dpr };
      renderRequestedRef.current = true;
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (now: number) => {
      try {
        if (document.visibilityState !== "visible") {
          previousFrame = now;
          nextRenderAt = now;
          return;
        }
        if (now < retryNotBefore) return;

        const frameInterval = 1_000 / latestRef.current.renderFps;
        const renderRequested = renderRequestedRef.current;
        if (
          !renderRequested &&
          nextRenderAt > 0 &&
          now < nextRenderAt - 0.5
        ) {
          return;
        }

        const elapsed = Math.max(1, now - previousFrame);
        smoothedFps += ((1000 / elapsed) - smoothedFps) * 0.08;
        previousFrame = now;
        renderRequestedRef.current = false;
        if (renderRequested || nextRenderAt <= 0 || now - nextRenderAt > frameInterval * 3) {
          nextRenderAt = now + frameInterval;
        } else {
          do nextRenderAt += frameInterval;
          while (nextRenderAt <= now + 0.5);
        }

        const size = sizeRef.current;
        context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
        geometryRef.current = drawUniverse(context, {
          ...latestRef.current,
          camera: cameraRef.current,
          width: size.width,
          height: size.height,
          now,
          measuredFps: smoothedFps,
        });

        consecutiveFailures = 0;
        retryNotBefore = 0;
        if (renderFailedRef.current) {
          renderFailedRef.current = false;
          setRenderFailed(false);
        }
      } catch (error) {
        consecutiveFailures += 1;
        const retryDelay = Math.min(
          MAX_RENDER_RETRY_DELAY,
          250 * 2 ** Math.min(consecutiveFailures - 1, 3),
        );
        retryNotBefore = now + retryDelay;
        nextRenderAt = retryNotBefore;
        if (now - lastFailureLog >= RENDER_FAILURE_LOG_INTERVAL) {
          lastFailureLog = now;
          console.error("Universe canvas draw failed; retrying automatically.", error);
        }
        if (!renderFailedRef.current) {
          renderFailedRef.current = true;
          setRenderFailed(true);
        }
      } finally {
        animationFrame = requestAnimationFrame(render);
      }
    };

    animationFrame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      className={className}
      data-universe-canvas-status={renderFailed ? "error" : "ready"}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 240,
        overflow: "hidden",
        background: "#020202",
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={interactive ? 0 : -1}
        aria-label={ariaLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointerInteraction}
        onPointerCancel={endPointerInteraction}
        onPointerLeave={() => {
          if (!dragRef.current) updateHovered(null);
        }}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          touchAction: "none",
          overscrollBehavior: "none",
          cursor: interactive ? "crosshair" : "default",
          outline: focused ? "1px solid #d8d8d8" : "none",
          outlineOffset: -2,
        }}
      />
      {renderFailed && (
        <div
          className="universe-canvas-error"
          data-universe-canvas-error="active"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 3,
            maxWidth: 310,
            padding: "8px 10px",
            border: "1px solid rgba(255,255,255,0.46)",
            background: "rgba(2,2,2,0.9)",
            color: "rgba(255,255,255,0.86)",
            font: "10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace",
            letterSpacing: "0.06em",
            pointerEvents: "none",
          }}
        >
          <strong style={{ display: "block", color: "#fff" }}>CANVAS RECOVERY</strong>
          <span>Visualization paused briefly. Retrying automatically.</span>
        </div>
      )}
    </div>
  );
}

function drawUniverse(context: CanvasRenderingContext2D, state: DrawState): RenderGeometry {
  const { width, height } = state;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#020202";
  context.fillRect(0, 0, width, height);
  context.lineCap = "round";
  context.lineJoin = "round";

  const dynamicsByBody = new Map(state.dynamics.map((entry) => [entry.bodyId, entry]));
  const logMasses = state.bodies.map((body) => Math.log10(Math.max(body.mass, 1)));
  let minimumLogMass = Number.POSITIVE_INFINITY;
  let maximumLogMass = Number.NEGATIVE_INFINITY;
  for (const logMass of logMasses) {
    minimumLogMass = Math.min(minimumLogMass, logMass);
    maximumLogMass = Math.max(maximumLogMass, logMass);
  }
  if (!Number.isFinite(minimumLogMass) || !Number.isFinite(maximumLogMass)) {
    minimumLogMass = 0;
    maximumLogMass = 0;
  }

  const bodyEntries: BodyRenderEntry[] = state.bodies.map((body, index) => {
    const screen = absoluteToScreen(
      body.position,
      state.camera,
      state.referenceFrame,
      state,
    );
    return {
      body,
      dynamics: dynamicsByBody.get(body.id),
      geometry: {
        id: body.id,
        x: screen.x,
        y: screen.y,
        radius: visualBodyRadius(body, state, minimumLogMass, maximumLogMass),
      },
      index: index + 1,
      logMass: logMasses[index],
    };
  });
  const entryById = new Map(bodyEntries.map((entry) => [entry.body.id, entry]));
  const bodyGeometry = bodyEntries.map((entry) => entry.geometry);

  let maximumSpeed = 1e-30;
  let maximumAcceleration = 1e-30;
  for (const entry of bodyEntries) {
    maximumSpeed = Math.max(
      maximumSpeed,
      Math.hypot(
        entry.body.velocity.x - state.referenceFrame.velocity.x,
        entry.body.velocity.y - state.referenceFrame.velocity.y,
      ),
    );
    const acceleration = entry.dynamics?.acceleration ?? entry.body.acceleration;
    maximumAcceleration = Math.max(
      maximumAcceleration,
      Math.hypot(acceleration.x, acceleration.y),
    );
  }

  if (state.display.gravityField) {
    drawGravityField(context, state, bodyEntries, maximumLogMass);
  }
  if (state.display.grid) drawGrid(context, state);
  if (state.display.predictions) drawPredictions(context, state);
  if (state.display.trails) drawTrails(context, state, entryById);
  if (state.display.distanceGuides) {
    drawDistanceGuides(context, state, bodyEntries, entryById);
  }

  let velocityHandle: VelocityHandleGeometry | null = null;
  if (
    state.selectedBodyId &&
    (state.display.velocityVectors ||
      state.display.accelerationVectors ||
      state.display.forceVectors)
  ) {
    const selectedEntry = entryById.get(state.selectedBodyId);
    if (selectedEntry) {
      velocityHandle = drawVectors(
        context,
        state,
        selectedEntry.body,
        selectedEntry.geometry,
        selectedEntry.dynamics,
        maximumSpeed,
        maximumAcceleration,
      );
    }
  }

  for (const entry of bodyEntries) {
    drawBody(
      context,
      entry.body,
      entry.geometry,
      entry.body.id === state.selectedBodyId,
      entry.body.id === state.hoveredBodyId,
      state.now,
    );
  }

  if (state.display.labels || state.hoveredBodyId || state.selectedBodyId) {
    drawBodyLabels(context, state, bodyEntries);
  }
  if (state.display.scaleIndicator) drawScaleIndicator(context, state);
  if (state.display.engineHud) drawEngineHud(context, state);
  drawReticle(context, state);

  return { bodies: bodyGeometry, velocityHandle };
}

function drawGrid(context: CanvasRenderingContext2D, state: DrawState) {
  const zoom = state.camera.pixelsPerMeter;
  const minorStep = niceNumber(76 / zoom);
  if (!Number.isFinite(minorStep) || minorStep <= 0) return;
  const left = state.camera.center.x - state.width / (2 * zoom);
  const right = state.camera.center.x + state.width / (2 * zoom);
  const bottom = state.camera.center.y - state.height / (2 * zoom);
  const top = state.camera.center.y + state.height / (2 * zoom);

  context.save();
  context.lineWidth = 1;
  context.strokeStyle = "rgba(255,255,255,0.055)";
  context.beginPath();
  const firstX = Math.ceil(left / minorStep) * minorStep;
  const verticalLineCount = Number.isFinite(firstX)
    ? Math.min(MAX_GRID_LINES_PER_AXIS, Math.max(0, Math.ceil((right - firstX) / minorStep) + 1))
    : 0;
  for (let index = 0; index < verticalLineCount; index += 1) {
    const x = firstX + index * minorStep;
    const screenX = state.width / 2 + (x - state.camera.center.x) * zoom;
    if (!Number.isFinite(screenX)) continue;
    context.moveTo(Math.round(screenX) + 0.5, 0);
    context.lineTo(Math.round(screenX) + 0.5, state.height);
  }
  const firstY = Math.ceil(bottom / minorStep) * minorStep;
  const horizontalLineCount = Number.isFinite(firstY)
    ? Math.min(MAX_GRID_LINES_PER_AXIS, Math.max(0, Math.ceil((top - firstY) / minorStep) + 1))
    : 0;
  for (let index = 0; index < horizontalLineCount; index += 1) {
    const y = firstY + index * minorStep;
    const screenY = state.height / 2 - (y - state.camera.center.y) * zoom;
    if (!Number.isFinite(screenY)) continue;
    context.moveTo(0, Math.round(screenY) + 0.5);
    context.lineTo(state.width, Math.round(screenY) + 0.5);
  }
  context.stroke();

  const originX = state.width / 2 - state.camera.center.x * zoom;
  const originY = state.height / 2 + state.camera.center.y * zoom;
  context.strokeStyle = "rgba(255,255,255,0.14)";
  context.beginPath();
  if (originX >= 0 && originX <= state.width) {
    context.moveTo(Math.round(originX) + 0.5, 0);
    context.lineTo(Math.round(originX) + 0.5, state.height);
  }
  if (originY >= 0 && originY <= state.height) {
    context.moveTo(0, Math.round(originY) + 0.5);
    context.lineTo(state.width, Math.round(originY) + 0.5);
  }
  context.stroke();
  context.restore();
}

function drawGravityField(
  context: CanvasRenderingContext2D,
  state: DrawState,
  bodyEntries: readonly BodyRenderEntry[],
  largestLogMass: number,
) {
  if (bodyEntries.length === 0) return;
  const weightedBodies = bodyEntries.map((entry) => {
    const absoluteStrength = clamp((entry.logMass - 17) / 14, 0.12, 1);
    const relativeStrength = 10 ** clamp(entry.logMass - largestLogMass, -4, 0);
    return {
      entry,
      fieldWeight: 10 ** clamp(entry.logMass - largestLogMass, -7, 0),
      strength: clamp(absoluteStrength * 0.7 + relativeStrength * 0.3, 0.12, 1),
    };
  });

  context.save();
  context.lineWidth = 0.7;
  for (const { entry, strength } of weightedBodies) {
    const { x, y } = entry.geometry;
    if (!isNearViewport(x, y, 220, state)) continue;
    const contourCount = 2 + Math.round(strength * 5);
    context.strokeStyle = `rgba(255,255,255,${0.018 + strength * 0.025})`;
    for (let index = 1; index <= contourCount; index += 1) {
      const radius = (15 + index * 18) * (0.55 + strength * 0.65);
      context.beginPath();
      context.arc(x, y, radius, 0, TWO_PI);
      context.stroke();
    }
  }

  const spacing = state.gravityFieldDensity;
  context.strokeStyle = "rgba(255,255,255,0.105)";
  context.lineWidth = 0.65;
  for (let y = spacing / 2; y < state.height; y += spacing) {
    for (let x = spacing / 2; x < state.width; x += spacing) {
      let fieldX = 0;
      let fieldY = 0;
      for (const { entry, fieldWeight } of weightedBodies) {
        const dx = entry.geometry.x - x;
        const dy = entry.geometry.y - y;
        const distanceSquared = dx * dx + dy * dy + 144;
        const inverseDistance = 1 / Math.sqrt(distanceSquared);
        fieldX += dx * inverseDistance * fieldWeight / distanceSquared;
        fieldY += dy * inverseDistance * fieldWeight / distanceSquared;
      }
      const magnitude = Math.hypot(fieldX, fieldY);
      if (magnitude <= 1e-12) continue;
      const dash = 3.5;
      const unitX = fieldX / magnitude;
      const unitY = fieldY / magnitude;
      context.beginPath();
      context.moveTo(x - unitX * dash, y - unitY * dash);
      context.lineTo(x + unitX * dash, y + unitY * dash);
      context.stroke();
    }
  }
  context.restore();
}

function drawPredictions(context: CanvasRenderingContext2D, state: DrawState) {
  const zoom = state.camera.pixelsPerMeter;
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  const frameX = state.referenceFrame.origin.x + state.camera.center.x;
  const frameY = state.referenceFrame.origin.y + state.camera.center.y;
  context.save();
  context.setLineDash([5, 7]);
  context.lineWidth = 0.85;
  for (const trajectory of state.predictions) {
    if (trajectory.points.length < 2) continue;
    context.strokeStyle =
      trajectory.bodyId === state.selectedBodyId
        ? "rgba(255,255,255,0.43)"
        : "rgba(255,255,255,0.16)";
    context.beginPath();
    trajectory.points.forEach((point, index) => {
      const screenX = centerX + (point.position.x - frameX) * zoom;
      const screenY = centerY - (point.position.y - frameY) * zoom;
      if (index === 0) context.moveTo(screenX, screenY);
      else context.lineTo(screenX, screenY);
    });
    context.stroke();
  }
  context.restore();
}

function drawTrails(
  context: CanvasRenderingContext2D,
  state: DrawState,
  entryById: ReadonlyMap<string, BodyRenderEntry>,
) {
  let visibleVertexCount = 0;
  for (const trail of state.trails) {
    const body = entryById.get(trail.bodyId)?.body;
    if (body && !body.trailVisible) continue;
    if (trail.points.length >= 2) visibleVertexCount += trail.points.length;
  }
  const stride = Math.max(
    1,
    Math.ceil(visibleVertexCount / MAX_VISIBLE_TRAIL_VERTICES),
  );
  const zoom = state.camera.pixelsPerMeter;
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  const frameX = state.referenceFrame.origin.x + state.camera.center.x;
  const frameY = state.referenceFrame.origin.y + state.camera.center.y;
  const discontinuityThreshold = Math.max(state.width, state.height) ** 2;

  context.save();
  context.lineWidth = 0.9;
  for (const trail of state.trails) {
    const body = entryById.get(trail.bodyId)?.body;
    if (body && !body.trailVisible) continue;
    if (trail.points.length < 2) continue;
    const selected = trail.bodyId === state.selectedBodyId;
    context.strokeStyle = selected
      ? "rgba(255,255,255,0.62)"
      : "rgba(255,255,255,0.28)";
    context.beginPath();
    let started = false;
    let previousX = 0;
    let previousY = 0;
    const lastIndex = trail.points.length - 1;
    for (let index = 0; index <= lastIndex; index += stride) {
      const point = trail.points[index];
      const screenX = centerX + (point.x - frameX) * zoom;
      const screenY = centerY - (point.y - frameY) * zoom;
      const discontinuity = started &&
        squaredDistance(previousX, previousY, screenX, screenY) > discontinuityThreshold;
      if (!started || discontinuity) context.moveTo(screenX, screenY);
      else context.lineTo(screenX, screenY);
      started = true;
      previousX = screenX;
      previousY = screenY;
    }
    if (lastIndex % stride !== 0) {
      const point = trail.points[lastIndex];
      const screenX = centerX + (point.x - frameX) * zoom;
      const screenY = centerY - (point.y - frameY) * zoom;
      const discontinuity = started &&
        squaredDistance(previousX, previousY, screenX, screenY) > discontinuityThreshold;
      if (!started || discontinuity) context.moveTo(screenX, screenY);
      else context.lineTo(screenX, screenY);
    }
    context.stroke();
  }
  context.restore();
}

function drawDistanceGuides(
  context: CanvasRenderingContext2D,
  state: DrawState,
  bodyEntries: readonly BodyRenderEntry[],
  entryById: ReadonlyMap<string, BodyRenderEntry>,
) {
  const selectedEntry = state.selectedBodyId
    ? entryById.get(state.selectedBodyId)
    : undefined;
  if (!selectedEntry) return;
  const selected = selectedEntry.body;
  const start = selectedEntry.geometry;
  context.save();
  context.lineWidth = 0.6;
  context.setLineDash([2, 6]);
  context.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  for (const entry of bodyEntries) {
    const body = entry.body;
    if (body.id === selected.id) continue;
    const end = entry.geometry;
    if (
      !isNearViewport(start.x, start.y, 40, state) &&
      !isNearViewport(end.x, end.y, 40, state)
    ) {
      continue;
    }
    context.strokeStyle = "rgba(255,255,255,0.12)";
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    const distance = Math.hypot(
      body.position.x - selected.position.x,
      body.position.y - selected.position.y,
    );
    const middleX = (start.x + end.x) / 2;
    const middleY = (start.y + end.y) / 2;
    if (isNearViewport(middleX, middleY, 0, state)) {
      const text = formatDistance(distance);
      const textWidth = context.measureText(text).width + 8;
      context.fillStyle = "rgba(2,2,2,0.82)";
      context.fillRect(middleX - textWidth / 2, middleY - 13, textWidth, 13);
      context.fillStyle = "rgba(255,255,255,0.48)";
      context.fillText(text, middleX, middleY - 2);
    }
  }
  context.restore();
}

function drawVectors(
  context: CanvasRenderingContext2D,
  state: DrawState,
  body: CelestialBody,
  geometry: BodyGeometry,
  dynamics?: BodyDynamics,
  maximumSpeed = 1e-30,
  maximumAcceleration = 1e-30,
): VelocityHandleGeometry | null {
  const relativeVelocity = {
    x: body.velocity.x - state.referenceFrame.velocity.x,
    y: body.velocity.y - state.referenceFrame.velocity.y,
  };
  const acceleration = dynamics?.acceleration ?? body.acceleration;
  const velocityPixelsPerUnit = (82 / maximumSpeed) * state.vectorScale;
  const accelerationPixelsPerUnit = (58 / maximumAcceleration) * state.vectorScale;
  let velocityHandle: VelocityHandleGeometry | null = null;

  context.save();
  if (state.display.velocityVectors && Math.hypot(relativeVelocity.x, relativeVelocity.y) > 0) {
    const endpoint = {
      x: geometry.x + relativeVelocity.x * velocityPixelsPerUnit,
      y: geometry.y - relativeVelocity.y * velocityPixelsPerUnit,
    };
    drawArrow(context, geometry.x, geometry.y, endpoint.x, endpoint.y, {
      stroke: "rgba(255,255,255,0.92)",
      label: "V",
      dashed: false,
    });
    if (state.canDragVelocity) {
      context.fillStyle = "#020202";
      context.strokeStyle = "rgba(255,255,255,0.92)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(endpoint.x, endpoint.y, 3.5, 0, TWO_PI);
      context.fill();
      context.stroke();
    }
    velocityHandle = {
      bodyId: body.id,
      bodyX: geometry.x,
      bodyY: geometry.y,
      x: endpoint.x,
      y: endpoint.y,
      pixelsPerVelocityUnit: velocityPixelsPerUnit,
    };
  }

  if (state.display.accelerationVectors && Math.hypot(acceleration.x, acceleration.y) > 0) {
    drawArrow(
      context,
      geometry.x,
      geometry.y,
      geometry.x + acceleration.x * accelerationPixelsPerUnit,
      geometry.y - acceleration.y * accelerationPixelsPerUnit,
      { stroke: "rgba(255,255,255,0.57)", label: "A", dashed: true },
    );
  }

  if (state.display.forceVectors) {
    const relevantForces = state.forces.filter((force) => force.sourceBodyId === body.id);
    const maxForce = Math.max(1e-30, ...relevantForces.map((force) => force.magnitude));
    const forcePixelsPerUnit = (48 / maxForce) * state.vectorScale;
    for (const force of relevantForces) {
      if (force.magnitude <= 0) continue;
      drawArrow(
        context,
        geometry.x,
        geometry.y,
        geometry.x + force.vector.x * forcePixelsPerUnit,
        geometry.y - force.vector.y * forcePixelsPerUnit,
        { stroke: "rgba(255,255,255,0.34)", label: "F", dashed: true },
      );
    }
  }
  context.restore();
  return velocityHandle;
}

function drawArrow(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  options: { stroke: string; label: string; dashed: boolean },
) {
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 2) return;
  const unitX = dx / length;
  const unitY = dy / length;
  const headLength = clamp(length * 0.16, 5, 9);
  const angle = 0.48;
  context.save();
  context.strokeStyle = options.stroke;
  context.fillStyle = options.stroke;
  context.lineWidth = 0.9;
  context.setLineDash(options.dashed ? [3, 4] : []);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(
    endX - headLength * (unitX * Math.cos(angle) - unitY * Math.sin(angle)),
    endY - headLength * (unitY * Math.cos(angle) + unitX * Math.sin(angle)),
  );
  context.lineTo(
    endX - headLength * (unitX * Math.cos(angle) + unitY * Math.sin(angle)),
    endY - headLength * (unitY * Math.cos(angle) - unitX * Math.sin(angle)),
  );
  context.closePath();
  context.fill();
  context.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(options.label, endX + 7, endY);
  context.restore();
}

function drawBody(
  context: CanvasRenderingContext2D,
  body: CelestialBody,
  geometry: BodyGeometry,
  selected: boolean,
  hovered: boolean,
  now: number,
) {
  if (!isNearViewport(geometry.x, geometry.y, geometry.radius + 34, {
    width: context.canvas.width,
    height: context.canvas.height,
  })) {
    return;
  }
  const { x, y, radius } = geometry;
  context.save();

  if (selected || hovered) {
    const pulse = selected ? 1.5 + Math.sin(now * 0.003) * 1.2 : 0;
    context.strokeStyle = selected
      ? "rgba(255,255,255,0.82)"
      : "rgba(255,255,255,0.52)";
    context.lineWidth = selected ? 1 : 0.75;
    context.beginPath();
    context.arc(x, y, radius + 7 + pulse, 0, TWO_PI);
    context.stroke();
    if (selected) {
      context.strokeStyle = "rgba(255,255,255,0.22)";
      context.beginPath();
      context.arc(x, y, radius + 13 + pulse * 0.5, 0, TWO_PI);
      context.stroke();
    }
  }

  context.shadowColor = "rgba(255,255,255,0.24)";
  context.shadowBlur = Math.min(10, radius * 0.7);
  context.fillStyle = "#f2f2f2";
  context.strokeStyle = "#ffffff";
  context.lineWidth = 0.8;
  context.beginPath();
  context.arc(x, y, radius, 0, TWO_PI);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  if (radius >= 6) {
    context.strokeStyle = "rgba(2,2,2,0.36)";
    context.lineWidth = 0.65;
    context.beginPath();
    context.arc(x, y, radius * 0.62, -1.1, 1.55);
    context.stroke();
    context.beginPath();
    context.ellipse(x, y, radius * 0.82, radius * 0.28, 0.1, 0, TWO_PI);
    context.stroke();
  }

  if (body.fixed) {
    context.strokeStyle = "rgba(2,2,2,0.7)";
    context.lineWidth = 0.8;
    context.beginPath();
    context.moveTo(x - radius * 0.55, y);
    context.lineTo(x + radius * 0.55, y);
    context.moveTo(x, y - radius * 0.55);
    context.lineTo(x, y + radius * 0.55);
    context.stroke();
  }
  context.restore();
}

function drawBodyLabels(
  context: CanvasRenderingContext2D,
  state: DrawState,
  bodyEntries: readonly BodyRenderEntry[],
) {
  const occupied: Rect[] = [];
  const ordered = [...bodyEntries].sort((a, b) => {
    const score = (entry: BodyRenderEntry) =>
      entry.body.id === state.selectedBodyId
        ? 2
        : entry.body.id === state.hoveredBodyId
          ? 1
          : 0;
    return score(b) - score(a);
  });
  context.save();
  context.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.textBaseline = "top";

  for (const entry of ordered) {
    const body = entry.body;
    const selected = body.id === state.selectedBodyId;
    const hovered = body.id === state.hoveredBodyId;
    if (!state.display.labels && !selected && !hovered) continue;
    const screenBody = entry.geometry;
    if (!isNearViewport(screenBody.x, screenBody.y, 170, state)) continue;
    const width = hovered || selected ? 142 : 128;
    const height = hovered || selected ? 43 : 31;
    const candidates: Rect[] = [
      { x: screenBody.x + screenBody.radius + 25, y: screenBody.y - 20, width, height },
      { x: screenBody.x - screenBody.radius - width - 25, y: screenBody.y - 20, width, height },
      { x: screenBody.x + 18, y: screenBody.y + screenBody.radius + 20, width, height },
      { x: screenBody.x - width - 18, y: screenBody.y - screenBody.radius - height - 20, width, height },
    ];
    let label = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const overlap = occupied.reduce((sum, existing) => sum + overlapArea(candidate, existing), 0);
      const overflow = overflowArea(candidate, state.width, state.height);
      const score = overlap * 5 + overflow * 8;
      if (score < bestScore) {
        bestScore = score;
        label = candidate;
      }
    }
    label = {
      ...label,
      x: clamp(label.x, 8, Math.max(8, state.width - label.width - 8)),
      y: clamp(label.y, 34, Math.max(34, state.height - label.height - 8)),
    };
    occupied.push(label);

    const anchorX = label.x > screenBody.x ? label.x : label.x + label.width;
    const anchorY = clamp(screenBody.y, label.y + 5, label.y + label.height - 5);
    const elbowX = screenBody.x + (anchorX > screenBody.x ? 1 : -1) * (screenBody.radius + 13);
    context.strokeStyle = selected
      ? "rgba(255,255,255,0.64)"
      : "rgba(255,255,255,0.3)";
    context.lineWidth = 0.65;
    context.beginPath();
    context.moveTo(screenBody.x, screenBody.y);
    context.lineTo(elbowX, anchorY);
    context.lineTo(anchorX, anchorY);
    context.stroke();

    context.fillStyle = "rgba(2,2,2,0.8)";
    context.fillRect(label.x - 4, label.y - 3, label.width + 8, label.height + 6);
    context.fillStyle = selected ? "#ffffff" : "rgba(255,255,255,0.82)";
    context.fillText(
      `${body.name.toUpperCase()} / BODY ${String(entry.index).padStart(2, "0")}`,
      label.x,
      label.y,
    );
    context.fillStyle = "rgba(255,255,255,0.48)";
    context.fillText(`M  ${formatScientific(body.mass)} KG`, label.x, label.y + 13);
    if (hovered || selected) {
      const relativeSpeed = Math.hypot(
        body.velocity.x - state.referenceFrame.velocity.x,
        body.velocity.y - state.referenceFrame.velocity.y,
      );
      context.fillText(`V  ${formatSpeed(relativeSpeed)}`, label.x, label.y + 26);
    }
  }
  context.restore();
}

function drawScaleIndicator(context: CanvasRenderingContext2D, state: DrawState) {
  const distance = niceNumber(112 / state.camera.pixelsPerMeter);
  const pixels = distance * state.camera.pixelsPerMeter;
  const x = 22;
  const y = state.height - 23;
  if (!Number.isFinite(pixels) || pixels < 20) return;
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.65)";
  context.fillStyle = "rgba(255,255,255,0.62)";
  context.lineWidth = 0.8;
  context.beginPath();
  context.moveTo(x, y - 5);
  context.lineTo(x, y);
  context.lineTo(x + pixels, y);
  context.lineTo(x + pixels, y - 5);
  context.stroke();
  context.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillText(formatDistance(distance), x, y - 7);
  context.restore();
}

function drawEngineHud(context: CanvasRenderingContext2D, state: DrawState) {
  const x = 18;
  const y = 17;
  const fps = state.hud.fps ?? state.measuredFps;
  const timeScale = state.hud.timeScale ?? 1;
  const solver = state.hud.solver ?? "VELOCITY VERLET";
  const status = state.hud.status ?? "LIVE";
  context.save();
  context.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = "rgba(255,255,255,0.82)";
  context.fillText("N-BODY GRAVITY ENGINE", x, y);
  context.fillStyle = "rgba(255,255,255,0.4)";
  context.fillText(
    `OBJECTS ${String(state.bodies.length).padStart(2, "0")}  /  FPS ${Math.round(fps)
      .toString()
      .padStart(2, "0")}`,
    x,
    y + 15,
  );
  context.fillText(`TIME ×${formatCompact(timeScale)}  /  ${status.toUpperCase()}`, x, y + 28);
  context.fillText(`SOLVER ${solver.toUpperCase()}`, x, y + 41);
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.36)";
  context.fillText(`${(state.referenceFrame.label ?? "REFERENCE").toUpperCase()} FRAME`, state.width - 18, y);
  context.restore();
}

function drawReticle(context: CanvasRenderingContext2D, state: DrawState) {
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 0.65;
  context.beginPath();
  context.moveTo(centerX - 6, centerY);
  context.lineTo(centerX - 2, centerY);
  context.moveTo(centerX + 2, centerY);
  context.lineTo(centerX + 6, centerY);
  context.moveTo(centerX, centerY - 6);
  context.lineTo(centerX, centerY - 2);
  context.moveTo(centerX, centerY + 2);
  context.lineTo(centerX, centerY + 6);
  context.stroke();
  context.restore();
}

function absoluteToScreen(
  position: Vector2,
  camera: UniverseCamera,
  frame: UniverseReferenceFrame,
  size: Pick<CanvasSize, "width" | "height">,
): Vector2 {
  return {
    x: size.width / 2 + (position.x - frame.origin.x - camera.center.x) * camera.pixelsPerMeter,
    y: size.height / 2 - (position.y - frame.origin.y - camera.center.y) * camera.pixelsPerMeter,
  };
}

function screenToFrame(
  point: Vector2,
  camera: UniverseCamera,
  size: Pick<CanvasSize, "width" | "height">,
): Vector2 {
  return {
    x: camera.center.x + (point.x - size.width / 2) / camera.pixelsPerMeter,
    y: camera.center.y - (point.y - size.height / 2) / camera.pixelsPerMeter,
  };
}

function screenToAbsolute(
  point: Vector2,
  camera: UniverseCamera,
  frame: UniverseReferenceFrame,
  size: Pick<CanvasSize, "width" | "height">,
): Vector2 {
  const framePoint = screenToFrame(point, camera, size);
  return {
    x: framePoint.x + frame.origin.x,
    y: framePoint.y + frame.origin.y,
  };
}

function visualBodyRadius(
  body: CelestialBody,
  state: DrawState,
  minMass: number,
  maxMass: number,
) {
  const normalizedMass =
    maxMass > minMass
      ? (Math.log10(Math.max(body.mass, 1)) - minMass) / (maxMass - minMass)
      : 0.5;
  const legibilityRadius = 3.4 + normalizedMass * 4.8;
  return clamp(Math.max(body.radius * state.camera.pixelsPerMeter, legibilityRadius), 3.4, 34);
}

function hitTestBody(x: number, y: number, bodies: readonly BodyGeometry[]) {
  let nearest: BodyGeometry | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    const distance = squaredDistance(x, y, body.x, body.y);
    const hitRadius = Math.max(10, body.radius + 6);
    if (distance <= hitRadius ** 2 && distance < nearestDistance) {
      nearest = body;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function selectAdjacentBody(
  direction: -1 | 1,
  bodies: readonly CelestialBody[],
  selectedId: string | null | undefined,
  onSelect?: (bodyId: string | null) => void,
) {
  if (bodies.length === 0) return;
  const current = bodies.findIndex((body) => body.id === selectedId);
  const next = current < 0 ? 0 : (current + direction + bodies.length) % bodies.length;
  onSelect?.(bodies[next].id);
}

function sanitizeCamera(camera: UniverseCamera): UniverseCamera {
  return {
    center: {
      x: Number.isFinite(camera.center.x)
        ? clamp(camera.center.x, -MAX_CAMERA_COORDINATE, MAX_CAMERA_COORDINATE)
        : 0,
      y: Number.isFinite(camera.center.y)
        ? clamp(camera.center.y, -MAX_CAMERA_COORDINATE, MAX_CAMERA_COORDINATE)
        : 0,
    },
    pixelsPerMeter: clamp(
      finitePositive(camera.pixelsPerMeter, DEFAULT_CAMERA.pixelsPerMeter),
      MIN_ZOOM,
      MAX_ZOOM,
    ),
  };
}

function sanitizeReferenceFrame(frame: UniverseReferenceFrame): UniverseReferenceFrame {
  return {
    origin: {
      x: Number.isFinite(frame.origin.x) ? frame.origin.x : 0,
      y: Number.isFinite(frame.origin.y) ? frame.origin.y : 0,
    },
    velocity: {
      x: Number.isFinite(frame.velocity.x) ? frame.velocity.x : 0,
      y: Number.isFinite(frame.velocity.y) ? frame.velocity.y : 0,
    },
    label: frame.label,
  };
}

function niceNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

function formatScientific(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value
    .toExponential(3)
    .replace("e+", "E")
    .replace("e-", "E−")
    .replace("e", "E");
}

function formatDistance(metres: number) {
  const kilometres = Math.abs(metres) / 1_000;
  if (!Number.isFinite(kilometres)) return "—";
  if (kilometres >= 1e9) return `${formatCompact(kilometres / 1e9)}B KM`;
  if (kilometres >= 1e6) return `${formatCompact(kilometres / 1e6)}M KM`;
  if (kilometres >= 1e3) return `${formatCompact(kilometres / 1e3)}K KM`;
  if (kilometres >= 1) return `${formatCompact(kilometres)} KM`;
  return `${formatCompact(Math.abs(metres))} M`;
}

function formatSpeed(metresPerSecond: number) {
  return metresPerSecond >= 1_000
    ? `${formatCompact(metresPerSecond / 1_000)} KM/S`
    : `${formatCompact(metresPerSecond)} M/S`;
}

function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0.00";
  const absolute = Math.abs(value);
  if (absolute >= 1e4 || absolute < 0.01) return formatScientific(value);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Rect, b: Rect) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function overflowArea(rect: Rect, width: number, height: number) {
  const horizontal = Math.max(0, -rect.x) + Math.max(0, rect.x + rect.width - width);
  const vertical = Math.max(0, -rect.y) + Math.max(0, rect.y + rect.height - height);
  return horizontal * rect.height + vertical * rect.width;
}

function isNearViewport(
  x: number,
  y: number,
  margin: number,
  size: Pick<CanvasSize, "width" | "height">,
) {
  return x >= -margin && x <= size.width + margin && y >= -margin && y <= size.height + margin;
}

function squaredDistance(x1: number, y1: number, x2: number, y2: number) {
  return (x2 - x1) ** 2 + (y2 - y1) ** 2;
}

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
