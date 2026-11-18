# English Training – Grade 7

Free browser-based English practice for a Grade 7 learner and a Samsung/Android tablet.

## Version 2.3 features

- 30-minute sessions on Monday, Wednesday, Friday and Sunday
- All seven areas in every session: Vocabulary, Grammar, Reading, Listening, Writing, Translation and Viewing
- 784 vocabulary entries across learned textbook vocabulary, additional textbook vocabulary, Grade 7 core vocabulary and extension vocabulary
- Schoolbook pages 206–213 are pre-enabled; additional pages 214–229 can be enabled one by one before a session. Once enabled, a page cannot be disabled. Vocabulary from newly enabled pages is included from the next session
- New textbook vocabulary is introduced progressively; difficult vocabulary is scheduled for later review
- An information button on each task opens a short explanation or learning hint
- Each learning area has up to three answer-check attempts; wrong sub-tasks are identified individually and solutions are revealed after the third unsuccessful check
- Hint use is recorded as support and excluded from the unassisted first-attempt score
- First-attempt performance and final corrected result are reported separately
- Exercise variants rotate independently across Grammar, Reading, Listening, Writing, Translation and Viewing. The pools contain eight task variants per area and nine Viewing scenes
- Incorrect first checks or help use schedule the affected area for review after three days; the saved task variant is prioritized on the next eligible training day
- Vocabulary is rotated through the set of enabled textbook pages with due vocabulary reviewed first
- Viewing uses a rotating pool of nine realistic photo scenes; Writing and Viewing include self-review checklists and are not presented as automatically AI-graded
- New sessions always run independently; the start page has no guided-session choice. Historical accompanied sessions remain excluded from the individual progress dashboard
- Answers are saved locally while a session is in progress; unfinished sessions can be resumed after reopening the browser
- PDF report via the tablet print dialog and detailed CSV export for Excel

## Privacy and storage

No paid service, AI API or server-side database is required. Answers, review queues and reports are saved in localStorage in the browser on the learner's tablet. They are not uploaded to GitHub. The same browser and device are required to retain local progress; clearing browser data can remove it. A PDF report or CSV export can be forwarded separately.

## Deployment

The static website is hosted on GitHub Pages. The deployment workflow is in `.github/workflows/pages.yml`.

## Viewing photo rotation

The Viewing exercise rotates through nine distinct everyday scenes (park, town walk, football, lake, kitchen, study, café, friends and seaside). A local browser record prevents a photo from reappearing until the scene pool has been used; the first photo of a new cycle is not the one used in the immediately preceding session. Photos are served from the Pexels CDN and photographer credits are shown beneath each image. Pexels states that its photos may be used for free on websites and that attribution is appreciated but not required.
