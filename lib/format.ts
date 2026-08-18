const SUPERSCRIPTS: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

export function formatScientific(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const [coefficient, exponent = "0"] = value.toExponential(digits).split("e");
  const prettyExponent = exponent.replace("+", "").split("").map((character) => SUPERSCRIPTS[character] ?? character).join("");
  return `${Number(coefficient)} × 10${prettyExponent}`;
}

export function formatCompact(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute === 0) return "0";
  if (absolute >= 1e9 || absolute < 1e-3) return value.toExponential(digits).replace("e+", "e").toUpperCase();
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function formatDistance(metres: number): string {
  const absolute = Math.abs(metres);
  if (absolute >= 1e12) return `${formatCompact(metres / 1e9, 2)}M KM`;
  if (absolute >= 1e9) return `${formatCompact(metres / 1e9, 2)}M KM`;
  if (absolute >= 1e6) return `${formatCompact(metres / 1e3, 1)} KM`;
  if (absolute >= 1e3) return `${formatCompact(metres / 1e3, 2)} KM`;
  return `${formatCompact(metres, 2)} M`;
}

export function formatVelocity(metresPerSecond: number): string {
  return `${formatCompact(metresPerSecond / 1e3, 3)} KM/S`;
}

export function formatAcceleration(metresPerSecondSquared: number): string {
  return `${formatCompact(metresPerSecondSquared, 4)} M/S²`;
}

export function formatMass(kilograms: number): string {
  return `${formatScientific(kilograms, 3)} KG`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return `${String(days).padStart(4, "0")}:${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function magnitude(vector: { x: number; y: number }): number {
  return Math.hypot(vector.x, vector.y);
}

export function inputNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
