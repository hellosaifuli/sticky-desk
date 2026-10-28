# Sticky Desk

A sticky-note kanban board that feels like paper. Notes sit on a wooden desk in three columns (To do, Doing, Done) and you move them by hand.

## Use it

Open `index.html` in Safari on iPad or Mac. On iPad, tap Share, then **Add to Home Screen** to get it full screen.

- **Tap** a note to write on it. Apple Pencil Scribble works in the note.
- **Hold and drag** a note to another column, or onto the bin to throw it away.
- **Tap the pad** to tear off a new note.
- **Tap the camera inside a note** to photograph a real sticky note or whiteboard. The photo is taped onto a new note. In the claude.ai version, Claude also reads the handwriting into the note's text.
- **Projects** are folder tabs, each with its own paper colour. "All projects" shows everything together.
- **Today, Scheduled, Flagged** filter the board like Apple Reminders' smart lists. Search finds notes by their words, steps or project.
- **On each note:** due date (Today, TMR, a date; red when late), priority (`!` to `!!!`), a flag tab, and a repeat (daily, weekdays, weekly, monthly). Finishing a repeating note puts the next one in To do.
- **Flip** a note to write details and a checklist of steps on the back. The front shows progress like "2/4".
- **Doing** has a soft limit of 3 notes so you stay focused.
- **Background** lets you pick the desk: wood, cork, whiteboard, linen, green felt or chalkboard.
- **Prayer times for Dhaka** (Karachi method, Hanafi Asr) with the next prayer and a countdown. Turn on **Azan** and add your favourite azan recording; it plays at each prayer time while the page is open.
- **Daily Quran**: about one minute a day, in order, Arabic with Bangla meaning (Muhiuddin Khan). Tap "পড়া হয়েছে ✓" to move on.
- **News rail** along the bottom scrolls today's prayer times and Quran verses like a TV ticker. Tap it to open the full prayer times and reading.
- **Floating button** (bottom right) opens Search, Background, Prayer & Quran and Desk mode.
- **Search** opens full screen like iOS Spotlight: shortcuts for Today, Flagged and Scheduled, your projects, and results grouped by column as you type. On a keyboard, press ⌘K or Ctrl+K.
- **Desk mode** keeps the screen awake and shows the date and time, so an iPad on a stand works as a sticky-note display.

On the website, sign in with a **name and PIN** (a new board starts with PIN 1111; change it in Settings) and the same board syncs across your iPhone, iPad and Mac. Changes sync about every 20 seconds and whenever you open the app, and changes made offline are sent when you're back online. Without signing in, notes stay in that browser.

**Widget:** Settings → Set up widget gives you a script for the free Scriptable app. It shows your Doing and To do notes on the Home Screen, and the counts on the Lock Screen.

## More features

- **Smart typing**: write `PDF feedback tmr !! #beevo *` and the note sets its own date, priority, project and flag. Days (`today`, `tmr`, `friday`, `next week`, `in 3 days`), repeats (`every day`, `every weekday`, `weekly`, `monthly`), `!` to `!!!`, `*` for a flag, `#project`.
- **Templates** for new notes: Design review, Bug fix, Meeting prep, Weekly plan.
- **Ask Claude** (claude.ai version): break a note into steps, plan my day around the prayers, weekly review.
- **Focus timer**: 25 minutes on any note; it pauses itself before the next prayer and adds a tally to the note.
- **Done celebration**: paper confetti and a soft paper sound (turn sounds off in Settings).
- **Archive**: Done notes older than a week move to the Archive so the board stays clean.
- **Undo** anything with ⌘Z / Ctrl+Z, or the Undo button in messages.
- **Night desk**: wood that turns dark after Maghrib and light again at Fajr.
- **Ramadan mode** (auto from the Hijri calendar, or on/off): sehri and iftar countdown, and how many readings a day finish the Quran by Eid.
- **Jumu'ah**: on Fridays, Dhuhr shows as Jumu'ah, the rail reminds you, and the Quran card offers Surah Al-Kahf.
- **Quran streak**: days in a row you've read.
- **Backup**: save everything to a file and restore it from Settings.
- **Welcome tour** on first visit.

## Lock screen

A web page can't show on the iPad lock screen. That needs a native app with a WidgetKit widget, built in Xcode on a Mac.

## Credits

- Quran Arabic text: Tanzil Project (tanzil.net). Bangla translation: Muhiuddin Khan, via Tanzil. Data from [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api), stored in `q/`.
- Prayer times: [adhan](https://github.com/batoulapps/adhan-js) (MIT).
