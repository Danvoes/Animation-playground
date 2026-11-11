# Playground

A web app for drawing and making frame-by-frame animations.
It runs entirely in your web browser. There is nothing to install.

## How to open it

1. Download this project (on GitHub: green **Code** button → **Download ZIP**), then unzip it.
2. Double-click **`index.html`**. It opens in your web browser.

Use an up-to-date Chrome, Edge, Firefox or Safari.

## Saving your work and your projects

- **My projects (gallery):** tap the project name at the top (or **My projects** in the menu) to see
  all your projects with a picture, when you last edited them and how many frames they have.
  Tap one to open it. Each card can be renamed, duplicated or deleted.
- **+ New project** starts a fresh project; the one you were working on stays in the gallery.
- **Automatic saving:** every project saves itself in this browser a moment after each change
  ("Saved" appears next to the project name), along with its time-lapse, sounds, palettes and puppets.
  When you come back, the project you had open last opens again.
- **Save to file** (menu, or Ctrl+S): saves the project as one `.anim` file, for backups or moving it
  to another computer or tablet. **Open file** (Ctrl+O) adds a `.anim` file to your gallery as a new project.
- No login is needed: projects live in this browser on this device. Clearing the browser's data
  also clears them, so keep important projects as files too (a cloud folder like iCloud Drive or
  Google Drive is a good place for them).

Undo history isn't kept when you close the page.

## Adding pictures

Open the menu and use **Insert image**:

- **On this frame:** the picture goes on a new layer above the current one, and Transform opens
  so you can move, resize or rotate it. To trace over it, lower that layer's opacity in Layers.
- **As background:** the picture goes on a new bottom layer that shows on every frame.
- **Several pictures as frames:** choose several pictures; each becomes its own frame
  (in file-name order) on a new layer. Great for stop-motion photos.

Big pictures are shrunk to fit the canvas. You can also **drag pictures onto the canvas**
(several at once become frames) or **paste** one with Ctrl+V.

## Adding sound

Tap **Sound** in the timeline:

- **+ Add sound file:** music or any sound (MP3, WAV, M4A, OGG). Up to 8 sounds.
- **● Record voice:** records from your microphone while the animation plays from the current
  frame, so you can speak in time with it. Press **Stop rec.** (or let the animation finish) to stop.
- For each sound: **Starts at** (when it begins, in seconds from frame 1; **This frame** sets it
  to the frame you're on), **Skip first** (cut a slow start), **Volume**, mute and delete.

Sound plays with the animation in **Loop** and **Once** modes, perfectly in step (in Loop it starts
again each time round). The frame thumbnails show a small waveform, so you can see where words or
beats land. Sounds are saved with your project.

## Color matching and palettes

- **Pick any color you can see** (backgrounds, photos, puppets): the Pick color tool,
  **Alt + click**, touch and hold, or the eyedropper in the Color panel. The color wheel jumps to that
  exact color and shows its hex code.
- **Palette from picture** (Color panel): choose 6, 8 or 12 colors, then **This frame**, the
  **Selection**, or a **Picture file…** (it isn't added to your drawing). Playground finds the main
  colors and saves them as a palette. Each one is a color that really appears in the picture.
- **Palettes** are saved with your project: tap a color to use it, **+** adds the current color,
  **Edit** lets you tap colors to remove them, ✎ renames, × deletes. **+ New palette** starts one.

## Rigging (puppet animation)

Build a character from separate parts joined at joints, pose it on a few frames, and let
Playground animate the frames in between.

1. **Draw the parts** of your character (head, body, upper arm, lower arm…) a little apart.
2. **Make parts:** circle one part with **Select**, tap the **Rig** tool twice to open
   *Puppet parts*, and tap **Make a part** (give it a name). It moves onto a "Puppet" layer and
   into your parts library. Repeat for every part.
3. **Set up joints** (Rig tool → *Set up joints*): tap a part, drag its dot onto the joint
   (for example the shoulder), tap **Attach to…**, then tap the part it hangs from.
   You can also drag parts into place, change their order (Forward/Back) or remove them.
4. **Pose** (Rig tool → *Pose*): drag a part to bend it at its joint; drag the main part to move
   the whole puppet (round handle = turn, square handle = size). Posing a frame makes it a
   **key pose** (◆ in the frame strip).
5. **In-betweens:** pose a later frame too. Every frame between two key poses moves smoothly by
   itself (turn **Smooth** off for an even, mechanical speed). Need more in-betweens? *Puppet parts*
   → **Add frames**.
6. **Edit a part's drawing** once (*Set up joints* → select it → **Edit drawing**) and it changes on
   every frame where it's used.

Tap a part in the *Puppet parts* library to add another copy of it to the puppet.

## Timing

- Every frame in the strip shows the **time it starts** (for example `0.50s`), based on the speed
  and any held frames. Turn this off under **Options → Show times on frames**.
- Next to the frames you can see **where you are**: `4 / 12` and `1.00 s / 3.00 s`.
  **Tap it to jump to a time** (type seconds, like `1.5`).
- Tap the selected frame to see exactly when it starts and how long it stays on screen.

## Time-lapse

Playground quietly records a small snapshot every time you change something. Open **Export**:

- **Watch replay:** see how your artwork was made (play/pause, or drag the slider).
- **Export replay video:** save the replay as a video (3–30 seconds, ending on the finished picture).
- **Record time-lapse:** turn recording on or off.

The time-lapse is kept with your project in this browser. Starting a new project or opening a file
starts a fresh time-lapse (it isn't included in `.anim` files).

## Exporting a video

Tap the **Export** button (arrow out of a box, top left):

- **Size:** Small (640×360), HD (1280×720) or Full HD (1920×1080).
- **Play through:** once, 2 times or 3 times.
- **Include sound:** adds your sounds to the video.
- **Export video:** the animation plays into a recorder, so it takes as long as the video lasts.
  Keep the tab open and in front until it finishes. The video goes to your Downloads folder.
- **Save this frame as a picture (PNG).**

The format is **MP4** in recent Chrome, Edge and Safari (plays almost everywhere), and **WebM** in
Firefox (plays in browsers, VLC and on YouTube).

## The screen

- **Top bar, right:** Brush, Blend, Eraser, Pick color, Select, Transform, Rig, Layers, Color.
  (On phones, Pick color lives in the Color panel; you can also touch and hold.)
  Tap a tool to choose it; **tap it again** to open its settings.
- **Top bar, left:** the menu (project, insert image, view, touch settings, gestures, clear layer),
  Export, the project name with its save status, and the zoom level (tap it to fit the canvas).
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
| L / V / R | Select / Transform / Rig |
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
| `js/audio.js` | Sound: decoding, waveforms and in-sync playback |
| `js/rig.js` | Rigging: joints, poses and automatic in-betweens |

## Ideas for later

- A gallery of several projects inside the app
- Exporting animated GIFs or a set of PNG frames
- Putting the app online with GitHub Pages so it opens from a web address on any device
