# Privacy

Updated September 29, 2026. Support and privacy contact: [leon.bjorklund@gmail.com](mailto:leon.bjorklund@gmail.com).

## On your device

Opening the popup reads the active tab's URL and the video's ID, duration, existing chapters, whether it has captions, and ad state. Generating reads the video's title and transcript, picks chapter starts, and names them with Chrome's on-device Gemini Nano when the model is available, or in code from the transcript alone when the model is unavailable or fails. The chapter panel reads playback position and YouTube thumbnail URLs.

All of this stays on your device. The generated chapter titles and start times are kept in the YouTube tab's session storage, so reloading the video shows them again. YouTube's in-page navigation away from the video deletes them. Full-page navigation, such as entering another URL in the address bar, can leave them saved until they are replaced or Chrome clears the tab's session storage. Nothing else is saved: no transcripts, history, or preferences.

## Network

No backend, analytics, telemetry, accounts, API keys, or cloud AI. Nothing is sent to the developer or any external AI service, and nothing is sold or shared.

Chrome downloads its AI model only when you turn on "Gemini Nano titles". The transcript comes from YouTube, through the same request YouTube's transcript panel makes or through that panel itself. YouTube still makes its normal video requests, and the chapter panel loads preview images from YouTube. Chrome and YouTube handle those under their own privacy policies.

## Permissions

`activeTab` gives temporary access to the tab where you invoke the extension. `scripting` lets it read the video's title and transcript and display chapters there. No persistent site access, no other tabs.

This use complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including Limited Use. No advertising, profiling, or unrelated purposes.

You choose when generation starts. Once started, it finishes even if you close the popup.
