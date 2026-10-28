# Sticky Desk

A sticky-note kanban board that feels like paper. Notes sit on a wooden desk in three columns (To do, Doing, Done) and you move them by hand.

## Use it

Open `index.html` in Safari on iPad or Mac. On iPad, tap Share, then **Add to Home Screen** to get it full screen.

- **Tap** a note to write on it. Apple Pencil Scribble works in the note.
- **Hold and drag** a note to another column, or onto the bin to throw it away.
- **Tap the pad** to tear off a new note.
- **Tap the camera** to photograph a real sticky note or whiteboard. The photo is taped onto a new note. In the claude.ai version, Claude also reads the handwriting into the note's text.
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

When opened as a standalone file, notes are saved in that browser.

## Lock screen

A web page can't show on the iPad lock screen. That needs a native app with a WidgetKit widget, built in Xcode on a Mac.

## Credits

- Quran Arabic text: Tanzil Project (tanzil.net). Bangla translation: Muhiuddin Khan, via Tanzil. Data from [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api), stored in `q/`.
- Prayer times: [adhan](https://github.com/batoulapps/adhan-js) (MIT).
