# Mindgrab UI direction: evidence and interaction framework

_Prepared for Victoria · 30 October 2026_

## Decision

Build a structured mind-map editor that keeps writing fast, preserves the user’s place, and makes changes predictable. Provide an optional synchronized outline and a reversible way to focus on one branch. Arrange new material automatically, with an explicit way to adjust placement. Keep relationships and reused knowledge available without drawing the entire knowledge graph at once.

The design promise is: Get ideas down quickly. Change their structure safely. Come back without getting lost.

There is enough converging evidence to commit to this first prototype direction. There is not enough evidence to claim that its exact layout, gestures, or visual style are validated. Those require task-based testing. Nor does this research establish willingness to pay or a unique market position.

Yesterday’s research proposed synchronized branches across maps as Mindgrab’s focused product hypothesis. This report adds the UI foundation that hypothesis needs. Shared knowledge must not make ordinary map editing harder to understand.

## Research scope and evidence rules

The new research examined 250 review entries returned by five US App Store feeds: Xmind, MindNode, SimpleMind, SimpleMind Pro, and MindMeister. These are four product families, not five independent competitors. The feeds contain different date ranges: roughly June 2024–August 2026 for Xmind; February 2025–October 2026 for MindNode; January 2025–July 2026 for MindMeister; and older material as well as 2026 reviews for the two SimpleMind listings. Fifty returned entries per listing is a retrieval boundary, not a representative sample.

I also searched public GitHub issues and the Obsidian forum, read selected reports in full, checked issue dates and states for the principal GitHub examples, and read Miro community threads, a NodeLand customer question, and official MindNode, SimpleMind, and Miro documentation. The source ledger below retains individual review IDs because review-feed URLs change as new reviews arrive.

General web-search retrieval failed in this session. Direct public pages, review feeds, forum search, and GitHub search supplied the evidence instead. This limits discovery breadth. Coggle, MindManager, and TheBrain are not adequately sampled for UI complaints here; this is not a category-wide ranking. No applications were tested hands-on and no users were interviewed.

Evidence was interpreted using these rules:

• A report of confusion is evidence that someone struggled; it is not proof the capability is absent.
• An open issue is not proof that every current version reproduces the problem. A closed issue is historical evidence unless its resolution is inspected.
• Several reports from one author or one thread do not count as independent audiences. In particular, two Freeplane navigation/detail reports below share an author.
• Short, vague complaints were not used to prescribe detailed interactions. Commercial complaints were retained only where they reveal UI consequences such as hidden capabilities or interruptions.
• Positive reviews were inspected too. Some describe the same products as quick, clean, and intuitive. They help identify strengths to preserve and prevent a complaint-only interpretation.
• Vendor documentation establishes documented behavior, not usability quality. Proposed Mindgrab behavior is labeled as a design decision rather than a discovered fact.

The practical stopping rule was to obtain repeated task-level friction across products, inspect contrary evidence, check major current-capability claims, and convert the results into testable decisions. Further review mining would be less informative now than observing users perform these tasks.

## The strongest findings

### 1. People need both help arranging material and control over the result

Obsidian Canvas users describe spending excessive time tidying material. A May 2026 reply repeats the need for fast keyboard creation and automatic placement. [F1]

MindNode reviewers in 2026 report frustration with restrictive placement and neighboring nodes moving. However, a January 2026 reviewer changed their rating after repositioning improved. Current MindNode documentation explicitly supports manual offsets within automatic layout. The accurate conclusion is a control/discoverability tension, not that MindNode lacks manual positioning. [A2; D1]

Mindgrab decision: automatic placement by default; stable branch order; a visible placement control; preview before a broad rearrangement; one-step undo. Do not silently rebalance an entire map while someone types. Manual adjustment must be an available choice, not a hidden drag-distance threshold that users must discover.

### 2. Orientation is an editing requirement

Markmind users report losing their target during zoom, reopening at an unsuitable scale, and wanting the previous view remembered. A Freeplane report describes navigating until no nodes remain visible. A January 2026 MindNode review also describes unexpected zoom behavior. [G1–G4; A2]

Mindgrab decision: zoom around the pointer for pointer input and around the focused node for keyboard input; keep the active edit visible; provide Fit map and Fit selection; restore the last useful viewport; offer an obvious recovery control when the canvas is empty. Avoid a full-map fit after every edit.

### 3. Search and focus can themselves destroy organization

