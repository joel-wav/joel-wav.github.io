---
layout: post
title: "The drone on this site: A*, a velocity loop and a lot of edge cases"
tags: [planning, controls, javascript]
---

If you're on a desktop, there's a small quadcopter flying behind this page. It takes off from the
pad in the header, follows your cursor around every box on the page, and flies home to land when
you stop moving the mouse. This post is how it works. It's a toy, but it's built from the same
pieces as real autonomy stacks: a map, a planner, a path follower and a controller. Most of the
work, as usual, went into edge cases.

## 1. The map: an occupancy grid built from the DOM

The drone needs to know where it can't fly. Every frame I measure the page's "boxes" (cards, the
terminal, buttons, code blocks) with `getBoundingClientRect()` and rasterise them onto a grid of
12 px cells. Plain text and headings aren't obstacles; the drone flies under them.

Each box is **inflated by 26 px**, roughly the drone's radius plus a margin. That's the standard
configuration-space trick: inflate the obstacles and you can plan for a *point* instead of a
drone-shaped object.

```js
for (const el of obstacleEls) {
  const r = el.getBoundingClientRect();
  // mark every cell within INFLATE px of the box as occupied
  for (let y = r0; y <= r1; y++) grid.fill(1, y * cols + c0, y * cols + c1 + 1);
}
```

## 2. The planner: A* plus string-pulling

Every 100 ms (or immediately on scroll) the drone runs **A\*** from its cell to the cursor's cell:
8-connected, octile-distance heuristic, and no diagonal moves that clip a corner. A viewport-sized
grid is only ~8,000 cells, so running it ten times a second is cheap.

Raw grid paths zig-zag, so the result goes through a greedy **string-pulling** pass: from each
point, skip ahead to the furthest waypoint that's still in line of sight. You get near-shortest,
any-angle paths with only a handful of waypoints. That's the `A* n wp` count in the telemetry
label.

## 3. The follower and the controller

The drone doesn't snap to waypoints. Each frame it aims at the furthest of the next few waypoints
it can see, and a **velocity loop** produces the acceleration:

- desired speed = `min(v_max, sqrt(2·a·d_remaining))`, a braking profile, so it decelerates
  smoothly into the goal instead of overshooting wildly;
- acceleration = `k·(v_desired − v)`, clamped to `a_max`;
- a first-order lag on that acceleration, so the *attitude* changes smoothly.

The tilt you see is just foreshortening along the acceleration vector: a multirotor tilts the way
it accelerates. Heading slowly turns to face the direction of travel, and there's a tiny bob when
hovering.

## 4. The edge cases (where the real work was)

**Scrolling moves the obstacles.** The drone lives in screen coordinates, so when you scroll the
boxes move and the drone doesn't. My first version only noticed every 100 ms and simply let the
box slide over it. Now every frame checks a 24 px keep-out zone. If a box edge sweeps in, the drone
is **pushed** to the nearest free spot and loses the velocity component pointing into the box.

**Waiting.** If you've scrolled so a box covers your cursor, there's no valid goal. The drone
enters `WAIT` and, importantly, **sticks to the page** rather than the screen. Scrolling carries it
along with the content, even off-screen, instead of the box shoving it around its edges.

**Coming back from off-screen.** The grid normally covers only the viewport, so a drone waiting
off-screen couldn't plan its way back. The fix was to grow the grid to cover wherever the drone (or
its goal) is, including the off-screen parts of the boxes. Far off-screen the drone may fly up to
3× faster, easing back to normal speed at the screen edge, so you never see the fast part.

**The bug I'm proudest of finding.** Scrolling *up* through the page worked, but scrolling *down*
left the drone stranded off-screen forever. The sticky nav bar spans the whole width of the top of
the screen, so for a drone above the viewport it was a perfect wall, and A* correctly reported
`NO PATH`. The nav never moves relative to the screen, so now it only counts as an obstacle when
the whole trip is on screen, and it never pushes the drone.

## 5. The ground station

The pad at the top of every page (in the header here, in the hero on the home page) is the drone's home. A small state machine runs on top of everything:

`LANDED → TAKEOFF → FLY ⇄ RTL → LANDING → LANDED`

- It starts landed and takes off on the first mouse movement.
- After **8 s without mouse movement**, or when the cursor leaves the window, it does a
  **return-to-launch (RTL)**: it plans a path back to the pad (scrolling off-screen if the pad is
  above you) and lands.
- Clicking the pad also triggers RTL, and then it stays down until you click the pad again.

## 6. Testing something you can't screenshot

I used CLAUDE to build small test pages with known obstacles, drove the drone with synthetic pointer and scroll
events, recorded its trajectory every frame, and checked it numerically:

- it never enters a box, and keeps at least ~24 px of clearance;
- in a two-wall test, the flown path was within ~8% of the ideal shortest path around the inflated corners;
- after waiting off-screen it resumes from exactly where it waited, with no teleporting.

software-in-the-loop testing for a website. Old habits.

## 7. Being a good citizen

- It never blocks clicks.
- It's off entirely for visitors with *reduce motion* set.
- There's a `[drone: on/off]` switch in the nav, remembered per browser.
- It's one dependency-free JavaScript file.

The source is in this site's repo under `assets/js/drone.js`.
