# Riptide — design spec

The source of truth for every pixel and every movement in the app. Written before the UI, from the
direction the taste skill dealt (`.taste-skill/direction.json`, seed 1734374823: *The product
performs* · Clash Grotesk · *Lunar and bronze* · shutter), adapted from a web page to an app shell.

## 1. The idea

A riptide is a narrow, fast current that pulls everything outward. Undercurrent, the engine beneath
it, is the fastest BitTorrent engine measured. So:

> In this app, **the current that names the app and its engine** becomes **the motion language**: every moving
> thing is data flowing, and it flows exactly as fast as the bytes do.

Competitor test: put qBittorrent or Transmission in that sentence and it stops working. Neither has a
name that is a current, and neither moves at the speed of its own transfers.

**The live thing:** *The current*, a field of streamlines in the sidebar. Its speed, density and
colour come from the real engine totals: bronze lines are bytes coming in, sea lines are bytes going
out. When nothing transfers it falls almost still. You can tell how fast you are downloading from
across the room.

## 2. Principles

1. **Function first, motion second.** Every list, button and number works and reads with motion
   turned off. Motion graphics only live where nothing has to be read or clicked: the sidebar
   current, empty states, the drop overlay and the About page.
2. **Experimental, contained.** Decorative canvases sit under `pointer-events: none`, never under
   text, run at most 30 fps, cap device pixel ratio at 2, and pause when the window is hidden. Under
   `prefers-reduced-motion` they draw a single still frame.
3. **Numbers never jitter.** All figures use tabular numerals and animate between values instead of
   jumping.
4. **Tone, not lines.** Surfaces are told apart by a step in tone. No hairline dividers, no outlined
   boxes, no shadows on things at rest.

## 3. Colour — Lunar and bronze