A Freeplane user explains that visiting search results unfolds branches and leaves them to restore the original folding manually. Another wants to focus a large map without collapsing unrelated branches one at a time. [G5–G6]

Mindgrab decision: search previews and branch focus temporarily change the view. Closing them restores the previous viewport and fold state unless the user deliberately chooses to keep the new view. Navigation history and content undo are separate concepts.

### 4. Structure changes are too often disguised as precise dragging

A MindMeister reviewer reports difficulty hitting the right drop area. Freeplane’s last-sibling drop request describes extra navigation or a second drag to achieve a simple reorder; that issue is now closed. An Xmind reviewer could not discover how to insert earlier structure. Miro’s current help documents a multi-step workaround for inserting between nodes. [A4; G7; A1; D3]

Mindgrab decision: insertion, reordering, reparenting, and visual positioning need distinct feedback. Show the destination and operation before dropping. Offer Insert parent, Move under…, and Move before/after… commands as alternatives to dragging. Preserve child subtrees during a move.

### 5. Keyboard speed is valuable only when editing states are clear

Users request keyboard folding and branch focus in Mind Elixir; those requests are closed. A 2026 non-QWERTY undo issue is also closed. They still provide concrete regression cases. The Obsidian local-graph request asks for predictable parent/child directions and keyboard navigation. [G8–G10; F2]

Mindgrab decision: make selection, text editing, and navigation visually distinguishable. Provide discoverable shortcuts and pointer equivalents. Test alternate keyboard layouts and text composition. Keep an accessible outline with conventional tree navigation rather than forcing every user through spatial gestures.

### 6. Detail and connections need a controlled place

A Freeplane user says notes appearing automatically interrupt concentration. An Obsidian user cannot readily distinguish parents from children in a randomly arranged local graph. A Miro request describes a mismatch between converging relationships and ordinary connector behavior. [G11; F2; F3]

Mindgrab decision: short node titles on the map; notes opened deliberately in a details panel; different visual treatment for hierarchy and related ideas. Show nonhierarchical relationships for the selected context, with a clear count or indicator elsewhere. A connection should not silently become a parent relationship.

### 7. Confidence in the work matters as much as apparent simplicity

Markmind users ask how to undo on mobile. A five-star SimpleMind review still describes accidental map deletion as a serious concern. Other review pools include reports of missing work or broken exports; these are unverified user reports, not reproduced diagnoses. [G12; A3–A5]

Mindgrab decision: visible Undo and Redo, truthful save status, recoverable map deletion, version recovery, and understandable export choices. Recovery must work in addition to looking reassuring.

### 8. A capability can exist and still fail the user

SimpleMind’s documentation describes crosslinks, keyboard shortcuts, images, free and automatic layout, and different editions. Yet reviews include difficulty discovering image insertion, keyboard navigation, and disabled controls. MindNode’s documented flexible layout also coexists with recent frustration about control. [A2–A3; D1–D2]

Mindgrab decision: expose essential actions at the point of use, label the reason a control is disabled, and provide a brief dismissible first-use hint. A command palette supplements visible controls; it does not replace them.

## The UI framework

Use the person’s task as the organizing structure for UI reviews. Every proposal should improve at least one task without materially damaging another.

|Task            |User question                                |Repeated friction                                       |Mindgrab rule                                                                 |Confidence in the problem                          |
|----------------|---------------------------------------------|--------------------------------------------------------|------------------------------------------------------------------------------|---------------------------------------------------|
|Capture         |Can I get this thought down immediately?     |Lag, disrupted typing, unnecessary placement work       |Create and edit in place; place new nodes automatically; keep caret visible   |High qualitative convergence                       |
|Structure       |Can I change how these ideas belong together?|Ambiguous drops, awkward insertion, unwanted movement   |Explicit insertion and move targets; previews; preserved subtrees; undo       |High qualitative convergence                       |
|Navigate        |Can I reach something and return?            |Lost zoom target, reset viewport, search unfolding      |Pointer/focus anchored zoom; saved view; reversible search and focus          |High qualitative convergence                       |
|Read            |Can I understand this part at a useful scale?|Spread-out maps, long content, intrusive detail         |Branch focus, adjustable density, concise titles, optional outline and details|Moderate to high; exact density unresolved         |
|Relate and reuse|Can an idea belong in several contexts?      |Connector workarounds, copied content, unclear hierarchy|Separate related links from hierarchy; explicitly identify shared content     |Moderate; reuse evidence narrower                  |
|Recover         |Can I safely explore or correct a mistake?   |Missing undo, accidental deletion, unclear saving       |Undo, recovery, local durability, truthful status, scoped removal             |High consequence; frequency unknown                |
|Transfer        |Can I keep using my work elsewhere?          |Export failure, lost structure, storage changes         |Clear export scope and fidelity; readable output plus full backup             |Moderate to high; format priorities need user files|

