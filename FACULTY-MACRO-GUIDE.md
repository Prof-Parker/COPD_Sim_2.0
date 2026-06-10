# Faculty Guide: Custom Activity Macros

This guide explains how to author **activity stations** in the COPD Simulation using three custom SugarCube macros. These macros render controls in the **fixed footer** at the bottom of the screen (the same area as the Observer’s General Observations buttons).

All shared stats (Energy, Points, `hasInhaler`, etc.) sync through **Playroom** via `SimApp.setVal` / `SimApp.getVal`. Patient choices that change inventory or flags should use the optional **state set** field (field 7) so both devices stay in sync.

---

## Quick navigation

Click a link to jump to that section, then click the section header to expand or collapse it.

<ul>
<li><a href="#before-you-begin">Before You Begin</a> — setup & workflow</li>
<li><a href="#patient-choices">patient-choices</a> — patient choice buttons</li>
<li><a href="#dynamic-eval">dynamic-eval</a> — observer assessment buttons</li>
<li><a href="#patient-next">patient-next</a> — patient Continue / Next</li>
<li><a href="#multiplayer-navigation">Multiplayer navigation</a> — host routing & sync</li>
<li><a href="#full-activity-templates">Full activity templates</a> — copy-paste passage skeletons</li>
<li><a href="#quick-reference">Quick reference</a> — at-a-glance tables</li>
<li><a href="#tips-troubleshooting">Tips & troubleshooting</a> — common pitfalls</li>
</ul>

**Tip:** Use **Markdown: Open Preview** (`Ctrl+Shift+V`) and click links normally (not Ctrl+click) to scroll within this page.

---

<span id="before-you-begin"></span>
<details open>
<summary><strong>Before You Begin</strong> — tags, role split, activity flow</summary>

### Required passage tags

| Tag | When to use |
|-----|-------------|
| `simulation` | Any passage that shows the HUD and footer during gameplay |
| `activity` | Activity stations that use `<<patient-choices>>` and/or `<<dynamic-eval>>` |
| `briefing` | Tutorial or practice passages where game-over should **not** trigger (optional) |

**Example tag line in Twine:**

```
:: Showering [simulation activity]
```

### Split content by role

Each activity passage should use a role check so Patient and Observer see different text and macros:

```
<<if $myRole == "patient">>
    ... patient instructions ...
    <<patient-choices ...>>
    <<patient-next ...>>
<<else>>
    ... observer instructions ...
    <<dynamic-eval ...>>   /* omit when no observer eval at this station */
<</if>>
```

### How an activity station flows

**Standard station (with Observer eval):**

1. **Patient** reads instructions in the main passage text.
2. **Patient** taps a choice button in the footer (`<<patient-choices>>`), if the activity has choices.
3. **Observer** taps one assessment button in the footer (`<<dynamic-eval>>`).
4. **Patient** sees a **Continue** / **Next** button in the footer (`<<patient-next>>`) and moves the team to the next passage.

The Patient cannot advance until the Observer has evaluated (`evalComplete` must be true).

**Choice-only station (no Observer eval at this passage):**

1. **Patient** taps a choice (`<<patient-choices>>` with `"no-eval"`).
2. **Continue** unlocks immediately after the choice — no Observer button on this passage.
3. **Observer** watches in the passage text only; evaluate on a **later** passage (e.g. movement after the decision).

**Next-only station (no choices, no eval):**

1. **Patient** taps `<<patient-next>>` immediately (e.g. tutorial hub, simple transitions like `Item_Pickup`).
2. Use `[simulation activity]` + `<<patient-next>>` alone when there is **no** `<<dynamic-eval>>` on the Observer side for that passage. The footer unlocks immediately — it does not wait for an Observer eval that never comes.

**Next-only station (Patient next, Observer eval on same passage):**

1. **Patient** sees `<<patient-next>>` but cannot tap it until the **Observer** completes `<<dynamic-eval>>` (e.g. `Good_Morning_Mr._Holland`, hallway movement passages).

**Important:** During multiplayer, use these macros and `SimApp.nextPassage` / `SimApp.goToSharedPassage` — do **not** use `<<goto>>` for shared navigation.

</details>

<span id="patient-choices"></span>
<details>
<summary><strong><code>&lt;&lt;patient-choices&gt;&gt;</code></strong> — Patient · footer choice buttons · requires <code>[simulation activity]</code></summary>

**Who sees it:** Patient only  
**Where it appears:** Footer — “Your choice” section above the Next button  
**Requires:** Passage tagged `[simulation activity]`

### Purpose

Presents one or more choice buttons (e.g., water temperature, forgot inhaler decision). When the Patient taps a button:

- Energy is adjusted (hidden from the Patient UI)
- Optional **Playroom state** is updated (e.g. `hasInhaler=true`) via `setVal`
- Optional **next passage** override for branching paths
- A consequence message appears in the footer (green, red, yellow, or white text)
- The Patient waits for the Observer to evaluate **unless** `"no-eval"` is used

### Syntax

```
<<patient-choices "Section title"
  "Button label | energy | buttonColor | messageColor | Consequence message shown after click"
  "Another label | -2 | cold | red | You gasp from the cold water!"
>>
```

With **no Observer eval** on this passage:

```
<<patient-choices "What do you want to do?" "no-eval"
  "Option A | 0 | green | green | You chose A."
  "Option B | 0 | green | red | You chose B."
>>
```

With **branching** (different next passage + synced state per choice):

```
<<patient-choices "What do you want to do?" "no-eval"
  "Turn around and go back inside | 0 | green | green | Walk back upstairs to get your inhaler. | Hallway_In_Repeat | hasInhaler=true"
  "Keep going without it | 0 | green | red | You hope you won't regret leaving it behind. | Whistle_Stop_Out | hasInhaler=false"
>>
```

The second argument `"no-eval"` is optional. When present, it must come **immediately after** the section title and **before** the choice strings.

### Fields (pipe-separated, one row per button)

| # | Field | Description |
|---|--------|-------------|
| 1 | **Button label** | Text on the button (required) |
| 2 | **Energy change** | Number added to energy (e.g. `-4`, `-1`, `0`). Not shown to the Patient. |
| 3 | **Button color** | CSS theme for the button. Built-in themes: `green`, `red`, `blue`, `hot`, `warm`, `cold`. |
| 4 | **Message color** | `green`, `red`, `yellow`, or `white` — color of the consequence text after the Patient clicks. |
| 5 | **Message** | Consequence text shown in the footer after the Patient clicks. |
| 6 | **Next passage** *(optional)* | Exact passage name. Overrides the target in `<<patient-next>>` when **this** choice is picked. Use for branching story paths. |
| 7+ | **State set** *(optional)* | Playroom sync via `setVal`: `key=value` (assign), `key+=n` (add), or `key-=n` (subtract). Examples: `hasInhaler=true`, `Points+=1`, `errandsRun+=1`. Field 6 may be left blank (`| | Points+=1`). |

**Shorthand (4 fields):** If you only provide 4 pipe-separated values, field 4 is treated as the **message** and the message color is auto-set from the energy sign (positive → green, negative → red).

```
"Warm Water | -1 | warm | The warm water is soothing."
```

**Fields 6–7 require fields 1–5:** When using a next passage or state set, always include all five core fields (use `0` energy and `green`/`red` colors as needed). Field 6 is the passage name (leave blank to keep the `<<patient-next>>` target). Field 7+ uses `=`, `+=`, or `-=`.

```
"Good choice | 0 | green | green | Well done! | | Points+=1"
```

**Empty message:** Leave field 5 blank to show “Waiting for your Observer to evaluate…” instead of a consequence line. Useful when the Observer’s eval supplies the Patient feedback (see `<<dynamic-eval>>` field 6).

### Example — Showering (3 choices, standard eval)

```
<<patient-choices "Water temperature"
  "Hot Water | -4 | hot | red | All the steam from the hot water makes it hard to breathe!"
  "Warm Water | -1 | warm | green | The warm water is soothing and doesn't stress your lungs."
  "Cold Water | -2 | cold | red | The sudden shock of the cold water makes you gasp for air!"
>>
```

### Example — Forgotten inhaler wildcard (`Wildcard1`)

Patient decision only; Observer evaluates **movement** on the next passage (`Hallway_In_Repeat` or `Whistle_Stop_Out`):

```
<<patient-choices "What do you want to do?" "no-eval"
  "Turn around and go back inside to get it | 0 | green | green | Walk back upstairs to your apartment to get your inhaler. | Hallway_In_Repeat | hasInhaler=true"
  "Keep going to your errands without it | 0 | green | red | You hope that you don't regret your decision to leave your inhaler behind. Start walking to Whistle Stop Park. | Whistle_Stop_Out | hasInhaler=false"
>>

<<patient-next "Continue" "Whistle_Stop_Out">>
```

`<<patient-next>>` provides a default target; field 6 on each choice overrides it when that choice is selected.

### Layout notes

- Choice buttons use the same **two-column footer grid** as Observer controls.
- If there is an **odd** number of choices, the last button is **centered** in the grid.

</details>

