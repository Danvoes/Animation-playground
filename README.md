# Animation Playground

A web app for drawing and making frame-by-frame animations.
It runs entirely in your web browser. There is nothing to install.

## How to open it

1. Download this project (on GitHub: green **Code** button → **Download ZIP**), then unzip it.
2. Double-click **`index.html`**. It opens in your web browser.

Use an up-to-date Chrome, Edge, Firefox or Safari.

## Saving your work

- **Automatic:** your project is saved in this browser a moment after every change
  ("Saved" appears next to the project name). Close the page and open it again later:
  your project comes back exactly as you left it.
- **Save to file** (menu, or Ctrl+S): saves the whole project as one `.anim` file, for
  backups or moving it to another computer or tablet. Keep copies of important work this way,
  because clearing your browser's data also clears what it saved automatically.
- **Open file** (menu, or Ctrl+O): opens a `.anim` file.
- **New:** starts an empty project. Give your project a name in the menu.

Undo history isn't kept when you close the page.

## The screen

- **Top bar, right:** Brush, Blend, Eraser, Pick color, Select, Transform, Layers, Color.
  Tap a tool to choose it; **tap it again** to open its settings.
- **Top bar, left:** the menu (project, view, touch settings, gestures, clear layer), the project
  name with its save status, and the zoom level (tap it to fit the canvas to the screen).
- **Side bar (left):** drag the top slider for **size** and the bottom slider for **opacity**
  (strength for the Blend tool), plus **Undo** and **Redo**.
- **Timeline (bottom):** play/stop, speed, onion skin, and the frames.

## What it can do

- **Brush** with 12 types: Pen, Ink, Pencil, Charcoal, Crayon, Marker, Soft brush,
  Watercolor, Airbrush, Splatter, Calligraphy, Glow
  - Size, opacity, smoothing (steadies shaky lines) and stylus pressure
  - Fine-tune each brush: **Taper** (thin ends), **Light touch** (size at light pressure),
    **Jitter** (rougher, hand-made line), and **Reset this brush**
- **Eraser** with size, opacity, softness and smoothing
- **Blend tool** with three modes: Smudge (drag paint), Soften (blur edges), Mix (blend colors like wet paint)
- **Layers** (up to 20): add, duplicate, delete, merge down, move up/down, rename,
  show/hide, lock, opacity, and blend modes (Normal, Multiply, Screen, Overlay, Add, Color)
- **Color wheel**: hue ring + brightness/vividness square, hex code box,
  previous/current color, the last 10 colors you used, and an eyedropper
- **Undo / Redo** (last 50 steps, including layer and frame changes)
- **Frames**: add, duplicate and delete frames from the strip at the bottom
- **Onion skin**: earlier frames show faintly in red, later frames in green (choose how many)
- **Playback**: Play / Stop with adjustable speed (1–30 frames per second)
- **Same on every frame**: a layer setting for backgrounds you draw once
- **Frame options** (tap the selected frame): hold a frame for longer, move it earlier/later,
  duplicate or delete it. **Drag frames** to reorder them (on touch screens, touch and hold first).
- **Playback modes** (Options button): Loop, Ping-pong (back and forth) or Once
- **QuickShape**: draw a line, circle, ellipse, rectangle or triangle, keep your pen down and
  hold still; it snaps into a clean shape (turn it off in the menu)
- **Color fill**: drag the color circle from the top bar onto an area to fill it
  ("Fill gaps" in the menu controls how far the fill spreads)
- **Pick a color** with the Pick color tool, **Alt + click** (Option + click on Mac), or
  **touch and hold** with a finger when finger drawing is off
- **Select** an area (freehand or rectangle). While something is selected, drawing, erasing,
  blending and filling only change the inside. Tap Select again for: Select all, Deselect,
  Invert, Copy to new layer, Fill with color, Erase inside.
- **Transform**: move, resize and rotate the selection (or the whole layer if nothing is
  selected). Drag inside to move, drag a corner to resize, drag the round handle to rotate.
  Also: Keep proportions, Flip, Rotate 90°, Reset, Cancel, Done.
- **Zoom, rotate and move the canvas**
- Works with mouse, finger and stylus, with **palm rejection**: once a stylus is used,
  fingers stop drawing (they still zoom, rotate and undo). Change this in the menu.

### Touch gestures

| Gesture | Does |
| --- | --- |
| Pinch with two fingers | Zoom, rotate and move the canvas |
| Tap with two fingers | Undo |
| Tap with three fingers | Redo |
| Touch and hold (finger drawing off) | Pick a color |
| Hold still at the end of a stroke | QuickShape |

### Mouse and keyboard

| Key / action | Does |
| --- | --- |
| Mouse wheel | Zoom |
| Shift + mouse wheel | Rotate |
| Right-click and drag | Move the canvas |
| Alt + click (Option + click on Mac) | Pick a color |
| 0 | Fit canvas to screen |
| + / − | Zoom in / out |
| Ctrl+S / Ctrl+O | Save to file / Open file |
| Ctrl+Z (Cmd+Z on Mac) | Undo |
| Ctrl+Y or Ctrl+Shift+Z | Redo |
| B / E / S / I | Brush / Eraser / Blend / Pick color |
| L / V | Select / Transform |
| Ctrl+A / Ctrl+D | Select all / Deselect |
| Enter | Finish a transform |
| [ and ] | Smaller / bigger brush |
| Space | Play / stop |
| ← → (or , .) | Previous / next frame |
| O | Onion skin on / off |
| Esc | Close a panel, cancel a transform, or deselect |

## Project files

| File | What it is |
| --- | --- |
| `index.html` | The page: top bar, side bar, canvas, timeline, panels |
| `css/style.css` | How it looks |
| `js/app.js` | The main program that connects everything |
| `js/brushes.js` | How each brush paints |
| `js/blendtool.js` | The Blend tool (smudge, soften, mix) |
| `js/quickshape.js` | QuickShape (turns rough shapes into clean ones) |
| `js/color.js` | The color wheel |
| `js/history.js` | Undo / redo |
| `js/storage.js` | Saving in the browser, and project files |

## Coming next

- **Stage 3:** importing images
- **Stage 4:** audio
- **Stage 6:** exporting video with audio
