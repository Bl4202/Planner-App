# Study Planner

Paste in your Canvas assignments and the planner estimates how long each one will take. It spreads that time across the days before each due date and tells you what to work on today. It has a built-in timer, and it learns how fast you actually work.

Everything runs locally and for free. Claude AI estimates are optional.

## Run it

Double-click `start.bat`, or:

```
npm install
npm start
```

Then open http://localhost:3000.

## Setup (one minute)

1. **Courses**: add your classes.
2. **Assignments → + Add assignment**: pick the course, the title and the due date, then paste the full instructions from Canvas. The estimate updates as you paste. If it looks wrong, type your own time over it. The planner learns from that, so you'll need to do this less as you go. Tick *Set the time myself* to add a custom assignment with your own time.
3. *(Optional)* **Settings → Time estimates**: pick **Claude AI** and paste an Anthropic API key, or pick **Gemini AI** and paste a Gemini API key (free from [Google AI Studio](https://aistudio.google.com/apikey)), to have AI estimate instead. If the AI call fails, the built-in estimate is used. You can also put the keys in a `.env` file as `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (see `.env.example`). Gemini uses `gemini-3.8-flash` unless you set `GEMINI_MODEL`.

## How it works

- **Estimating** (`server/estimator.js`, free): the type of work is guessed from keywords in the title, the instructions and the course name. The estimator then pulls out measurable details: word or page counts, number of problems, page ranges and chapters, number of sources, required replies, video length, slides, and flags like "group" or "show your work". Each is turned into minutes using the `RATES` table at the top of the file. The breakdown is shown so you can see where the number came from. Edit `RATES` if the numbers are consistently off.
- **Scheduling** (`server/scheduler.js`): your *total* work is spread evenly over your study days, not each assignment.
  - **Even pace.** The planner works out a daily pace that's as even as possible while everything still gets done *N* days early (Settings → finish early by, default 1 day) and under your daily max. If a lot is due soon, those days get a higher pace, and the days after drop back down. Light weeks get at least one 30-minute session a day, so small things get done early.
  - **Whole assignments, in due order.** Each day is filled with assignments, earliest due first, so you finish one before starting the next. Anything that needs an hour or less is done whole in one sitting. Bigger ones are split into 30–45 minute sessions.
  - **At risk.** If something can't fit before it's due, it gets flagged "at risk". Tune the session sizes with the constants at the top of the file.
- **Today**: shows how much is left today and what to work on, including each assignment's sessions and whether today finishes it. Assignments you finish today stay on the list, crossed out. Finishing early doesn't pull more work into today. Hover over an assignment and click **Start** to run the timer, which stays pinned under the top bar on every page. The timer survives page refreshes. **Stop & log** saves the time.
- **Learning** (`server/learning.js`): the planner learns from two things.
  - **Your corrections.** When you type your own time over an estimate, it records *your time ÷ estimate*. It does this right away, before you've done the work.
  - **Finished work.** When you mark an assignment done, you enter the real total time, and it records *actual ÷ estimate*. This replaces your correction for that assignment.

  These ratios are averaged for each type of work (writing, reading, problem sets…), with recent ones counting more. New estimates are multiplied by the average, and the form shows the adjusted number. A type needs 2 corrected or finished assignments before its adjustment applies. A per-course factor stacks on top (for example, "this class always takes me longer"). A time you type is used as-is for that assignment. Changing the **Type** re-estimates with that type's formula. See the **Insights** tab.

Your data is stored in `data/db.json`. The app only listens on localhost.

## Tests

```
npm test
```
