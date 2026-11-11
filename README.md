# Animation Playground

A simple web app for drawing and (soon) making frame-by-frame animations.
It runs entirely in your web browser. There is nothing to install.

## How to open it

1. Download this project (on GitHub: green **Code** button → **Download ZIP**), then unzip it.
2. Double-click **`index.html`**. It opens in your web browser.

Use an up-to-date Chrome, Edge, Firefox or Safari.

## What's here so far (Stage 1)

- **Brush** with 6 types: Pen, Pencil, Marker, Soft brush, Airbrush, Calligraphy
  - Size, opacity, smoothing (steadies shaky lines) and stylus pressure
- **Eraser** with size, softness and smoothing
- **Blend tool** with three modes: Smudge (drag paint), Soften (blur edges), Mix (blend colors like wet paint)
- **Layers** (up to 20): add, duplicate, delete, merge down, move up/down, rename,
  show/hide, lock, opacity, and blend modes (Normal, Multiply, Screen, Overlay, Add, Color)
- **Color wheel**: hue ring + brightness/vividness square, hex code box,
  previous/current color, the last 10 colors you used, and an eyedropper
- **Pick color** tool: tap your drawing to grab a color from it
- **Undo / Redo** (last 50 steps, including layer changes) and **Clear** (clears the selected layer)
- **Frames**: add, duplicate and delete frames from the strip at the bottom
- **Onion skin**: earlier frames show faintly in red, later frames in green (choose how many)
- **Playback**: Play / Stop with adjustable speed (1–30 frames per second)
- **Same on every frame**: a layer setting for backgrounds you draw once
- Works with mouse, finger and stylus

### Keyboard shortcuts

| Key | Does |
| --- | --- |
| Ctrl+Z (Cmd+Z on Mac) | Undo |
| Ctrl+Y or Ctrl+Shift+Z | Redo |
| B / E / S / I | Brush / Eraser / Blend / Pick color |
| [ and ] | Smaller / bigger brush |
| Space | Play / stop |
| ← → (or , .) | Previous / next frame |
| O | Onion skin on / off |
| Esc | Close a panel |

## Project files

| File | What it is |
| --- | --- |
| `index.html` | The page: toolbar, canvas, panels |
| `css/style.css` | How it looks |
| `js/app.js` | The main program that connects everything |
| `js/brushes.js` | How each brush paints |
| `js/blendtool.js` | The Blend tool (smudge, soften, mix) |
| `js/color.js` | The color wheel |
| `js/history.js` | Undo / redo |

## Coming next

- **Stage 3:** importing images
- **Stage 4:** audio
- **Stage 5:** saving and reopening projects
- **Stage 6:** exporting video with audio
