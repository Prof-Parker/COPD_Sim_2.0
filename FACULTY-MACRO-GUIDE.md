# Faculty Guide: Custom Activity Macros

This guide explains how to author **activity stations** in the COPD Simulation using three custom SugarCube macros. These macros render controls in the **fixed footer** at the bottom of the screen (the same area as the Observer’s General Observations buttons).

---

## Before You Begin

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
    <<dynamic-eval ...>>
<</if>>
```

### How an activity station flows

1. **Patient** reads instructions in the main passage text.
2. **Patient** taps a choice button in the footer (`<<patient-choices>>`), if the activity has choices.
3. **Observer** taps one assessment button in the footer (`<<dynamic-eval>>`).
4. **Patient** sees a **Continue** / **Next** button in the footer (`<<patient-next>>`) and moves the team to the next passage.

The Patient cannot advance until the Observer has evaluated (`evalComplete` must be true).

**Important:** During multiplayer, use these macros and `SimApp.nextPassage` — do **not** use `<<goto>>` for shared navigation.

---

## `<<patient-choices>>`

**Who sees it:** Patient only  
**Where it appears:** Footer — “Your choice” section above the Next button  
**Requires:** Passage tagged `[simulation activity]`

### Purpose

Presents one or more choice buttons (e.g., water temperature, which errand to do next). When the Patient taps a button:

- Energy is adjusted (hidden from the Patient UI)
- A consequence message appears in the footer (green or red text)
- The Patient waits for the Observer to evaluate before the Next button unlocks

### Syntax

```
<<patient-choices "Section title"
  "Button label | energy | buttonColor | messageColor | Consequence message shown after click"
  "Another label | -2 | cold | red | You gasp from the cold water!"
>>
```

### Fields (pipe-separated, one row per button)

| # | Field | Description |
|---|--------|-------------|
| 1 | **Button label** | Text on the button (required) |
| 2 | **Energy change** | Number added to energy (e.g. `-4`, `-1`, `0`). Not shown to the Patient. |
| 3 | **Button color** | CSS theme for the button. Built-in themes: `green`, `red`, `blue`, `hot`, `warm`, `cold`. |
| 4 | **Message color** | `green` or `red` — color of the consequence text after the Patient clicks. |
| 5 | **Message** | Consequence text shown in the footer after the Patient clicks. |

**Shorthand (4 fields):** If you only provide 4 pipe-separated values, field 4 is treated as the **message** and the message color is auto-set from the energy sign (positive → green, negative → red).

```
"Warm Water | -1 | warm | The warm water is soothing."
```

**Empty message:** Leave field 5 blank to show “Waiting for your Observer to evaluate…” instead of a consequence line. Useful when the Observer’s eval supplies the Patient feedback (see `<<dynamic-eval>>` field 6).

### Example — Showering (3 choices)

```
<<patient-choices "Water temperature"
  "Hot Water | -4 | hot | red | All the steam from the hot water makes it hard to breathe!"
  "Warm Water | -1 | warm | green | The warm water is soothing and doesn't stress your lungs."
  "Cold Water | -2 | cold | red | The sudden shock of the cold water makes you gasp for air!"
>>
```

### Layout notes

- Choice buttons use the same **two-column footer grid** as Observer controls.
- If there is an **odd** number of choices, the last button is **centered** in the grid.

---

## `<<dynamic-eval>>`

**Who sees it:** Observer only  
**Where it appears:** Footer — “Activity Specific Observations” section  
**Requires:** Passage tagged `[simulation activity]`

### Purpose

Renders one or more assessment buttons for the current activity. When the Observer taps a button:

- Energy and points are updated
- An optional behavior counter is incremented (for debriefing data)
- `evalComplete` is set so the Patient’s Next button unlocks
- An optional message can be sent to the Patient’s footer (used heavily in the tutorial)

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
| 7 | **Patient message color** | *(Optional)* `green` or `red` for field 6 (defaults from energy sign) |

Energy and points are shown automatically as a subtitle under the button label (e.g. `-2 Energy · 1 Pts`).

### Example — Getting out of bed

```
<<dynamic-eval "Activity: Getting Out of Bed"
  "They sat and rested on the edge before standing | -1 | 1 | satAndRested | green"
  "They got straight out of bed without resting | -2 | 1 | rushed | red"
>>
```

### Layout notes

- Buttons use the same **two-column grid** and width as General Observations.
- A **single** eval button (or any odd count) is **centered** in the grid.
- Each Observer can only pick **one** option per activity; the footer then shows “Assessment Recorded.”

---

## `<<patient-next>>`

**Who sees it:** Patient only  
**Where it appears:** Footer — below choices / feedback  
**Requires:** Passage tagged `[simulation]` (and `[activity]` when paired with `<<patient-choices>>`)

### Purpose

Shows the Patient a **Next** / **Continue** button that:

- Waits for the Observer’s evaluation (unless the passage has no choices and no eval is required)
- Navigates the **entire team** to the target passage via `SimApp.nextPassage`
- Optionally **resets all game stats and the timer** before starting the real simulation

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
| 2 | **Target passage** | Exact Twine passage name (e.g. `Showering`, `Good_Morning_Mr._Holland`) |
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

---

## Full activity template

Copy this into a new passage and edit the tagged name, text, and macro lines.

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

---

## Quick reference

| Macro | Role | Footer section |
|-------|------|----------------|
| `<<patient-choices>>` | Patient | Choice buttons + consequence text |
| `<<dynamic-eval>>` | Observer | Activity Specific Observations |
| `<<patient-next>>` | Patient | Next / Continue button |

| Patient step | Observer step |
|--------------|---------------|
| Tap choice (if any) | Tap eval button |
| Wait for eval | — |
| Tap Next | Follows via sync |

---

## Tips & troubleshooting

- **Passage names are case-sensitive** — `Showering` and `showering` are different. Use underscores for spaces in names (e.g. `Good_Morning_Mr._Holland`).
- **Pipe character `|`** separates fields. If your message text needs a literal pipe, avoid it or rephrase — there is no escape character.
- **Energy is capped** at 15 and floored at 0. Reaching 0 energy triggers game over on normal `[simulation]` passages; `[briefing]` passages are exempt.
- **One eval per station** — design each `<<dynamic-eval>>` so the Observer picks the single best-matching option.
- **Test both roles** — open two browsers/devices, connect via Playroom, assign Patient and Observer, and walk through the station.
- **Republish** — after editing the `.twee` file, use Twine **Publish to File → index.html** before pushing to GitHub Pages.

---

*COPD Simulation 2.0 — Robin Parker, MSN, RN, PCCN*
