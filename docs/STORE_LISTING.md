# Chrome Web Store listing

## Name (max 75)
Copy for AI – Solve any question on the page

## Summary (max 132)
Solves the questions on the open page (text or screenshot) in a side panel, answer only or with steps. Copies pages as Markdown too.

## Category
Productivity → Education

## Language
English

## Description
Stuck on a question? Click once and get the answer.

Copy for AI reads the page you have open – a quiz, a worksheet, an exercise sheet, a PDF, even a photo of a problem – understands the questions on it and shows you the answers in a side panel that stays open next to the page. Turn on "Answer only" for just the result, or click "Explain" when you want the steps.

HOW IT WORKS
• Open the page with the question(s) and click the Copy for AI icon (or press Alt+Shift+S)
• Click "Solve this page" – the answer streams in as it is written
• Ask follow-ups: "why?", "explain #3", "in Arabic" – it remembers the page and the conversation
• Reload or scroll all you want: the panel and your answers stay where they are
• Optional: select one question first, or type "only question 3", to focus on exactly that

WHEN THE PAGE CAN'T BE READ
Scanned PDFs, images, diagrams, math rendered as pictures, locked quiz platforms… when there is no readable text, Copy for AI analyses a screenshot of the visible page instead (you can also send the screenshot every time for extra accuracy on pages with figures).

FEATURES
✓ Solves multiple choice, short answer, math, physics, chemistry, programming, grammar and reading questions
✓ "Answer only" mode: A / 42 / true – nothing else
✓ "Explain" mode: step-by-step reasoning when you need to learn the method
✓ Screenshot understanding for PDFs, images and diagrams
✓ Answers in the same language as the question
✓ Copy the answer with one click
✓ Powered by Google Gemini – no API key or account needed
✓ Bonus: copy any page, selection or all tabs as clean Markdown for ChatGPT / Claude (token counter + prompt templates)

FREE
• 5 answers per day (text + screenshot)

PRO – $4.99 / month, cancel anytime
★ Unlimited answers, every day
★ All tabs → one Markdown document
★ Unlimited custom prompt templates
★ Copy history
★ All future Pro features

PRIVACY
Nothing is sent anywhere until you click Solve. Then the page text (and an optional screenshot of the visible area) is sent to our server and processed by Google Gemini to produce the answer; it is not stored. Copying as Markdown stays 100% in your browser. No account, no analytics.

## Single purpose description (for review)
Helps the user understand and answer the questions on the current web page: on user request it reads the page (or a screenshot of it when the text is not readable), sends it to our server for AI analysis and shows the answer. Secondary: copies the page as Markdown to the clipboard.

## Permission justifications
- activeTab: read the current page's content and capture a screenshot of the visible tab when the user clicks "Solve" or "Copy".
- scripting: inject the extraction script into the active tab on user action, and (Agent mode) the fill script that writes the answers into the page's answer fields and shows them next to each question. It never submits forms.
- storage: save user preferences, templates, license key, a random device id for the free daily quota, and (Pro) local copy history.
- contextMenus: provide "Solve with Copy for AI" / "Solve whole lesson (Agent)" / "Copy page for AI" / "Copy selection for AI" right-click items.
- clipboardWrite: place the answer or the generated Markdown on the clipboard.
- offscreen: write to the clipboard from the keyboard shortcut / context menu (service workers have no clipboard access).
- notifications: tell the user when the background "Solve whole lesson" job finishes or fails (the side panel may be closed), and confirm a successful copy when triggered via shortcut/context menu (no UI visible).
- sidePanel: the solver UI lives in Chrome's side panel so it stays open while the user reads, scrolls or reloads the page.
- <all_urls> (optional, requested at runtime on first Solve): lets the side panel keep reading the page after a reload or navigation without another toolbar click. Declining keeps the extension working through activeTab.
- tabs + <all_urls> (optional, requested at runtime): the Pro "All tabs" feature needs to enumerate and read the other open tabs. Only requested when the user first uses that feature.
- Remote code: none. The extension only exchanges JSON with https://copyforai-license.onrender.com.

## Data usage disclosure (Privacy practices tab)
- Collects: **Website content** (page text and screenshot, sent only when the user clicks Solve, to generate the answer; not stored). **Authentication information** (license key). Nothing else.
- Tick: "I do not sell or transfer user data…", "I do not use or transfer user data for purposes unrelated…", "I do not use or transfer user data to determine creditworthiness…".
- Privacy policy URL: https://copyforai.onrender.com/privacy.html

## Screenshots needed (1280×800 or 640×400)
1. Side panel next to a multiple-choice quiz page showing "Answer only" result (e.g. "1. B  2. D  3. A")
2. Side panel with a follow-up "why?" and the "Explain" result showing worked steps for a math problem
3. Screenshot mode on a PDF/image worksheet with the answer
4. Options → License page showing Pro
5. Copy as Markdown tools (secondary feature)

## Promo tile (440×280) text
"Any question on the page → the answer. One click."
