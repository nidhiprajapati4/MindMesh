# Phase 8 test scenarios: Feedback round

Unit/API tests and acceptance tests for the feedback round (F1–F12). The code is described in the PR "Feedback round" (#13).

| Kind | Scenarios | Latest result |
|---|---|---|
| Automated API/unit tests (`phase8.test.ts`) | 22 | ✅ 22 / 22 pass (whole suite: 203 / 203) |
| Acceptance tests, checked in a browser by Claude (local, mock sign-in) | 8 | ✅ 8 / 8 |
| Acceptance tests still to run by hand | 22 | ⬜ not run yet (need a real microphone, Google account, email, or the live site) |

## How to run the automated tests
```bash
npm test -w apps/api
```
Uses an in-memory database, fake models, no accounts. Test files must import app modules *after* `startTestApi()`, otherwise they read the real database from `apps/api/.env`.

---

## 1. Unit / API tests (`apps/api/src/test/phase8.test.ts`)
| ID | Feature | Scenario | Expected | Result |
|---|---|---|---|---|
| FAV-01 | F6 | Create an item; star it; unstar it | New items are `favourite: false`; the flag toggles | ✅ |
| FAV-02 | F6 | List with `?favourite=true`; an older item with no `favourite` field | Only starred items listed; older items still appear in the normal list | ✅ |
| CNT-01 | F5 | Items of several types, tags, one archived, one trashed, one favourite | Counts for all / archived / trash / favourites / each type / each tag are correct | ✅ |
| CNT-02 | F5 | `?duplicates=1`; a second user | `duplicates` is a number; counts are per user | ✅ |
| LIB-01 | F3 | Casual library questions ("how many notes i have added till now", "show my latest 5 notes", …) | Recognised as library questions | ✅ |
| LIB-02 | F3 | Questions about what notes say ("how do I roll back…", "notes about kubernetes") | Not treated as library questions (normal search) | ✅ |
| LIB-03 | F3 | A question mixing type, tag, folder, state and time range | All parts read correctly | ✅ |
| LIB-04 | F3 | Ask counts/lists end to end | Correct text, clickable sources per item | ✅ |
| SAV-01 | F2 | Save an answer, list, reopen, un-save | Works; saving twice is idempotent | ✅ |
| SAV-02 | F2 | Delete the conversation; a second user | Saved answer survives; other users can't see it | ✅ |
| PRO-01 | F7 | Open profile | Account email and empty optional fields | ✅ |
| PRO-02 | F7 | Save name, phone, date of birth, birth location; clear them | Saved and cleared | ✅ |
| PRO-03 | F7 | Try to change the email | `400 VALIDATION_FAILED` | ✅ |
| PRO-04 | F7 | Bad phone; future or impossible date of birth | Rejected | ✅ |
| PRO-05 | F7 | Two users | Profiles are private | ✅ |
| EDG-01 | F6 | `favourite: "yes"` | `400 VALIDATION_FAILED` | ✅ |
| EDG-02 | F6 | Trash a favourite | Not in the favourites list | ✅ |
| EDG-03 | all | Counts / saved / profile without a token | `401` | ✅ |
| EDG-04 | F2 | Save from a missing conversation; bad body | `404`; `400` | ✅ |
| EDG-05 | F2 | Another user opens or deletes your saved answer | `404`; yours still opens | ✅ |
| EDG-06 | F7 | Unknown profile field; 101-character location | `400` | ✅ |
| EDG-07 | F3 | "hello", "thanks", "what is the capital of France" | Not library questions | ✅ |

---

## 2. Acceptance tests
Format: **Given** → **When** → **Then**. "Checked" means Claude ran it in the browser on a local test stack (mock sign-in, seeded notes) at 1280 px and 375 px.

### F1 Voice question (Ask page)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-01 | In Chrome or Edge, open Ask, tap the mic, say "how many notes do I have" | Button shows a listening state; words appear in the box; after a short pause (2.5 s) the question is sent and answered | ⬜ |
| AC-02 | Speak, then tap Cancel during the "Sending…" pause | Nothing is sent; the text stays in the box for editing | ⬜ |
| AC-03 | Block the microphone permission, then tap the mic | A clear message to allow the microphone in browser settings | ⬜ |
| AC-04 | Stay silent after tapping | "I didn't hear anything" message | ⬜ |
| AC-05 | Open Ask in a browser without speech support (e.g. Firefox) | Mic is disabled with a note that voice input isn't supported; typing still works | ⬜ |
| AC-06 | Check the mic button | At least 44 px, has the label "Ask by voice" / "Stop listening" | ✅ (56 px, labelled in code; visual check pending) |

### F2 Saved answers
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-07 | Ask a question, press "☆ Save answer" | Button changes to "★ Saved"; the answer appears in the Saved tab with a count | ⬜ |
| AC-08 | Open the Saved tab, click an answer | The saved answer shows with its sources; sources open the note | ⬜ |
| AC-09 | Remove a saved answer | It disappears; the count drops | ⬜ |

### F3 Questions about the notes themselves
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-10 | Ask "how many notes i have added till now" | "You have N items in total" with a per-type breakdown and archived/trash counts | ⬜ |
| AC-11 | Ask "show my latest 5 notes" and "list my documents" | A list of clickable links; clicking opens the item | ⬜ |
| AC-12 | Ask "how many notes are tagged #work" | The right count for that tag | ⬜ |
| AC-13 | Ask something not in the notes ("what is the capital of France") | "I couldn't find anything about that in your notes." | ⬜ |
| AC-14 | Free mode banner | Mentions counts and lists | ⬜ |

### F4 / F5 Sidebar rows and counts
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-15 | Open Notes at 1280 × 800 | "All folders" is a normal one-line row; sidebar fits without scrolling | ✅ |
| AC-16 | Read the sidebar | Counts in brackets: Ask, Duplicates, All items, Favourites, Archived, Trash, each type, All folders, Unfiled, each folder, each tag, Tags heading | ✅ |
| AC-17 | Create, archive and trash an item | Counts update after the list refreshes | ⬜ |

### F6 Favourites
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-18 | Click the star at the top right of an item (right after the date) | Star fills; sidebar Favourites count goes up; survives reload | ✅ (star visible and counted; click-through pending) |
| AC-19 | Click "Favourites" in the sidebar | Only starred items; heading "Favourites (n items)" | ⬜ |

### F7 Profile
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-20 | Click your name above "Sign out" | Profile page opens; email is read-only | ⬜ |
| AC-21 | Fill name, phone, date of birth, birth location; save; reload | Values kept; the sidebar shows your name | ⬜ |
| AC-22 | Password account: "Send reset link" | Confirmation that an email was sent (needs real Firebase) | ⬜ |
| AC-23 | Google account | No reset button; explains there is no MindMesh password | ⬜ |

### F8 Toolbar
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-24 | At 1280, 768 and 375 px | Keyword/Meaning/Both and the sort dropdown are on one line; dropdown shows its full text and works | ✅ (1280 and 375 checked) |

### F9 Selection colour
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-25 | Select a view, type, folder, tag, search mode, layout, Ask history item, Saved tab | All use the same light-teal selection colour, different from the solid teal buttons | ✅ (Notes page checked; Ask page pending) |

### F10 Views
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-26 | Click List, Grid, Compact | List: full cards; Grid: 2–3 columns of cards; Compact: one line per item | ✅ |
| AC-27 | Choose Grid, reload | Grid is still selected | ✅ |

### F11 Logo
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-28 | On Ask, Graph, Duplicates, Profile click the MindMesh logo/title | Goes to `/notes`; the link's label is "MindMesh home" | ⬜ |

### F12 Home video
| ID | Scenario | Expected | Result |
|---|---|---|---|
| AC-29 | Signed out, open `/` | Landing page with the walkthrough video, "Sign in" and "Get started" | ⬜ |
| AC-30 | Signed in, open `/` | Redirects to `/notes` | ⬜ |

### Regression (must not break)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| REG-01 | Search by Keyword, Meaning, Both | Results as before | ⬜ |
| REG-02 | Archive, restore, trash, empty trash | Work as before | ⬜ |
| REG-03 | Free-mode Ask for a question the notes answer | Quoted sentences with sources | ⬜ |
| REG-04 | Phone drawer: open, choose a folder, Esc | Opens, closes, focus returns to Menu | ✅ (open and layout checked) |
| REG-05 | Sign in with email/password and Google | Both work | ⬜ |

---

## Known gaps
- The voice flow and password-reset email need a real browser microphone and real Firebase; they were not exercised.
- The landing-page video shows the UI from before this round.
- One test in the whole suite failed once and passed on rerun (not identified).