| Token | Value | Role |
|---|---|---|
| `--bg` | `#111111` | The ground, about 80% of the window |
| `--surface` | `#1c1c1c` | Sidebar, toolbar fields, the details drawer, inputs |
| `--surface-2` | `#262626` | Hovered and selected rows, active tab, pressed states (one extra step: an app needs a selection tone that a page doesn't) |
| `--ink` | `#f2f2f2` | Text and strong marks, including progress fill |
| `--muted` | `#8f8f8f` | Secondary text (5.4:1 on `--surface`) |
| `--accent` | `#a08672` | Bronze: the primary action, inbound data, the active filter marker. Under 5% of any screen |
| `--accent-ink` | `#111111` | Text on bronze |
| `--sea` | `#6f9a93` | Outbound data, only in visualisations and upload figures |
| `--danger` | `#d26a5c` | Errors and the destructive confirm, nothing else |

Banned: gradients (the one exception is a neutral scrim), glass and backdrop blur, glows, violet or
indigo, cream with terracotta.

## 4. Type

Two faces, both from the Indian Type Foundry (ITF Free Font Licence), bundled in the app so it works
offline.

- **Clash Grotesk** (display): weight 400–500, tracking −0.03em, leading 0.95. Used for the wordmark,
  view titles and the big throughput figure. It has no tabular figures, so it never sets a number that
  changes, except the one large rate figure, which is set in Satoshi.
- **Satoshi** (interface): 400 body, 500 emphasis, 700 for the large figure. `font-variant-numeric:
  tabular-nums` on every number.

Five sizes, no more:

| Step | Size | Use |
|---|---|---|
| `--step-small` | 13px | Meta: sizes, peers, ETA, status bar |
| `--step-body` | 14px | Rows, controls, form text |
| `--step-lead` | 18px | Drawer and dialog headings |
| `--step-head` | 30px | View titles, empty-state statement |
| `--step-figure` | 56px | The current's rate figure |

Sentence case everywhere. No eyebrows, no tiny tracked capitals, no monospace (hashes and addresses
are set in Satoshi with tabular figures), no index numbers.

## 5. Layout

```
┌───────────────┬──────────────────────────────────────────────────────┐
│ ● ● ●         │  Add torrent  [ search ]                  sort  ⋯   │  52px drag bar
│ Riptide       ├──────────────────────────────────────────────────────┤
│               │  name                     size   done   ↓    ↑  eta │
│ All        12 │  ███████████░░░░░░░░                                │
│ Downloading 3 │  …rows…                                              │
│ Seeding     6 │                                                      │
│ Completed   2 ├──────────────────────────────────────────────────────┤
│ Paused      1 │  details drawer: Overview Files Peers Trackers Pieces│
│               │                                                      │
│ 84.2 MB/s     │                                                      │
│ ≈≈ current ≈≈ │                                                      │
├───────────────┴──────────────────────────────────────────────────────┤
│ DHT 312 nodes · port 51413 · 48 peers                ↓ 84 MB/s ↑ 2 MB/s│ status bar
└──────────────────────────────────────────────────────────────────────┘
```

- **Window:** 1200×780 by default, minimum 880×560, `hiddenInset` title bar so the traffic lights
  sit inside the sidebar. The top 52px is the drag region.
- **Sidebar** (240px, `--surface`): wordmark, filters with counts, Settings. The lower part belongs
  to *the current*: the live rate figure above, the streamline canvas below, bleeding to the edges.
- **Torrent list:** real rows, not cards. 56px tall: the name and a state line on the left, figures
  in right-aligned tabular columns, and a 4px progress bar along the bottom of the row. Rows are
  separated by 2px of ground, not lines. Selected rows take `--surface-2`.
- **Details drawer:** unfolds beneath its row, tabs as filled pills. The open row is the drawer's
  title (its name is never repeated inside). Overview reads in three columns: progress (the large
  figure and the piece ribbon), the record (totals, ratio, milestones), then the controls (folder,
  limits, copy). Nothing the row's columns already show is repeated.
- **Dialogs** (add, create, confirm) are the only things with a shadow, because they float.
- **Status bar** (28px): network health on the left, totals on the right.
- One radius for the whole app: 6px. Buttons are 6px rectangles, one fill. Primary is bronze.

## 6. Motion

Tokens (from the taste skill):

```css
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
--ease-in-out: cubic-bezier(0.76, 0, 0.24, 1);
--ease-soft: cubic-bezier(0.33, 1, 0.68, 1);
--t-press: 140ms; --t-hover: 180ms; --t-ui: 240ms; --t-reveal: 800ms;
```

**Signature, the loud one:** *the current* (section 1), drawn on canvas from live totals.

**Shutter** (the dealt move): the details drawer opens with `clip-path` from the row it belongs to,
over about 450ms; closing takes about 70% as long. Openings use `--ease-out` so the panel answers the
click at once; closings use `--ease-in-out`.

**Tide** (the shutter, in the app's own element; `lib/tide.ts`): floating panels — the traffic panel,
dialogs and the command palette — open behind a water line that rises from the bottom edge (pours
from the top, for the palette) with a swell over where it came from: the sparkline for the traffic
panel, the middle for the rest. The ripple dies away as the water lands, so the opened panel is an
exact rectangle. Its bands surface as the water passes them, nearest the source first, 60ms apart.
Closing drains it in a little over half the time. The panel is measured after its contents lay out
and again whenever it resizes, so the water always covers all of it. The shadow is never drawn
from the clip: it sits on a layer of its own behind the surface and surfaces over the last fifth of
the rise, once the water has nearly landed, and goes first when it drains. (A drop-shadow filter
recomputed from the moving water line flickers in WebKit and leaves a smear as the water drains.)
Under reduced motion they simply fade.

**Functional motion, quiet and fast:**

| Where | What | Why |
|---|---|---|
| Rows | A new torrent's row opens from height 0 and its bar fills from the left, once | Shows where the new thing went |
| Progress bars | `transform: scaleX` eases to each new value. On an active download a flow texture moves along the filled part, its speed scaled to that torrent's rate | Shows data flowing without reading a number |
| Completion | One bronze wave runs along the bar, then it settles to ink | Confirms the finish |
| Figures | Rates and totals tween between samples over 400ms | Numbers never jump |
| Pieces tab | Newly verified pieces bloom in (scale 0.6 → 1, opacity) | Shows the picker at work |
| Controls | Press scale 0.97 (140ms); hover is a tone step (180ms); menus scale from 0.97 at their trigger | Feedback under the hand |
| Drop overlay | Dragging a file over the window: rings contract toward the pointer, pulled in like a current | Experimental, decorative, says "let go" |
| Empty state | A slow single streamline crosses below the statement | Decorative |
| Swarm tab | Peers on orbits set by their round trip; bronze packets stream in and sea packets out at each peer's real rate; peers bloom in and fade out | Shows the swarm working; the Peers table has the same data to read |
| Opening a row | The row grows and its name swells to 24px in the display face, a wave running letter by letter; the row's bar steps aside because the drawer now carries progress. Closing folds the row back with the drawer: the large name shrinks as one piece and fades, then the row's own name returns beneath it | The name becomes the title without being printed twice |
| Piece ribbon | Every piece as a sliver, cut into its files, in the torrent's tone; fresh pieces flash bright and settle. Pointing reads out the file there; clicking opens Files | Shows where in the torrent the data is landing |
| Drawer tabs | The body enters from the side you moved toward | Says which way you went |
| Traffic panel | The tide, rising from the status bar with its swell over the sparkline; the chart fills up from its baseline and the figures count up | Grows out of the thing you clicked, in the app's own element |
| Command palette | The tide, pouring down from the top edge; a bronze-edged pill glides to the active row | Says where you are without a jump |
| Slow tide | The switch's wave icon sways gently while it's on; painted schedule hours fill upward | Confirms the mode at a glance |

Never: bounce or elastic easing, the same fade on everything, loops that mean nothing, animating
layout properties (except `grid-template-rows` for row height), content hidden behind a script.

**Reduced motion** keeps opacity and colour changes, removes travel, scale and every loop, and
renders the canvases as one still frame.

## 7. Voice

Short, plain, specific. "Add torrent", not "Get started". "Seeding to 4 peers", not "Active". Errors
say what happened and what to do: "Couldn't write to ~/Downloads: the disk is full. Free some space,
then resume."

## 8. What the taste skill doesn't cover

The skill is written for public web pages and says it is not for app screens. Its page-level rules
(picture floors, hero blueprints, section variety) don't apply here. Its house rules, type laws,
colour proportions and motion recipes do, with two app conventions it permits inside `data-ui`
fragments: form fields and the file tree may use 1px control borders, and icons are used for toolbar
actions (one stroke set, 1.5px, 16px).
