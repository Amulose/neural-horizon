# NEURAL HORIZON

A deep-space observatory interface built entirely with vanilla HTML, CSS, and JavaScript
No frameworks, no libraries, no external assets

It generates a procedural, pointer-reactive star field on a Canvas 2D surface with three distinct viewing modes:
- **ORBITAL** structured grid with orbiting particles
- **WARP** heavy distortion around your cursor
- **SCAN** a radar-style sweep line

The UI is a monochrome brutalist instrument panel with live telemetry, working sliders, and a continuous scrolling browser tab title

Audio runs natively through the Web Audio API. It includes a synthesized ambient drone, interface beeps, and a mode-transition sweep. If you grant microphone access, the analyser data drives the visuals in real time and feeds the diagnostics drawer

## Launch

You can view the live version hosted on GitHub Pages at:
`https://amulose.github.io/neural-horizon/`

If you are running it locally, you need a secure context (`localhost` or `https`) if you want to use the microphone. Opening the file directly via `file://` works for everything else

From the project directory:
```bash
python3 -m http.server 8000