“High” here means sufficient qualitative convergence to prioritize a prototype requirement. It is not a population estimate, an effect size, or proof of switching demand.

The proposed organizing principle is predictability before decoration. The user should be able to answer three questions before acting: what is selected, what will change, and how to get back.

## Decisions on competing needs

|Tension                               |Default                                                |Escape hatch                                           |What would change the decision                                       |
|--------------------------------------|-------------------------------------------------------|-------------------------------------------------------|---------------------------------------------------------------------|
|Automatic layout vs personal placement|Arrange new material and preserve order                |Explicit manual branch placement, with Reset placement |Users need arbitrary free positioning for their primary task         |
|Spacious maps vs information density  |Readable compact spacing and bounded title width       |Density preference and branch focus                    |Compact mode is slower to read or causes frequent wrapping failures  |
|Connected knowledge vs visual overload|A readable hierarchy per map                           |Selected-node relationships and other locations        |Users repeatedly need simultaneous graph comparison                  |
|Canvas vs linear editing              |Map as primary workspace                               |Outline beside it or as the whole workspace            |Outline becomes the dominant working view for the target audience    |
|Few controls vs discoverability       |Small persistent toolbar and labeled contextual actions|Details panel and searchable commands                  |Novices still cannot find basic operations without help              |
|Fast deletion vs safety               |Reversible removal from the current map                |Explicit broader deletion with affected locations shown|No reason to weaken recovery; refine its interaction instead         |
|Mouse vs trackpad habits              |Clearly explained navigation preset                    |A persistent, discoverable input preference            |Testing identifies a better default for the actual platform          |
|AI help vs distraction                |Human editing is always the primary path               |Optional command on a selected branch                  |User trials establish a specific recurring AI task worth prioritizing|

The evidence does not justify declaring one layout or input convention universally correct. It justifies making the important choices predictable and recoverable.

## First editor layout

This is a proposed design specification, not an observed or tested screen.

|Area               |Contents and purpose                                                              |Visibility                                        |
|-------------------|----------------------------------------------------------------------------------|--------------------------------------------------|
|Top bar            |Map name, save state, Undo/Redo, search, Map/Outline/Split view, share/export menu|Persistent and compact                            |
|Left panel         |Map library or synchronized outline; explicit selector between them               |Collapsible; outline can occupy the full workspace|
|Center             |Map canvas, selected branch, short labels and fold controls                       |Primary workspace                                 |
|Context actions    |Add child/sibling, edit details, move, relate/reuse                               |On selection; keyboard and touch equivalents      |
|Right panel        |Note, links, shared locations, local annotation; style as a secondary section     |Opened deliberately                               |
|Navigation controls|Zoom, Fit map, Fit selection, current focus breadcrumb/back                       |Compact, persistently findable                    |

Start with the canvas and essential actions. Do not require three open sidebars. Split view must be optional and remember its width; narrow screens use a single view. Search can temporarily replace the left panel, then restore it.

The default visual direction should use readable text, restrained branch colors, clear selected/focused states, and moderate spacing. Relationship meaning must not depend on color alone. Decorative stickers, elaborate themes, and motion should not compete with content. These are design judgments supported by the need for clarity, not proof that users prefer a particular aesthetic.

Do not put every advanced action into an always-visible row on every node. Show fold state persistently where needed; show editing actions for selection and keyboard focus, not solely on hover.

## Interaction contract

### Capture and editing

• A new map immediately exposes an editable first idea. A short hint teaches child, sibling, and undo actions; it is dismissible.
• In the map’s selection mode, Enter adds a sibling and starts editing; Add child is available by toolbar, command, and a documented shortcut. Tab can be offered for child creation in an explicit map-editing mode, but must not prevent leaving the widget. The outline retains an accessible keyboard navigation mode.
• Text editing preserves normal caret movement and platform text shortcuts. Escape leaves text editing without deleting the current text. A second Escape can clear selection or exit a temporary view, with a consistent priority order.
• Composition/IME input cannot accidentally create a node when Enter commits a character. Undo must behave correctly with non-US keyboard layouts.
• Paste offers a predictable distinction between text inside one node and an indented outline becoming a branch. Preview ambiguous multi-line structure instead of silently creating a large map.
• Keep the caret and edited node in view. Resize the current node and adjust the affected neighborhood without repeatedly fitting or recentering the entire map.

