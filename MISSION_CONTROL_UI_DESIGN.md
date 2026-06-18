# Mission Control UI Design

Date: 2026-06-13
Scope: OpenGoal plugin + OpenCode desktop/app UI surfaces touched by the mission-control upgrade
Status: approved in brainstorming, pending written-spec review

## Goal

Upgrade the current OpenCode/OpenGoal interface into a sharper, denser, more legible mission-control variant without making it feel like a different product.

This is not a visual fork. It should still read as OpenCode, but with:

- stronger hierarchy
- less sparse and plain layout
- clearer action exposure
- more obvious resize affordances
- better contrast, outlines, and grouping
- a much more usable goal/control surface

The product direction is:

- home page: `Global Ops Board`
- active session: `conversation-first work surface`
- right sidebar: `Dual-Band Dock`
- visual language: `steel-and-signal` with `operator-console` accents

## Product Principles

1. Controls and status both matter.
The interface must keep high-value controls and high-value status visible at the same time.

2. Conversation stays primary in-session.
The center timeline is still the main work surface. The dock exists to support the work, not replace it.

3. The dock is an operations surface, not a passive info card.
The goal sidebar must expose actions, budgets, steps, activity, and history in a denser and more intentional layout.

4. History must not disturb the live run.
Inspecting older runs should open nested detail, not replace or collapse the current run surface.

5. Resizing must feel real.
Resize handles must be visible, discoverable, and reliably interactive.

6. OpenCode identity is preserved.
The redesign should feel like a stronger OpenCode, not a detached re-theme.

## Surface 1: Home Page

### Target shape

The home page becomes a `Global Ops Board`.

Instead of a sparse launcher, it should provide an operational overview across projects, sessions, goals, and system attention items.

### Layout

#### Top metrics band

Always-visible counters:

- Projects
- Live Sessions
- Active Goals
- Needs Attention

These should be the first strong visual anchor on the page and should read as at-a-glance system state.

#### Main live board

A central board that shows active and recent work across projects.

Each entry should make it easy to identify:

- project/repo
- session identity
- current goal title
- current run state: active, paused, achieved, stalled, stopped
- progress or last known movement
- whether it needs attention

This should be easy to scan in one pass without opening each session.

#### Primary actions box

A clearly boxed action cluster on the right or upper-right containing the most common operations:

- New Session
- Resume Last
- Open Goal
- Open Project

These should not be hidden in tiny low-contrast controls.

#### Alerts/attention box

A secondary status area for important interrupts, including:

- runs that hit turn limits
- runs that hit time limits
- failed or stalled jobs
- work waiting for input

This should be compact but visually louder than normal status text.

### Visual direction

- denser cards
- stronger borders
- clearer grouping
- better scanability
- less dead space
- stronger hierarchy than the current launcher

## Surface 2: Active Session Shell

### Target shape

The active session becomes a `conversation-first work surface` with a full hierarchy reset.

The center conversation remains dominant, but the entire shell becomes easier to see, navigate, and operate.

### Layout rules

#### Conversation remains primary

The center timeline is the dominant surface.

Messages, tool runs, and state changes should become easier to scan through:

- stronger contrast
- clearer content grouping
- better visual rhythm
- more obvious separation between major event types

#### Header should orient, not dominate

The session header should provide enough structure to ground the user, but it should not overpower the work surface.

It should help with:

- project/session identity
- quick state awareness
- access to high-value controls

It should not become a bulky banner that steals attention from the conversation.

#### Side surfaces must feel intentional

Review, context, files, and goal-related surfaces should feel like deliberately grouped tools rather than plain tabs floating in sparse space.

#### Resize affordances must be obvious

The user has explicitly called out inability to resize and difficulty seeing window boundaries. Resize handles must be visually obvious and consistently interactive across:

- left sidebar
- session right panel
- file tree / nested surfaces where applicable

#### Session-level controls must be more visible

Critical actions should not depend on hidden states, weak contrast, or tiny buttons.

### Responsive behavior

- Wide: conversation center + right dock
- Medium: same shape, with tighter secondary rows
- Narrow: stack support surfaces intelligently while preserving center-surface importance

## Surface 3: Right Sidebar / Goal Surface

### Target shape

The right sidebar becomes a `Dual-Band Dock`.

This is the main control surface for goal-driven work.

### Layout

#### Band 1: active status band

The top block contains:

- goal title
- run status
- progress bar
- percent or equivalent completion signal
- key run stats

This block should be stronger and more structured than the current flat presentation.

#### Budget row under the progress bar

Directly below the green progress bar, always visible:

- Turns: current / max
- Time: elapsed / max

Both budgets must be editable inline via small stepper controls:

- `-` decrease
- `+` increase

Both budgets are hard stop conditions.

If either limit is reached, the run stops.

### Budget behavior

- turns cap and time cap are both visible at all times
- both are adjustable without opening a modal
- editing should be fast and local to the dock
- if a goal has no budget field yet in state, the UI should fall back to product defaults

#### Band 2: command strip

A dedicated command strip under the status band with clearly boxed controls, including:

- Pause / Resume
- Steer
- Stop
- New Goal

Optional future actions can join this strip if they remain high-value and frequent.

The strip should be visually stronger than the current button treatment:

- better outlines
- clearer grouping
- stronger hover/focus states
- more obvious clickability

#### Utility zone

Under the command strip sits a denser utility zone.

At normal desktop widths it uses two columns.

##### Left column

- steps / subgoals
- steering/context
- constraints

##### Right column

- live activity while running
- turn-by-turn or event-by-event updates

#### History rail

At the bottom of the dock:

- compact history pills
- success/failure/stopped coloring
- lightweight metadata such as turns/time

Clicking a history pill opens a nested detail drawer so the user can inspect older runs without disturbing the live goal card.

### Responsive behavior

The approved behavior is `mixed`:

- Wide: status band, command strip, two utility columns, history below
- Medium: same structure, but activity rows and history pills tighten
- Narrow: utility zone stacks vertically while status band and command strip remain intact

## History and Activity Model

The approved model combines all desired information instead of hiding major sections behind tabs.

### Running state

- active goal remains fixed
- live activity is visible
- steps/context are visible
- history remains available as pills below

### Historical inspection

- clicking a history pill opens details in a nested drawer
- live goal card remains untouched
- old runs can expose stats, outcomes, and reusable information

### Future-friendly hooks

The history details view can later support:

- reuse goal
- generate template
- copy settings or constraints from prior run

## Verify Command Visibility

The user did not want a persistent “verify command” row unless it exists.

UI rule:

- show verify command only when one exists for the current goal
- if absent, omit the row entirely

Definition:

- a verify command is the command used to check goal completion, such as `npm test`, `bun test`, or another project-specific verification command

## Visual Language

### Approved direction

`Blend`: mostly `steel-and-signal`, with selective `operator-console` accents.

### Steel-and-signal base

- charcoal or muted dark structural panels
- sharper borders
- restrained use of saturated color
- status colors used meaningfully: green, amber, red

### Operator-console accents

Use stronger accents where action and state need to pop most:

- command strip
- status pills
- history pills
- active step highlights
- attention and alert areas

### Practical visual changes

- stronger outlines on cards, pills, and controls
- more obvious container boundaries
- denser but readable spacing
- better legibility and contrast
- less washed-out/plain presentation

## Operational Priorities Before Polish

The user explicitly prioritized function before beauty.

The implementation order must first validate and fix:

1. front page styling and shell integrity
2. new session entrypoints
3. sidebar and dock operability
4. resize affordances and actual resizing behavior
5. exposed controls and obvious button affordance

Only after those work should the redesign move deeper into visual polish.

## Constraints

- keep the product recognizably OpenCode
- do not create a disconnected visual fork
- do not hide critical controls behind low-contrast minimalism
- do not replace live-goal visibility with history views
- do not make the dock dependent on fragile hidden states

## Success Criteria

The redesign succeeds if:

- the home page feels like a usable mission-control overview
- new session and other primary actions are obvious and operational
- the active session is easier to scan than the current shell
- the right dock feels like a real control surface instead of a sparse side card
- turns/time budgets are visible under the progress bar, editable inline, and enforced as stop conditions
- history is visible but does not disrupt the live run
- resizing is clearly available and works reliably
- the result still feels like OpenCode, just much sharper

## Out of Scope for This Spec

- full product rebrand
- replacing OpenCode’s underlying navigation model
- redesigning every non-session screen in the application
- speculative features unrelated to operator usability

## Recommended Next Step

Write the implementation plan in phases:

1. operational repair and guardrails
2. home page mission-control upgrade
3. active session hierarchy reset
4. right dock dual-band redesign
5. polish, accessibility, and responsive tightening