<span id="dynamic-eval"></span>
<details>
<summary><strong><code>&lt;&lt;dynamic-eval&gt;&gt;</code></strong> — Observer · footer assessment buttons · requires <code>[simulation activity]</code></summary>

**Who sees it:** Observer only  
**Where it appears:** Footer — “Activity Specific Observations” section  
**Requires:** Passage tagged `[simulation activity]`

### Purpose

Renders one or more assessment buttons for the current activity. When the Observer taps a button:

- Energy and points are updated
- An optional behavior counter is incremented (for debriefing data)
- `evalComplete` is set so the Patient’s Next button unlocks
- An optional message can be sent to the Patient’s footer (used heavily in the tutorial)

**When to omit:** Some passages only need the Patient to choose (Breakfast, `Wildcard1` decision). Give the Observer read-only instructions in the passage body and use `"no-eval"` on `<<patient-choices>>`. Put `<<dynamic-eval>>` on the **follow-up** passage instead (e.g. walking back for the inhaler).

### Syntax

```
<<dynamic-eval "Activity: Showering"
  "They showered sitting down | 0 | 1 | satAndRested | green"
  "They showered standing up | -2 | 1 | standing | red"
>>
```

With optional Patient feedback (tutorial / special cases):

```
<<dynamic-eval "Practice: Jumping Jacks"
  "They did 5 jumping jacks | -9 | 0 | none | red | What were you thinking?! You have advanced COPD! | red"
>>
```

### Fields (pipe-separated, one row per button)

| # | Field | Description |
|---|--------|-------------|
| 1 | **Button label** | Text on the button (required) |
| 2 | **Energy change** | Number (e.g. `-2`, `4`, `0`) |
| 3 | **Points change** | Points awarded for this assessment |
| 4 | **Behavior variable** | Story variable to increment (e.g. `satAndRested`, `rushed`, `standing`), or `none` |
| 5 | **Button color** | `green`, `red`, or `blue` (optional — defaults from energy sign) |
| 6 | **Patient message** | *(Optional)* Text shown to the Patient in the footer after this eval |
| 7 | **Patient message color** | *(Optional)* `green`, `red`, `yellow`, or `white` for field 6 (defaults from energy sign) |

Energy and points are shown automatically as a subtitle under the button label (e.g. `-2 Energy · 1 Pts`).

### Example — Getting out of bed

```
<<dynamic-eval "Activity: Getting Out of Bed"
  "They sat and rested on the edge before standing | -1 | 1 | satAndRested | green"
  "They got straight out of bed without resting | -2 | 1 | rushed | red"
>>
```

### Example — Observer-only body text (no eval on this passage)

```
<<else>>
@@.holland;Mr. Holland@@ steps outside and pats his pockets — his rescue inhaler is still on the counter inside. Watch what he decides.

//There are no activity specific evaluations for this station — evaluate his movement on the next passage.//
<</if>>
```

### Layout notes

- Buttons use the same **two-column grid** and width as General Observations.
- A **single** eval button (or any odd count) is **centered** in the grid.
- Each Observer can only pick **one** option per activity; the footer then shows “Assessment Recorded.”

</details>

<span id="patient-next"></span>
<details>
<summary><strong><code>&lt;&lt;patient-next&gt;&gt;</code></strong> — Patient · footer Continue / Next button · requires <code>[simulation]</code></summary>

**Who sees it:** Patient only  
**Where it appears:** Footer — below choices / feedback  
**Requires:** Passage tagged `[simulation]` (and `[activity]` when paired with `<<patient-choices>>`)

### Purpose

Shows the Patient a **Next** / **Continue** button that:

- Waits for the Observer’s evaluation when the passage uses choices **without** `"no-eval"`, or when an eval is otherwise required
- Unlocks immediately after a `"no-eval"` choice is picked, or on passages with no choices
- Navigates the **entire team** to the target passage via `SimApp.nextPassage`
- Optionally **resets all game stats and the timer** before starting the real simulation

When a choice includes **field 6 (next passage)**, that choice’s destination replaces the default target from `<<patient-next>>`.

### Syntax

```
<<patient-next "Button label" "Target_Passage_Name">>
```

With simulation reset (used at the end of the tutorial):

```
<<patient-next "Start Simulation<br>Good Morning Mr. Holland" "Good_Morning_Mr._Holland" "reset">>
```

### Arguments

| # | Argument | Description |
|---|----------|-------------|
| 1 | **Button label** | Text on the button. HTML like `<br>` is allowed for line breaks. |
| 2 | **Target passage** | Exact Twine passage name (e.g. `Showering`, `Good_Morning_Mr._Holland`). Default destination unless a choice overrides with field 6. |
| 3 | **`reset`** *(optional)* | If the third argument is the word `reset`, all stats and the simulation timer return to defaults before navigating. Use once when leaving the tutorial. |