### Moving and arranging

• Above/below insertion targets indicate sibling placement; an inside target indicates a new parent. Display a preview label such as “Move under Payments.”
• Moving a branch moves its descendants. Mixed multi-selection must show which roots are being moved; selected descendants of an already-selected ancestor are not moved twice.
• Repositioning on the canvas is different from changing parent. Provide explicit commands for both and teach their difference at first use.
• Manual branch placement is an explicit per-map view choice. Automatic layout should reserve room around it; collisions must be visible before commit. If a conflict cannot be resolved, offer Reset placement rather than silently overriding the user’s placement.
• Balance or Tidy affects only the requested scope, offers a preview, and is one undoable operation. It must not run as an invisible side effect of renaming.
• Keep a small initial layout set: a one-direction tree as the prototype default and a two-sided alternative. The default is a hypothesis to compare with users’ existing maps, not a research-proven preference.

### Navigating and searching

• Distinguish Fit map, Fit selection, and incremental zoom. They do different jobs.
• Pointer zoom preserves the point under the pointer; keyboard zoom preserves the focused node. Changing zoom does not change selection.
• Save viewport, selection, and folding per map view. A new map uses an understandable initial scale. A reopened map uses the saved view, adjusted only enough to accommodate a changed window.
• Branch focus retains a breadcrumb and an obvious Back action. Do not replace the actual map root or mutate content.
• Search includes folded content and labels its scope: This map or All maps. Results show the matching node and its map/path, not just a list of files to search again.
• Previewing a result reveals its context temporarily. Dismissing search restores the previous view; choosing Keep view makes the navigation permanent. Content edits made during search are never discarded when the view restores.
• Following a crosslink provides a return path. If a target is removed or inaccessible, explain that state rather than presenting a blank canvas.

### Reading and detail

• A folded branch shows that content exists, with a count when useful. Fold controls must have keyboard focus and touch-sized hit areas independent of tiny visual icons.
• Keep notes behind an indicator until opened. Opening a note does not cover the node being edited or move the whole map.
• The outline and map share content identity, selection, and structural order. View-specific formatting need not be identical; relationships and shared-state indicators remain discoverable in both.
• For the outline, follow a conventional tree accessibility pattern: visible keyboard focus, separate selection, announced expanded state, and a reliable way to leave the widget. The W3C tree-view guidance is the implementation reference. [D4]
• Support reduced motion and adequate contrast as baseline quality. This study did not establish the prevalence of specific accessibility needs.

### Relationships and shared branches

Keep three actions distinct in language and behavior:

|Action               |Meaning                                                      |Editing consequence                                                    |
|---------------------|-------------------------------------------------------------|-----------------------------------------------------------------------|
|Link to an idea      |Navigate to another idea without reproducing its content here|Editing the source does not turn this into a second editable occurrence|
|Reuse shared branch  |Display the same maintained branch in another map            |Shared content changes affect its other locations                      |
|Make independent copy|Create a new branch from the current content                 |Later edits are independent                                            |

For the first reuse experiment, define the scope conservatively: shared titles, notes, and internal branch membership; per-map placement, folding, and local annotations. Internal hierarchy changes to a shared branch affect its shared occurrences. Where an operation would cross the shared-branch boundary, require an explicit scoped action or an independent copy. Do not quietly infer a global reparent from an ordinary drag.

This is a proposed contract to test, not a final data model. Local reordering within a shared branch is unresolved: it could be view-specific, but adds complexity. Prototype shared ordering first, explain it honestly, and test whether users require per-view ordering before implementation expands.

Show a modest shared indicator and the number of locations. Opening details lists those locations. While editing shared material, show a persistent scope cue such as “Shared in 3 maps”; routine typing should not require a confirmation dialog for every keystroke.

Remove from this map is the default removal action. Delete shared content everywhere is a separate, recoverable action that lists the affected locations. Making an independent copy must be discoverable. Cycles must not trigger infinite expansion: show an existing-occurrence link at a repeated ancestor.

The NodeLand request and Obsidian example support the desire for reuse. They do not validate this exact scope model. [F2; F4]

