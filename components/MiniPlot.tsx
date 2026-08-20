"use client";

import { useEffect, useRef } from "react";

interface MiniPlotProps {
  values: readonly number[];
  label: string;
}

export function MiniPlot({ values, label }: MiniPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const valuesRef = useRef(values);
  const labelRef = useRef(label);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const rectangle = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(rectangle.width * ratio));
      const pixelHeight = Math.max(1, Math.round(rectangle.height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rectangle.width, rectangle.height);
      context.strokeStyle = "#252522";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, rectangle.height - 0.5);
      context.lineTo(rectangle.width, rectangle.height - 0.5);
      context.stroke();

      const currentValues = valuesRef.current;
      if (currentValues.length < 2) return;
      const finite = currentValues.filter(Number.isFinite);
      if (finite.length < 2) return;
      const minimum = Math.min(...finite);
      const maximum = Math.max(...finite);
      const span = maximum - minimum || Math.abs(maximum) * 0.02 || 1;
      context.strokeStyle = "#dadad4";
      context.lineWidth = 1;
      context.beginPath();
      currentValues.forEach((value, index) => {
        const x = (index / Math.max(1, currentValues.length - 1)) * rectangle.width;
        const y = rectangle.height - 4 - ((value - minimum) / span) * (rectangle.height - 8);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      context.fillStyle = "#777771";
      context.font = "7px monospace";
      context.fillText(labelRef.current.toUpperCase(), 5, 10);
    };

    drawRef.current = draw;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      drawRef.current = null;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    valuesRef.current = values;
    labelRef.current = label;
    drawRef.current?.();
  }, [label, values]);

  return <canvas className="mini-plot" ref={canvasRef} role="img" aria-label={`${label} history graph`} />;
}