### Example — Simple advance after Observer eval

```
<<patient-next "Head to the Bathroom (Shower)" "Showering">>
```

### Example — Tutorial hub (no Observer eval required)

```
<<patient-next "Begin Practice Activity" "Tutorial_Jumping_Jacks">>
```

On passages **without** `<<patient-choices>>`, the Next button appears immediately (no Observer eval needed).

### Example — End of tutorial

```
<<patient-next "Start Simulation<br>Good Morning @@.holland;Mr. Holland@@" "Good_Morning_Mr._Holland" "reset">>
```

</details>

<span id="multiplayer-navigation"></span>
<details>
<summary><strong>Multiplayer navigation</strong> — faculty / routers · <code>SimApp</code> sync patterns</summary>

| Situation | Use |
|-----------|-----|
| Patient taps **Next** after an activity | `<<patient-next>>` → `SimApp.nextPassage` (handled by macro) |
| Host must move **everyone** to the same passage (game over, hub) | `SimApp.goToSharedPassage("Passage_Name")` via `<<run>>` |
| **Auto-router** passages that jump immediately (e.g. `Wildcard_Router`) | `SimApp.deferGoToSharedPassage("Passage_Name")` — **not** `goToSharedPassage` during passage wikify |
| Random or host-only logic (e.g. `Wildcard_Router`) | Host rolls and `setVal`s shared state; both clients defer-navigate — **not** `<<goto>>` |

**Example — synced wildcard router (host rolls, team follows):**

```
<<silently>>
<<if typeof Playroom !== "undefined" and Playroom.isHost()>>
<<set _wildRoll to random(1, 6)>>
<<run SimApp.setVal("wildRoll", _wildRoll, true); SimApp.setVal("wildCarded", true, true)>>
<<else>>
<<run SimApp.syncFromPlayroom()>>
<<set _wildRoll to SimApp.getVal("wildRoll")>>
<</if>>
<</silently>>
<<if _wildRoll is 1>>
<<run SimApp.setVal("yourItem", "your inhaler", true); SimApp.setVal("hisItem", "his inhaler", true); SimApp.deferGoToSharedPassage("Wildcard1")>>
<<else>>
<<run SimApp.deferGoToSharedPassage("Wildcard6")>>
<</if>>
```

`wildRoll` defaults to **1** in StoryInit as a safe fallback before the host rolls.

</details>

<span id="full-activity-templates"></span>
<details>
<summary><strong>Full activity templates</strong> — copy-paste passage skeletons</summary>

### Standard — choices + Observer eval

```
:: My_Activity [simulation activity]
! Activity Title
<hr>

<<if $myRole == "patient">>
Instructions for @@.holland;Mr. Holland@@ go here.

<<patient-choices "Your choice prompt"
  "Option A | -1 | green | green | A good choice."
  "Option B | -3 | red | red | That was hard on your breathing!"
>>

<<patient-next "Continue" "Next_Passage_Name">>

<<else>>
Instructions for the @@.observer;Observer@@ go here.

<<dynamic-eval "Activity: My Activity"
  "Good performance | 0 | 2 | satAndRested | green"
  "Poor performance | -2 | 0 | rushed | red"
>>
<</if>>
```

### Choice-only — no Observer eval on this passage

```
:: My_Decision [simulation activity]
! Decision Point
<hr>

<<if $myRole == "patient">>
What do you want to do?

<<patient-choices "Your decision" "no-eval"
  "Choice A | 0 | green | green | You chose A. | Path_A | someFlag=true"
  "Choice B | 0 | green | red | You chose B. | Path_B | someFlag=false"
>>

<<patient-next "Continue" "Path_B">>

<<else>>
Watch @@.holland;Mr. Holland@@ decide. No activity-specific eval here — assess on the next passage.
<</if>>
```

### Next-only — no choices

Use when the Patient only needs a Continue button and the Observer has **no** activity-specific eval on this passage (e.g. `Item_Pickup`). The Next button unlocks immediately.

```
:: My_Transition [simulation activity]
<h2>Keep Moving</h2>
<hr>

<<if $myRole == "patient">>
Walk to the next location, then tap Continue.

<<patient-next "Continue" "Next_Passage">>

<<else>>
Observe @@.holland;Mr. Holland@@. Use General Observations in the footer if needed.
<</if>>
```

### Next-only — Patient next, Observer eval on same passage

Use when the Patient has no choices but the Observer must evaluate before the team advances (e.g. getting out of bed, walking stairs).