### Saving, recovery, and portability

• Distinguish locally saved, syncing, synced, and failed states if these states exist. Never label queued work as remotely synced. If there is no remote sync, do not imply one.
• Persist accepted edits durably; expose recovery after interrupted work. Reload and process-interruption tests are required before real users rely on the prototype.
• Make Undo/Redo reachable without a physical keyboard. Use meaningful operation labels where possible.
• Deleted maps go to recoverable trash. Removing a node should be undoable; deleting shared content should also have a recovery path beyond a short-lived toast.
• Export distinguishes the whole map from the focused branch and the visible projection from all content. Never silently omit folded material because it is offscreen.
• Offer readable Markdown/outline output and a full-fidelity backup. Label projection losses for shared content, links, and layout. Package or embed referenced assets so a moved backup does not break image paths; a Freeplane report gives a concrete example of that failure. [G13]
• If a capability requires payment, explain that before someone invests effort expecting it to be available. Do not use repeated upgrade overlays in the middle of editing.

## Priorities for the first prototype

|Priority              |Include                                                                                                   |Reason                                                      |
|----------------------|----------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
|P0: dependable editing|Fast creation, clear edit/selection states, insert parent, reorder/reparent, labeled destinations, undo   |Ordinary mapping must feel trustworthy before advanced reuse|
|P0: orientation       |Stable zoom, saved view, Fit controls, folding, reversible branch focus and search                        |Growing maps must remain workable                           |
|P0: content safety    |Durable saving, truthful state, trash/recovery, backup and readable export                                |Trust failures outweigh cosmetic polish                     |
|P1: two working views |Editable outline, optional side-by-side, selection synchronization, notes panel                           |Supports restructuring and detailed material                |
|P1: controlled layout |Compact default, a second orientation, manual branch placement, scoped tidy/reset                         |Resolves the automation/control tension                     |
|P1: product experiment|Reuse one branch across two or three maps, scope cue, locations, remove/copy distinction                  |Tests yesterday’s product hypothesis                        |
|Later                 |Broad formatting, presentation tools, task systems, many importers, real-time collaboration, AI generation|Not required to test the current direction                  |

These are dependency priorities, not a demand to build a full editor before learning. Start with a small real editor supporting a narrow slice of P0 and the reuse demonstration. Label incomplete capabilities and keep valuable user data out until durability works.

AI sentiment is mixed: some reviewers request generation and others resent it taking priority over core workflows. This supports optional, task-specific AI later; it does not support a blanket conclusion that mind-map users reject AI. [A1–A2; A4]

## How to evaluate a proposed feature

Use this review card for every meaningful interaction change:

1. Task: what is the user trying to achieve?
2. Evidence: which demonstrated problem supports it? Separate public reports from our hypotheses.
3. Scope: does it change content, structure, the current view, or shared material elsewhere?
4. Prediction: can a person see the outcome before committing?
5. Recovery: can they undo it and return to their previous place?
6. Access: can it be found and used by keyboard, pointer, and the supported touch experience?
7. Measure: which observed behavior would show it helped?

Reject a change from the first prototype when its only justification is feature parity or visual novelty. An exception needs a concrete user task or an implementation dependency.

Keep separate backlogs for functional bugs, interaction problems, and product capability requests. Missing undo is a functional/recovery failure; a tiny drag target is an interaction failure; spreadsheet task rollups are a capability request. Combining all three into “bad UX” leads to an unfocused roadmap.

## Validation tasks and proposed gates

The following are acceptance targets chosen for Mindgrab, not published usability benchmarks. Test with 6–8 people who currently maintain maps, including people who favor automatic layout and people who deliberately position content. Use their actual material where possible. Record prior experience and compare within each person’s current tool; do not compare raw speed across unrelated users.

