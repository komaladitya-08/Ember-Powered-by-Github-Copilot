# AI chat and desktop companion benchmarks for Ember

Research accessed 4 November 2026. Sources below are opened official documentation, not hands-on testing of signed-in competitor apps. Availability varies by platform, account, and rollout. Recommendations are design inferences pending Ember inspection.

## Relevant documented patterns

| Product / surface | Documented behavior | Recommendation for Ember |
|---|---|---|
| Claude Desktop quick entry | A global shortcut opens a small composer; users can attach a screenshot or application window, dictate with live transcription, review, then explicitly send. Shortcuts can be customized or disabled; recent conversations are accessible. | Make Ask a complete lightweight interaction: immediate keyboard focus, visible context attachments, editable dictation, explicit Send, and recent threads. Ending dictation should not accidentally trigger app actions. [Claude quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac) |
| ChatGPT Classic macOS companion | A conversation can pop into a configurable companion window. Release notes document restored drafts, in-conversation search, stop-streaming shortcuts, and background completion alerts. The older app is now explicitly called ChatGPT Classic. | Treat Ask and Home as two presentations of one thread. Preserve draft, attachments, scroll location, and task state across surfaces. Provide discoverable keyboard controls and configurable quiet alerts. This is a historical native benchmark, not a claim about all current ChatGPT desktop installations. [macOS release notes](https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes) |
| Microsoft Copilot quick view | Windows shortcuts can open either the full app or smaller quick view; behavior is configurable. Wake-word access is opt-in. | Let people choose Ask versus Home for global access. Detect shortcut conflicts, offer tray/menu-bar access, and avoid depending solely on a cursor mascot. [Copilot Windows access](https://support.microsoft.com/en-au/microsoft-365-copilot/access-microsoft-365-copilot-on-windows) |
| Copilot screen sharing | Active sharing has a textual indicator; quick view also marks the shared content with a colored frame. Stop sharing differs from ending voice. | Distinguish microphone capture, screen/context sharing, and agent control. Give each an understandable stop action. A mascot animation or dot alone does not explain the active capability. [Copilot vision](https://support.microsoft.com/en-us/microsoft-365-copilot/use-vision-microsoft-365-copilot) |
| Claude computer use | Application access is permissioned, apps can be blocked, and tasks can be stopped. Supported macOS versions allow background-window work; full-screen takeover needs additional permission. | Show accessed app, access type, and current activity. Make handoff explicit; retain an available stop control. Request access contextually when needed. [Claude computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) |
| Claude unified chat/tasks rollout | Chat and Cowork merge into one conversation, with conversation-level autonomy settings and one recents list. Cloud continuation is distinguished from tasks needing the desktop app open. | Avoid requiring users to classify a request before stating intent. Show task status in the thread and accurately explain what continues after closing Ask, Home, or the app. [Claude unified experience](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) |
| ChatGPT saved-content search | Sidebar search retrieves existing account content; it is distinct from web search. Search can match titles and messages, with keyboard access on web. | Distinguish conversation search from web search. Prioritize reliable retrieval and resume before elaborate organization. [Saved-content search](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt) |
| ChatGPT web search | Answers can expose clickable citations and a Sources view; the help page warns that citation presence does not ensure correctness. | Connect citations to relevant claims and let users inspect evidence without losing conversational context. Avoid implying verified correctness merely because links exist. [Web search](https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt) |
| ChatGPT deep research | A reviewable plan, progress, interruption, and navigable report with sources and activity information support longer work. | Show the outcome and current step; allow interruption; keep detailed activity expandable. Do not substitute unexplained animation for progress evidence. [Deep research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) |
| Gemini conversation management | Users can search, pin, rename, and branch chats. Branches survive independently from the original. | Add dependable history search, meaningful names, pinning, and resume. Branching is a later enhancement unless revision exploration is central to Ember. [Gemini chats](https://support.google.com/gemini/answer/13666746?co=GENIE.Platform%3DDesktop&hl=en) |
| Gemini sources | Available sources can open in a side panel; not all responses have sources. | Preserve answer context while inspecting evidence. Distinguish source-backed material from general model output. [Gemini sources](https://support.google.com/gemini/answer/14143489?co=GENIE.Platform%3DWeb&hl=en) |
| Gemini files | File attachment is explicit, documented limits vary by type, and upload or analysis failures have recovery guidance. | Show attachment identity and upload/processing state; make failures actionable without discarding the prompt. [Gemini uploads](https://support.google.com/gemini/answer/14903178?hl=en) |
| Perplexity research | Search offers an automatic/default model choice and a distinct longer research option; source links and contextual follow-ups support investigation. Getting-started material demonstrates source inspection for selected answer text. | Provide a good default before requiring model/provider decisions. Associate evidence with claims and preserve follow-up context. [Pro Search](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search), [getting started](https://www.perplexity.ai/en-GB/hub/getting-started) |
| Claude artifacts | Reusable outputs open beside the conversation, can be edited/exported/found later, and selected text can target an edit. | Give substantial outputs a persistent result view with copy, export, and open actions. Start with readable documents/files/code rather than assuming a full canvas is required. [Claude artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) |

## Privacy and trust distinctions

Ember should distinguish history, memory, processing location, active capture, action authority, and retention. These are separate user expectations and should not be bundled into one ambiguous private switch.

ChatGPT's current temporary-chat documentation distinguishes history, personalization, memory creation, model training, and retention; temporary does not mean no retention. Claude distinguishes incognito history from enterprise retention and memory controls. Ember should state its actual behavior instead of inheriting a competitor label. [ChatGPT temporary chat](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt), [Claude chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

Claude's safety documentation distinguishes reading from changing data and recommends monitoring task behavior rather than expecting users to assess every command. A resulting design inference for Ember is to explain approvals in user language: what changes, where, and with what result, with technical detail available on demand. This does not establish that Claude implements this exact proposed approval card. [Claude task safety](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely)

## Recommended order for Ember

1. Continuity and recovery: shared thread across Ask/Home; drafts survive dismissal, failure, and restart; retry preserves edits and avoids duplicate external actions.
2. Visible capture/control: distinguish Listening, Transcribing, Thinking, Acting, Awaiting approval, and Finished; retain stop controls in compact/full surfaces.
3. Reviewable approvals: exact message/destination or affected files; action-specific buttons such as Send message and Cancel; a readable preview before commitment.
4. Desktop access: configurable shortcuts, tray access, reliable focus return, stable overlay placement, reduced mascot movement and a way to hide it.
5. Readable results/retrieval: selectable text, robust Markdown/code/tables, copy/export/open controls, chat search, resume.
6. Advanced features: branching, detailed model tuning, canvases, and elaborate automation organization after fundamentals.

## Acceptance tests inspired by the benchmarks

| Flow | Expected evidence |
|---|---|
| Ask → Home → Ask | Same thread and draft; attachments and active task preserved; no duplicate send. |
| Escape/click away | Predictable dismissal; preserved draft; focus returns to previous app. |
| Global shortcut | Works while Home is closed; conflicts explained; can change/disable shortcut. |
| Dictation | Visible editable transcript; Stop recording differs from Send; recovery from denied permission. |
| Active context | Shared window/screen is identifiable; sharing can stop without ending the thread. |
| Action approval | Exact destination and changes reviewable; safe keyboard focus; Cancel executes nothing. |
| Failure/restart | Prompt and partial output remain available; accurate task state; no duplicate completed external work on retry. |
| Background completion | Useful result/location available on return; notification honors preferences. |
| Long output | Stable scroll; usable code/table copy actions; sources preserve answer context. |
| History | Old conversations found/reopened; archive/delete consequences accurately explained. |

No competitor behavior establishes an Ember defect until verified against Ember. The strongest inspiration is quick access plus continuity, visible scope, and recoverable work.
