# Aphelion Gravity Lab

Aphelion Gravity Lab is an interactive N-body gravity simulator for Windows. It runs locally as a standalone Electron app, works offline, and includes editable celestial bodies, orbital presets, trails, force vectors, predictions, diagnostics, and collision handling.

## Download

Download the latest portable Windows executable from this repository's **Releases** page. No installer, Node.js, or browser is required to run the packaged app.

Windows may show a SmartScreen warning because the executable is not code-signed. Confirm that the publisher is unknown only if you downloaded it from this repository.

## Run from source

Requirements:

- Node.js 22.13 or newer
- Windows 10 or 11 for packaging the `.exe`

```powershell
npm install
npm run desktop:run
```

## Useful commands

```powershell
npm test                 # Build and run the complete test suite
npm run lint             # Run ESLint
npm run desktop:typecheck
npm run desktop:smoke    # Build and launch an automated desktop smoke test
npm run desktop:package  # Create the portable Windows executable
```

Packaged files are written to `release/` and are intentionally excluded from Git history. Published executables are attached to GitHub Releases instead.

## Stability safeguards

The desktop build bounds physics work per frame, caps expensive rendering loops, pauses while hidden, validates numerical inputs, and records renderer failures in the app's user-data log. A dedicated endurance mode exercises 32 bodies at 10x simulation speed before release.

## Physics

The simulation uses SI units and supports velocity Verlet and symplectic Euler integration, elastic or merge collision modes, fixed bodies, reference frames, trajectory prediction, and conservation diagnostics. Presets include Sun–Earth–Moon, Earth–Moon, binary stars, a chaotic three-body system, a stable orbit, a collision course, and a seeded random system.

## Project layout

- `app/components/` — simulator controls and canvas renderer
- `lib/` — physics engine and presets
- `desktop/` — Electron entry point and local renderer
- `tests/` — physics and rendered-output regression tests

## License

No open-source license has been granted. All rights are reserved by the repository owner.