|Task                                                          |What to observe                                                      |Proposed gate                                                                                   |
|--------------------------------------------------------------|---------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
|Capture a 20-node outline as ideas emerge                     |Pauses caused by controls, lost characters, unintended nodes         |No lost input; no repeated layout repair; essential create actions discovered within the session|
|Insert a parent, move five siblings, undo the move            |Wrong destinations, lost descendants, number of corrective operations|At least 7/8 complete without facilitator intervention; no content loss                         |
|Find a deeply folded node in a 300-node map, edit it, return  |Time to orient, accidental unfolding, correct restoration            |At least 7/8 return to their prior useful view without manual refolding                         |
|Type into a long node near the viewport edge                  |Caret visibility and unexpected motion                               |Caret remains visible; no unsolicited full-map recentering                                      |
|Switch Map → Outline → Split and reorder a branch             |Whether structure, selection, and relationships stay understandable  |No duplicate/lost content; users correctly identify the same branch                             |
|Reuse a branch in three maps, rename it, remove one occurrence|Whether scope is understood before the action                        |All testers predict rename/removal scope correctly before shared editing ships                  |
|Close/reload, reopen, recover a deleted map                   |Content and view continuity; credibility of saved state              |No acknowledged-edit loss; recovery works without external file surgery                         |
|Export a map with folded branches, notes, links and an image  |Missing content, unreadable output, broken assets                    |Declared export fidelity matches actual output; full backup restores it                         |

With six testers, replace the 7/8 gates with a similarly strict provisional target and examine every failure; do not pretend the small sample provides statistical certainty. Shared deletion and data-loss failures block release regardless of the average score.

For performance, benchmark 100, 500, and 1,000-node maps on a named ordinary laptop, recording visible-node count, note/image content, browser, and device. Suggested initial budgets are p95 key-to-visible-feedback below 100 ms and no repeated interaction stalls over 200 ms during capture or navigation. These are engineering targets to validate, not results achieved or competitor comparisons. Test visible-heavy and mostly-folded maps separately.

For qualitative evaluation, count interface repair separately from content work: re-finding a lost node, correcting a mistaken drop, restoring folds, and repairing unwanted layout. A good outcome is less repair and clear preference on actual tasks, not just a cleaner screenshot.

Run a second session on another day. First-use delight is insufficient if reopening and maintaining the map remains painful.

## Confidence and remaining decisions

High confidence: preserve writing flow; keep navigation anchored; make moves explicit; provide recovery; avoid accidental global layout changes. Evidence converges across review pools, forums, and issues.

Moderate confidence: an optional outline, branch focus, deliberate detail disclosure, and adjustable placement form the right combination for the initial audience. These needs are demonstrated, but their exact presentation is untested and competitors already implement substantial parts.

Lower confidence: the initial layout orientation, precise density, the best mouse/trackpad default, shared ordering semantics, the value of a minimap, and payment appeal. Treat these as prototype questions. A minimap is not automatically necessary when search, focus, breadcrumbs, and Fit controls work.

No evidence here selects a particular color palette, node shape, or visual brand. Nor does it validate adding an entire freeform whiteboard. The supported commitment is a predictable, readable editor with controlled access to richer relationships.

## Source ledger

All links below were retrieved directly on 30 October 2026. Review statements are paraphrases of user reports. Neither the user’s diagnosis nor the current reproducibility of a bug was independently verified. A review’s platform and edition must not be generalized to all versions.

### App Store review samples