```
:: My_Activity [simulation activity]
<h2>Keep Moving</h2>
<hr>

<<if $myRole == "patient">>
Walk to the next location, then tap Continue when ready.

<<patient-next "Continue" "Next_Passage">>

<<else>>
Observe @@.holland;Mr. Holland@@. Use General Observations in the footer if needed.

<<dynamic-eval "Activity: Walking"
  "Steady pace | -1 | 1 | satAndRested | green"
  "Rushed | -3 | 0 | rushed | red"
>>
<</if>>
```

</details>

<span id="quick-reference"></span>
<details>
<summary><strong>Quick reference</strong> — macro summary tables</summary>

| Macro | Role | Footer section |
|-------|------|----------------|
| `<<patient-choices>>` | Patient | Choice buttons + consequence text |
| `<<patient-choices>>` `"no-eval"` | Patient | Choice unlocks Continue without Observer eval |
| `<<dynamic-eval>>` | Observer | Activity Specific Observations |
| `<<patient-next>>` | Patient | Next / Continue button |

| Patient step | Observer step (standard) | Observer step (no-eval) |
|--------------|----------------------------|-------------------------|
| Tap choice (if any) | Tap eval button | Watch only (passage text) |
| Wait for eval | — | — |
| Tap Next | Follows via sync | Tap Next after choice |

| Choice field 6 | Choice field 7 |
|----------------|----------------|
| Override next passage for that branch | `key=value`, `key+=n`, or `key-=n` synced to Playroom |

</details>

<span id="validation"></span>
<details>
<summary><strong>Validation</strong> — automated passage flow check</summary>

Before publishing, run the static flow validator to catch dead-end passages, broken navigation targets, and eval deadlocks:

```powershell
npm run test:flow
```

Or after a build (validator runs automatically when Node.js is installed):

```powershell
.\build.ps1
```

**Requires:** Node.js 18+ ([nodejs.org](https://nodejs.org/)). If Node is not installed, `build.ps1` still compiles the story but skips validation with a warning.

**What it checks**

- Every `<<patient-next>>`, `<<patient-choices>>`, router, and `SimApp.nextPassage` target points to a real passage
- Patient branches are not dead-ends (no way to leave the station)
- `<<patient-choices>>` without `"no-eval"` are paired with Observer `<<dynamic-eval>>` on the same passage
- All gameplay passages are reachable from lobby, tutorial, main sim, wildcard, and errand entry points

**What it does not check**

- Live Playroom multiplayer sync or tether timing
- Energy / game-over thresholds
- Runtime footer behavior in the browser

**Exit codes:** `0` = passed (warnings may still print); `1` = failed dead-ends, broken targets, or unreachable passages.

</details>

<span id="tips-troubleshooting"></span>
<details>
<summary><strong>Tips & troubleshooting</strong></summary>

- **Passage names are case-sensitive** — `Showering` and `showering` are different. Use underscores for spaces in names (e.g. `Good_Morning_Mr._Holland`).
- **Pipe character `|`** separates fields. If your message text needs a literal pipe, avoid it or rephrase — there is no escape character. When using fields 6–7, keep the message in field 5 only (do not use extra pipes in the message).
- **Energy is capped** at 15 and floored at 0. Reaching 0 energy (or 7 rescue inhaler uses) triggers an **8-second in-passage countdown** before both players are moved to the shared game-over passage. `[briefing]` passages are exempt.
- **One eval per station** — design each `<<dynamic-eval>>` so the Observer picks the single best-matching option.
- **`"no-eval"`** — use when the Patient choice *is* the activity (Breakfast, wildcard decisions). Put movement/technique eval on the **next** passage.
- **Branching** — pair field 6 (next passage) with field 7 (state flags). Both players receive updates through Playroom.
- **Do not use `<<goto>>`** for team navigation during multiplayer — use `<<patient-next>>`, `SimApp.nextPassage`, or `SimApp.goToSharedPassage`.
- **Errands hub (`Errands_Hub`)** — Patient picks errands from a fixed 2×2 passage-body grid (`<<button>>` + `SimApp.nextPassage`). Completed errands stay visible but grey out with a ✓ (set `visitedGrocery`, `visitedPharmacy`, `visitedClinic`, `visitedToyStore` when entering each errand router). Styles live in StoryStylesheet under `.errands-hub`.
- **Test both roles** — open two browsers/devices, connect via Playroom, assign Patient and Observer, and walk through the station.
- **Republish** — after editing the `.twee` file, use Twine **Publish to File → index.html** before pushing to GitHub Pages.

</details>

---

*COPD Simulation 2.0 — Robin Parker, MSN, RN, PCCN*
