# Privacy

Updated September 20, 2026. Support and privacy contact: [leon.bjorklund@gmail.com](mailto:leon.bjorklund@gmail.com).

## On your device

Opening the popup reads the active tab's URL and the video's ID, duration, existing chapters, and ad state. Generating reads the video's title and transcript, picks chapter starts, and names them with Chrome's on-device Gemini Nano when that model is installed, or in code from the transcript alone when it is not. The chapter panel reads playback position and YouTube thumbnail URLs.

All of this stays in memory. Nothing is saved: no titles, transcripts, chapters, history, or preferences. Reloading or leaving the video removes the generated panel.

## Network

No backend, analytics, telemetry, accounts, API keys, or cloud AI. Nothing is sent to the developer or any external AI service, and nothing is sold or shared.

Chrome downloads its AI model only when you tick "Better titles with Chrome AI". YouTube still makes its normal video and transcript requests, and the chapter panel loads preview images from YouTube. Chrome and YouTube handle those under their own privacy policies.

## Permissions

`activeTab` gives temporary access to the tab where you invoke the extension. `scripting` lets it read the video's title and transcript and display chapters there. No persistent site access, no other tabs.

This use complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including Limited Use. No advertising, profiling, or unrelated purposes.

You choose when generation starts, and closing the popup cancels it. There is no saved data to delete.