|ID|Source                                                                                                                                                                         |Selected records retained for traceability                                                                                                                                                                                                                                                                                                                                      |Interpretation                                                                                                                          |
|--|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|
|A1|[Xmind US review feed](https://itunes.apple.com/us/rss/customerreviews/id=1286983622/sortBy=mostRecent/json) · [app listing](https://apps.apple.com/us/app/id1286983622)       |12398141511, 2025-03-08: trouble inserting earlier structure and converging paths. 11576049733, 2024-08-05: input lag and image-export trouble on iPad. 12773141005, 2025-06-14: repeated upgrade interruptions. 14335851216, 2026-07-22: macOS-to-Vision Pro compatibility report. Positive 2025-02-24 review praises learnable controls.                                      |Discovery, performance, interruptions, and platform continuity; not proof missing insertion features or universal lag.                  |
|A2|[MindNode US review feed](https://itunes.apple.com/us/rss/customerreviews/id=6446116532/sortBy=mostRecent/json) · [app listing](https://apps.apple.com/us/app/id6446116532)    |14416209090, 2026-08-11: placement frustration. 13927518454, 2026-04-05: unwanted movement/zoom. 13763280779, 2026-02-18: outline and workflow regressions. 13602634948, 2026-01-06: unexpected zoom. Positive 2026-01-24 review updates its rating after placement improvements. Positive 2026-09-03 review likes AI; 13525793300, 2025-12-17, wants core workflow prioritized.|Mixed experiences and version changes. Check D1 before treating a reported limitation as current.                                       |
|A3|[SimpleMind US review feed](https://itunes.apple.com/us/rss/customerreviews/id=305727658/sortBy=mostRecent/json) · [app listing](https://apps.apple.com/us/app/id305727658)    |11673210657, 2024-08-31: five-star review flags deletion and zoom-dependent controls. 10940086719, 2024-02-14: image insertion discovery. 11590295474, 2024-08-09: disabled controls unclear. 12043979382, 2024-12-09: keyboard navigation request. 11384683101, 2024-06-15: five-star review describes expanding layouts.                                                      |Positive ratings can contain actionable friction. Edition/platform differences matter; D2 documents many capabilities.                  |
|A4|[MindMeister US review feed](https://itunes.apple.com/us/rss/customerreviews/id=381073026/sortBy=mostRecent/json) · [app listing](https://apps.apple.com/us/app/id381073026)   |12483728813, 2025-03-30: difficult dragging, moving text while typing, input lag. 12536686930, 2025-04-12: keyboard conflict after update. 13790993894, 2026-02-26: image-export server error. 13743585190, 2026-02-12: generation request. Positive 2026-07-16 review describes quick adoption and useful collaboration.                                                       |Historical iOS reports coexist with positive recent experience. Do not declare the product currently unusable.                          |
|A5|[SimpleMind Pro US review feed](https://itunes.apple.com/us/rss/customerreviews/id=378174507/sortBy=mostRecent/json) · [app listing](https://apps.apple.com/us/app/id378174507)|7101440475, 2021-03-14: selection lost after near miss; repeated search steps; color friction. 12884215923, 2025-07-12: global/local setting mismatch. 10305376751, 2023-08-27: onboarding confusion. Five-star 2025-11-06 review likes hidden notes but requests easier styling. 6587071913, 2020-10-29: sync/data-loss report.                                                |Older details are historical risk cases, not current capability assertions. No medical conclusion follows from a review mentioning ADHD.|

### Forum and customer discussions

|ID|Source and date                                                                                                                                                                   |Observed need and qualification                                                                                                                                                        |
|--|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|F1|[Obsidian: automated Canvas layout](https://forum.obsidian.md/t/more-automated-layout-options-for-canvas/49270), started 2022-12-09; substantive replies 2023-04-26 and 2026-05-25|Less manual tidying, faster creation, persistent layout. Canvas is an adjacent freeform tool, not a dedicated mind mapper; author assertions about its update history were not adopted.|
|F2|[Obsidian: local graph with keyboard navigation](https://forum.obsidian.md/t/local-graph-as-mind-map-with-keyboard-navigation-like-through-file-structure/49193), 2022-12-08      |Predictable hierarchy, keyboard flow, and the same nginx note in multiple contexts. Historical workflow request, not proof no present plugin solves it.                                |
|F3|[Miro: multiple parents to one child](https://community.miro.com/ideas/connect-multiple-parent-nodes-to-a-single-child-node-16203), 2024-04-17 and 2024-07-10                     |Converging ideas without connector/layout workarounds; one participant reports abandonment. Small thread; multiple parents and synchronized cross-map reuse are distinct.              |
|F4|[NodeLand: same node across maps](https://appsumo.com/products/nodeland/questions/same-node-in-multiple-maps-1287208/), question 2025-01-18; founder reply 2025-01-23             |Direct reuse request and a historical limitation. Current NodeLand cross-map behavior not established.                                                                                 |
|F5|[Miro: large-map lag](https://community.miro.com/ask-the-community-45/miro-mindmap-is-slow-freezy-and-lagging-13452), 2023-05-08 and 2023-05-25                                   |Initial report around 1,000 nodes and another around 200. Later replies include obvious repetition/spam; they were excluded from corroboration. Not a current benchmark.               |
|F6|[Miro: restoring wheel zoom](https://community.miro.com/ask-the-community-45/how-do-i-reinstate-zooming-using-my-mouse-wheel-6545), 2021-11-24; follow-ups through 2025-10-01     |Input mode already configurable; discovery and unexpected mode changes are the lesson. This is a general board-navigation thread.                                                      |

### GitHub reports with checked dates and states

Issue state is the state returned at retrieval; closed does not by itself mean a fix was verified.

|ID |Source                                                                      |Opened; retrieved state      |Useful evidence                                                                                               |
|---|----------------------------------------------------------------------------|-----------------------------|--------------------------------------------------------------------------------------------------------------|
|G1 |[Markmind #443](https://github.com/MarkMindCkm/obsidian-markmind/issues/443)|2022-09-27; open             |Zoom loses the intended point and forces recentering.                                                         |
|G2 |[Markmind #388](https://github.com/MarkMindCkm/obsidian-markmind/issues/388)|2022-07-13; open             |View scale resets on reopening.                                                                               |
|G3 |[Markmind #915](https://github.com/MarkMindCkm/obsidian-markmind/issues/915)|2024-11-05; open             |Fit-to-window and remembered position requested.                                                              |
|G4 |[Freeplane #2220](https://github.com/freeplane/freeplane/issues/2220)       |2025-01-15; open             |Navigation can leave no nodes visible.                                                                        |
|G5 |[Freeplane #2719](https://github.com/freeplane/freeplane/issues/2719)       |2025-10-23; open             |Search leaves folded-state cleanup work.                                                                      |
|G6 |[Freeplane #2743](https://github.com/freeplane/freeplane/issues/2743)       |2025-11-16; open             |Wants to fold unrelated material in one action.                                                               |
|G7 |[Freeplane #2213](https://github.com/freeplane/freeplane/issues/2213)       |2025-01-12; closed 2025-05-23|Last-sibling placement required extra navigation/reordering. Historical interaction case.                     |
|G8 |[Mind Elixir #315](https://github.com/SSShooter/mind-elixir-core/issues/315)|2025-05-08; closed 2025-05-28|Keyboard folding request.                                                                                     |
|G9 |[Mind Elixir #309](https://github.com/SSShooter/mind-elixir-core/issues/309)|2025-04-21; closed 2025-05-28|Keyboard focus-mode request.                                                                                  |
|G10|[Mind Elixir #380](https://github.com/SSShooter/mind-elixir-core/issues/380)|2026-08-04; closed 2026-08-05|Undo/redo with non-QWERTY layouts. Regression test case.                                                      |
|G11|[Freeplane #1794](https://github.com/freeplane/freeplane/issues/1794)       |2024-04-21; open             |Automatic note display distracts. Same author as G4.                                                          |
|G12|[Markmind #407](https://github.com/MarkMindCkm/obsidian-markmind/issues/407)|2022-08-01; open             |Mobile undo discoverability; author found desktop shortcut.                                                   |
|G13|[Freeplane #2397](https://github.com/freeplane/freeplane/issues/2397)       |2025-04-19; open             |Images reused across maps break after directory moves.                                                        |
|G14|[simple-mind-map #385](https://github.com/wanglin2/mind-map/issues/385)     |2023-11-02; closed 2024-07-31|Chinese-language report of lag adding children beyond 100 nodes. Historical performance case, not a benchmark.|
|G15|[Markmind #651](https://github.com/MarkMindCkm/obsidian-markmind/issues/651)|2023-03-25; open             |Pinch zoom and touch node-movement complaints. Historical multi-input risk.                                   |

### Current documentation and implementation reference

|ID|Source                                                                                                                                                                                                         |What it establishes                                                                                                                                                                                  |
|--|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|D1|[MindNode layout guide](https://www.mindnode.com/support/guides/mind-map-and-canvas-styling); [outline guide](https://www.mindnode.com/support/guides/outlining); [features](https://www.mindnode.com/features)|Documented manual offsets, automatic layout, spacing, synchronized outline, notes and connections. Does not prove side-by-side availability or superiority.                                          |
|D2|[SimpleMind FAQ](https://simplemind.eu/faq/)                                                                                                                                                                   |Free/automatic layouts, branch layouts, crosslinks, notes, images, selection and keyboard support; edition differences. Contradicts broad claims that the product categorically lacks those features.|
|D3|[Miro mind-map guide](https://help.miro.com/hc/en-us/articles/360017730753-Mind-map)                                                                                                                           |Current creation shortcuts, auto layout, folding counts, connection workaround, insertion workaround and export workflow.                                                                            |
|D4|[W3C tree-view pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)                                                                                                                                    |Reference for accessible outline semantics, expanded state, focus/selection distinction and keyboard navigation. A design baseline, not evidence of commercial demand.                               |

## Relationship to earlier research

The 29 October report, Mindgrab-opportunity-research.md, was read in full. Its synchronized-branch hypothesis remains a product experiment. The source checks in this report broaden the UI foundation; they do not upgrade the earlier report’s payment or differentiation confidence. Before positioning Mindgrab against TheBrain, Heptabase, Freeplane, or MindManager, compare the actual reuse task hands-on.
